/**
 * Lotuses'Memory 核心逻辑（纯 Node，不依赖 dsh 运行时，可独立单测）。
 *
 * 负责：记忆档案读写/截断/压缩、会话 ID 解析、从会话文件里找最近发言人。
 * 插件壳（index.js）只负责把这里的东西接到 systemPrompt 与工具注册上。
 * @module dsh-lotuses-memory/core
 */
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';


/** 档案读取缓存：路径 → { mtimeMs, text }。 */
const cache = new Map();

/** 会话文件解析缓存：路径 → { mtimeMs, speaker }。 */
const speakerCache = new Map();
/**
 * 每个会话「上次成功解析出来的发言人」。
 *
 * 为什么需要它：插件在组装请求时读会话文件，而那条 user/message 往往还没落盘
 * （同一轮里先投递、后组装），当场解析会得到 undefined。此时退回上一轮记住的人 ——
 * 比直接丢掉个人档案好，只有全新会话的第一轮才会真的没有。
 */
const lastKnownSpeaker = new Map();

/**
 * 解析记忆库根目录。
 * @param config - 插件配置。
 * @returns 绝对或相对路径。
 */
export function memoryRoot(config) {
    const dir = typeof config.memoryDir === 'string' ? config.memoryDir.trim() : '';
    if (dir !== '')
        return dir.replace(/[\\/]+$/, '');
    return path.resolve('Memory');
}

/**
 * 解析会话根目录。
 * @param config - 插件配置。
 * @returns 目录路径。
 */
function sessionsRoot(config) {
    const dir = typeof config.sessionsDir === 'string' ? config.sessionsDir.trim() : '';
    if (dir !== '')
        return dir.replace(/[\\/]+$/, '');
    const home = process.env.DSH_HOME ?? path.join(process.env.HOME ?? process.env.USERPROFILE ?? '', '.dsh');
    return path.join(home, 'sessions');
}

/**
 * 读一份档案（按 mtime 缓存）。
 * @param root - 记忆库根目录。
 * @param folder - people / groups。
 * @param key - QQ 号或群号。
 * @returns 文本或 null。
 */
export function readDoc(root, folder, key) {
    if (typeof key !== 'string' || key === '')
        return null;
    const full = path.join(root, folder, key + '.md');
    try {
        const mtime = fs.statSync(full).mtimeMs;
        const hit = cache.get(full);
        if (hit !== undefined && hit.mtimeMs === mtime)
            return hit.text;
        const text = fs.readFileSync(full, 'utf8');
        cache.set(full, { mtimeMs: mtime, text });
        return text;
    }
    catch {
        return null;
    }
}

/**
 * 截断到指定长度（按行切）。
 * @param text - 原文。
 * @param max - 上限。
 * @returns 截断后的文本。
 */
function trim(text, max) {
    if (text.length <= max)
        return text;
    let cut = text.slice(0, max);
    const nl = cut.lastIndexOf('\n');
    if (nl > max * 0.6)
        cut = cut.slice(0, nl);
    return cut + '\n…（档案还有更多，需要细节可调 memory_recall）';
}

/**
 * 从会话 ID 解析聊天对象。
 *
 * 约定（QQ 通道的会话命名）：`onebot-group-<群号>[-后缀]` / `onebot-private-<QQ>[-后缀]`。
 * 其他通道解析不出来时返回 null，此时只注入"全局记忆"（不注入个人档案）。
 * @param sessionId - 会话 id。
 * @returns `{ kind, target }` 或 null。
 */
export function chatOfSession(sessionId) {
    if (typeof sessionId !== 'string')
        return null;
    const m = /^onebot-(group|private)-(\d{5,12})/.exec(sessionId);
    if (m === null)
        return null;
    return { kind: m[1], target: m[2] };
}

/**
 * 解压 zstd 多帧并返回 JSONL 事件数组。
 * @param file - 会话文件路径。
 * @returns 事件数组（解析失败的跳过）。
 */
