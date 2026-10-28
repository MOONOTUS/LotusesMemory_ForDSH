/**
 * Lotuses'Memory（dsh-lotuses-memory）— 跨会话长期记忆（独立插件）
 *
 * 只做三件事，逻辑都在 core.js 里：
 *  1. 用 systemPrompt.context 每轮注入「这个人 / 这个群」的档案摘要
 *  2. 注册 memory_note（写事实）与 memory_recall（翻全文）
 *  3. 写档案时自动压缩（core.noteFact 内部完成）
 *
 * 与聊天通道完全解耦：从会话 ID 解析聊天对象、从会话文件解析发言人，
 * 不依赖任何通道插件，也不改用户消息正文。
 * @module dsh-lotuses-memory
 */
import { defineTool } from '@deepseek-ai/dsh-tools';
import { z } from 'zod';
import {
    buildHint,
    chatOfSession,
    ensureSeenPerson,
    lastSpeaker,
    memoryRoot,
    noteFact,
    readDoc,
} from './core.js';

export { compactIfNeeded, chatOfSession, lastSpeaker, buildHint, noteFact, ensureSeenPerson } from './core.js';
export { COMPACT_KEEP, COMPACT_THRESHOLD } from './core.js';

/** Cordis 插件名。 */
export const name = 'lotuses-memory';

/** 依赖的服务：系统提示组装 + 工具注册。 */
export const inject = ['systemPrompt', 'tools'];

/** 配置 schema（cordis 会对它调用 .validate，必须用 zod/schemastery 这类 schema 对象，不能是普通 JSON）。 */
export const Config = z.object({
    memoryDir: z.string().default('').describe('记忆库目录；留空则用 <工作目录>/Memory'),
    sessionsDir: z.string().default('').describe('会话文件根目录；留空则用 <DSH_HOME>/sessions'),
    maxPersonChars: z.number().default(900).describe('单个人物档案注入上限（字符）'),
    maxGroupChars: z.number().default(600).describe('单个群档案注入上限（字符）'),
    injectOrder: z.number().default(2500).describe('注入在系统提示里的排序位置'),
});
/**
 * 插件入口。
 * @param ctx - cordis 插件上下文。
 * @param rawConfig - 插件配置。
 */
export function apply(ctx, rawConfig) {
    const config = { ...rawConfig };
    const root = memoryRoot(config);
    console.log('[lotuses-memory] 已加载：记忆库 ' + root);

    // ① 每轮请求自动注入
    ctx.effect(() => ctx.systemPrompt.context({
        name: 'memory:hint',
        order: Number(config.injectOrder ?? 2500),
        interpolate: false,
        text: (context) => {
            try {
                const sessionId = context?.agent?.session?.id;
                const chat = chatOfSession(sessionId);
                const speaker = lastSpeaker(config, sessionId);
                // 说过话的人先落一份薄档案 —— 不指望模型每次都记得自己调 memory_note
                if (speaker !== undefined)
                    ensureSeenPerson(root, speaker, chat?.kind === 'group' ? chat.target : undefined);
                const hint = buildHint(root, {
                    personId: speaker,
                    groupId: chat?.kind === 'group' ? chat.target : undefined,
                }, config);
                console.log('[lotuses-memory] 注入 session=' + String(sessionId)
                    + ' chat=' + JSON.stringify(chat)
                    + ' speaker=' + String(speaker)
                    + ' 长度=' + hint.length
                    + ' contextKeys=' + Object.keys(context ?? {}).join(','));
                return hint;
            }
            catch (error) {
                console.log('[lotuses-memory] 注入失败: ' + String(error && error.message));
                return '';
            }
        },
    }), 'dsh-memory.inject');

    // ② 工具：写记忆
    ctx.effect(() => ctx.tools.register(defineTool({
        name: 'memory_note',
        description: '把值得长期记住的事实写进记忆库（跨会话共享）。'
            + '\n适合记：这个人是谁 / 喜欢什么 / 说过什么承诺、这个群是干什么的 / 有哪些常驻成员、自己的重要经历。'
            + '\n不要记：一次性闲聊、临时状态，以及密码 / 密钥 / 住址这类敏感信息。'
            + '\n一句一条，写清「谁 / 什么事」，不要抄大段原话。',
        parameters: {
            kind: { type: 'string', description: 'person=记人，group=记群' },
            key: { type: 'string', description: 'QQ 号（记人）或群号（记群）；省略则按当前会话推断' },
            text: { type: 'string', description: '要记的事实（一句话）' },
        },
        output: {
            schema: { type: 'json' },
            render: (_args, value) => [{
                type: 'text',
                text: value !== null && typeof value === 'object' && value.ok === true
                    ? '(记下了：' + value.kind + ' ' + value.key + ')'
                    : '(没记成)',
            }],
        },
        isConcurrencySafe: () => true,
        execute: async (args, exec) => {
            const kind = args.kind === 'group' ? 'group' : 'person';
            const text = String(args.text ?? '').trim();
            let key = String(args.key ?? '').trim().replace(/\D/g, '');
            if (key === '') {
                const sessionId = exec?.agent?.session?.id;
                const chat = chatOfSession(sessionId);
                if (kind === 'group')
                    key = chat?.kind === 'group' ? chat.target : '';
                else
                    key = lastSpeaker(config, sessionId) ?? '';
            }
            if (key === '' || text === '')
                throw new Error('memory_note: 缺少 key 或 text');
            noteFact(root, kind, key, text);
            return { ok: true, kind, key };
        },
    })), 'dsh-memory.note');

    // ③ 工具：翻细节
    ctx.effect(() => ctx.tools.register(defineTool({
        name: 'memory_recall',
        description: '读一份记忆档案的全文（人物或群）。需要了解某人/某群的完整记录时用。',
        parameters: {
            kind: { type: 'string', description: 'person=人，group=群' },
            key: { type: 'string', description: 'QQ 号或群号' },
        },
        output: {
            schema: { type: 'json' },
            render: (_args, value) => [{
                type: 'text',
                text: typeof value?.text === 'string' && value.text !== '' ? value.text : '(没有找到这份档案)',
            }],
        },
        isConcurrencySafe: () => true,
        execute: async (args, exec) => {
            const kind = args.kind === 'group' ? 'group' : 'person';
            const key = String(args.key ?? '').trim().replace(/\D/g, '');
            if (key === '')
                throw new Error('memory_recall: 缺少 key');
            const text = readDoc(root, kind === 'group' ? 'groups' : 'people', key);
            return { text: text ?? '' };
        },
    })), 'dsh-memory.recall');
}