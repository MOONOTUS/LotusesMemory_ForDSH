# Lotuses'Memory

跨会话长期记忆插件，给 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（dsh）用。

对话型 agent 通常"每个群/每个线程一个 session"，换个地方就忘了之前认识谁。
这个插件把"认识的人、待过的群、发生过的事"存成普通 Markdown 档案，**每轮请求自动注入**，
并提供两个工具让模型自己读写。

## 特性

- **档案是普通文件**：`<memoryDir>/people/<QQ>.md`、`<memoryDir>/groups/<群号>.md`，随时能手工编辑
- **自动注入**：走 `systemPrompt.context`，不污染用户消息正文；按「当前发言人 + 当前群」挑档案
- **工具**：`memory_note`（记一条）、`memory_recall`（翻全文）
- **自动压缩**：档案超过 4000 字符时把旧记录折叠成一行计数，保留最近 40 条
- **通道无关**：聊天对象从会话 ID 解析（`<prefix>-<kind>-<id>`），发言人以消息前缀里的 `(QQ)` 识别；
  解析不到时只注入群档案（或退回上一轮记住的发言人）

## 安装

```bash
# 从 npm
dsh plugin --profile web add @lotuseslunarland/lotuses-memory

# 或从本地目录 / tgz
cd ~/.dsh/profiles/web
pnpm add file:/path/to/Lotuses_Memory
```

然后在 profile 的 `cordis.patch.yml` 里**用 insert 块**启用（新插件不能用顶层 `- id:`）：

```yaml
- insert:
    - id: lotuses-memory
      name: '@lotuseslunarland/lotuses-memory'
      config:
        memoryDir: '/path/to/Memory'
        sessionsDir: '/root/.dsh/sessions'   # 可选，默认 <DSH_HOME>/sessions
        maxPersonChars: 900
        maxGroupChars: 600
```

## 配置

| 键 | 默认 | 说明 |
| --- | --- | --- |
| `memoryDir` | `<cwd>/Memory` | 记忆库目录 |
| `sessionsDir` | `<DSH_HOME>/sessions` | 会话文件根目录（用于识别发言人） |
| `maxPersonChars` | `900` | 单个人物档案注入上限 |
| `maxGroupChars` | `600` | 单个群档案注入上限 |
| `injectOrder` | `2500` | 注入在系统提示中的排序位置 |

## 档案格式

> 下面的人名、QQ、群号全是虚构示例，只为说明结构。

```markdown
# 示例昵称（100000001）

## 名字
- **账号昵称**：`示例昵称`
- **各群群名片**：1000000001 → 小示

## 基本信息
- **身份**：管理员

## 称呼与代词

- 我叫「示例昵称」；性别未确认时用「对方」

## 记录
- 2026-01-01 00:00｜喜欢在深夜写代码
```

写入是**追加式**的，不会覆盖手写内容；文件头（名字/基本信息等）由人维护，`## 记录` 段由工具追加。

## 设计取舍

- **为什么读会话文件而不是订阅事件**：这样插件不依赖任何聊天通道插件，也不碰宿主内部状态。
  代价是"同一轮里消息可能还没落盘"，因此保留了「上次成功发言人」兜底。
- **为什么不用向量检索**：长期记忆的核心需求是"认识人和群"，结构化档案足够；向量检索成本高且难以人工校正。
- **为什么档案是文件**：可审计、可备份、可手改。黑盒记忆出了问题没法查。

## License

MIT