function readSessionEvents(file) {
    const buf = fs.readFileSync(file);
    const magic = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);
    const offsets = [];
    let i = 0;
    while ((i = buf.indexOf(magic, i)) !== -1) {
        offsets.push(i);
        i += 4;
    }
    offsets.push(buf.length);
    const chunks = [];
    for (let k = 0; k < offsets.length - 1; k++) {
        try {
            chunks.push(zlib.zstdDecompressSync(buf.subarray(offsets[k], offsets[k + 1])).toString('utf8'));
        }
        catch { /* 跳过坏帧 */ }
    }
    const events = [];
    for (const line of chunks.join('').split('\n')) {
        if (line === '')
            continue;
        try {
            events.push(JSON.parse(line));
        }
        catch { /* 跳过坏行 */ }
    }
    return events;
}

/**
 * 找出某个会话最近一条用户消息的发送者 QQ。
 *
 * 为什么读文件而不是订阅事件：这样插件不依赖任何通道插件，也不碰宿主内部状态。
 * 从消息正文的 `[hh:mm 昵称(QQ)]` 前缀解析；解析不到就返回 undefined（只注入群档案）。
 * @param config - 插件配置。
 * @param sessionId - 会话 id。
 * @returns QQ 号或 undefined。
 */
export function lastSpeaker(config, sessionId) {
    if (typeof sessionId !== 'string' || sessionId === '')
        return undefined;
    const root = sessionsRoot(config);
    let dir = null;
    try {
        for (const workspace of fs.readdirSync(root)) {
            const candidate = path.join(root, workspace, sessionId);
            if (fs.existsSync(candidate)) {
                dir = candidate;
                break;
            }
        }
    }
    catch {
        return lastKnownSpeaker.get(sessionId);
    }
    if (dir === null)
        return lastKnownSpeaker.get(sessionId);
    const file = path.join(dir, 'session.v4.jsonl.zstd');
    try {
        const mtime = fs.statSync(file).mtimeMs;
        const hit = speakerCache.get(file);
        if (hit !== undefined && hit.mtimeMs === mtime) {
            if (hit.speaker !== undefined)
                lastKnownSpeaker.set(sessionId, hit.speaker);
            return hit.speaker ?? lastKnownSpeaker.get(sessionId);
        }
        const events = readSessionEvents(file);
        let found;
        for (let k = events.length - 1; k >= 0; k--) {
            const e = events[k];
            if (e?.type !== 'user/message')
                continue;
            const text = (e.data?.content ?? []).map((b) => (typeof b.text === 'string' ? b.text : '')).join('');
            // `[hh:mm 昵称(QQ)]` 或 `[hh:mm 昵称(QQ，账号昵称:xx)]`
            const m = /\[\d{1,2}:\d{2}\s[^\]]*?\((\d{5,12})[)\]]/.exec(text);
            if (m !== null) {
                found = m[1];
                break;
            }
        }
        speakerCache.set(file, { mtimeMs: mtime, speaker: found });
        if (found !== undefined) {
            lastKnownSpeaker.set(sessionId, found);
            return found;
        }
        // 这一轮的 user/message 可能还没落盘 → 退回上一轮记住的人
        return lastKnownSpeaker.get(sessionId);
    }
    catch {
        return lastKnownSpeaker.get(sessionId);
    }
}

/**
 * 组装注入文本。
 * @param root - 记忆库根目录。
 * @param opts - `{ personId, groupId }`。
 * @param config - 插件配置（取上限）。
 * @returns 注入文本（空串表示没有可注入的内容）。
 */
export function buildHint(root, opts, config) {
    const parts = [];
    if (typeof opts.personId === 'string' && opts.personId !== '') {
        const person = readDoc(root, 'people', opts.personId);
        if (person !== null && person.trim() !== '')
            parts.push('[记忆·这个人]\n' + trim(person, Number(config.maxPersonChars ?? 900)));
        else
            parts.push('[记忆] QQ ' + opts.personId + ' 是第一次见的新面孔，可以自然认识一下。');
    }
    if (typeof opts.groupId === 'string' && opts.groupId !== '') {
        const group = readDoc(root, 'groups', opts.groupId);
        if (group !== null && group.trim() !== '')
            parts.push('[记忆·这个群]\n' + trim(group, Number(config.maxGroupChars ?? 600)));
    }
    if (parts.length === 0)
        return '';
    return parts.join('\n') + '\n（以上是可信的长期记忆，自然运用即可；不要把这些档案原文念给别人听）\n';
}

/**
 * 追加一条事实到档案（不存在就建）。
 * @param root - 记忆库根目录。
 * @param kind - person / group。
 * @param key - QQ 号或群号。
 * @param text - 要记的内容。
 * @returns 写入的文件路径。
 */
export function noteFact(root, kind, key, text) {
    const folder = kind === 'group' ? 'groups' : 'people';
    fs.mkdirSync(path.join(root, folder), { recursive: true });
    const full = path.join(root, folder, key + '.md');
    const now = new Date();
    const pad = (n) => String(n).padStart(2, '0');
    const stamp = now.getFullYear() + '-' + pad(now.getMonth() + 1) + '-' + pad(now.getDate())
        + ' ' + pad(now.getHours()) + ':' + pad(now.getMinutes());
    const line = '- ' + stamp + '｜' + String(text).trim().replace(/\n+/g, ' ');
    if (!fs.existsSync(full))
        fs.writeFileSync(full, (kind === 'group' ? '# 群 ' : '# QQ ') + key + '\n\n## 记录\n\n', 'utf8');
    fs.appendFileSync(full, line + '\n', 'utf8');
    cache.delete(full);
    try {
        compactIfNeeded(root, kind, key);
    }
    catch { /* 压缩失败不影响写入 */ }
    return full;
}

/** 档案超过该长度就折叠旧记录。 */
export const COMPACT_THRESHOLD = 4000;
/** 折叠后保留的最近记录条数。 */
export const COMPACT_KEEP = 40;

/**
 * 档案自动压缩：保留头部与最近 N 条记录，更早的折叠成一行计数。
 * @param root - 记忆库根目录。
 * @param kind - person / group。
 * @param key - QQ 号或群号。
 * @returns 是否发生折叠。
 */
export function compactIfNeeded(root, kind, key) {
    const folder = kind === 'group' ? 'groups' : 'people';
    const full = path.join(root, folder, key + '.md');
    if (!fs.existsSync(full))
        return false;
    const text = fs.readFileSync(full, 'utf8');
    if (text.length <= COMPACT_THRESHOLD)
        return false;
    const at = text.indexOf('## 记录');
    if (at < 0)
        return false;
    const head = text.slice(0, at) + '## 记录\n\n';
    const lines = text.slice(at).split('\n');
    const recordIdx = [];
    for (let i = 0; i < lines.length; i++) {
        if (lines[i].startsWith('- ') && !lines[i].startsWith('- （更早的'))
            recordIdx.push(i);
    }
    if (recordIdx.length <= COMPACT_KEEP)
        return false;
    let prevFolded = 0;
    for (const l of lines) {
        const m = /^- （更早的 (\d+) 条记录已折叠/.exec(l);
        if (m !== null) {
            prevFolded = Number(m[1]) || 0;
            break;
        }
    }
    const folded = recordIdx.length - COMPACT_KEEP;
    const keepFrom = recordIdx[recordIdx.length - COMPACT_KEEP];
    const rest = lines.slice(keepFrom).filter((l) => !/^- （更早的 \d+ 条记录已折叠/.test(l));
    fs.writeFileSync(full, head + '- （更早的 ' + (folded + prevFolded) + ' 条记录已折叠；如需细节可翻会话历史）\n' + rest.join('\n'), 'utf8');
    cache.delete(full);
    return true;
}
