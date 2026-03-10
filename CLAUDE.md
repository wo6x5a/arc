# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## 项目概述

**ARC（AI Remote Coding）** — 通过 Telegram Bot 或飞书 Bot 远程控制本机 AI 编程助手（Claude Code、Gemini CLI、Qwen Code、Codex 等），将用户的消息转发给 AI 执行，并将执行结果回传。

## 启动与开发

```bash
npm start            # 直接启动（无自动重启）
npm run dev          # 开发模式（文件变更自动重启）
npm run pm2:start    # 生产推荐：PM2 托管，崩溃自动重启
npm run pm2:logs     # 查看 PM2 日志
npm run pm2:restart  # 手动重启
npm run pm2:stop     # 停止
```

PM2 配置文件：`ecosystem.config.cjs`（崩溃后等 3 秒重启，连续失败 10 次停止）。

启动前需要在项目根目录创建 `.env` 文件（参考 `.env.example`）。

## 环境变量

| 变量 | 说明 |
|------|------|
| `TELEGRAM_BOT_TOKEN` | 从 @BotFather 获取，Telegram Bot 必填 |
| `ALLOWED_USER_IDS` | Telegram 白名单用户 ID，逗号分隔 |
| `WORK_DIR` | 默认工作目录 |
| `PROJECTS` | 预设项目列表，JSON 数组格式：`[{"name":"项目名","path":"/绝对路径"}]` |
| `HTTPS_PROXY` | 代理地址，国内访问 Telegram 必填，如 `http://127.0.0.1:7890` |
| `ANTHROPIC_AUTH_TOKEN` | Claude 三方 API token |
| `ANTHROPIC_BASE_URL` | Claude 三方 API 地址 |
| `DEFAULT_AI_BACKEND` | 默认 AI 后端：`claude`（默认）/ `gemini` / `qwen` / `codex` |
| `CLAUDE_BIN` | claude CLI 路径，默认自动查找 |
| `GEMINI_BIN` | gemini CLI 路径，默认自动查找 |
| `QWEN_BIN` | qwen CLI 路径，默认自动查找 |
| `CODEX_BIN` | codex CLI 路径，默认自动查找 |
| `NGROK_AUTHTOKEN` | ngrok token，使用 `/tunnel` 命令必填 |
| `FEISHU_APP_ID` | 飞书应用 App ID，飞书 Bot 必填 |
| `FEISHU_APP_SECRET` | 飞书应用 App Secret，飞书 Bot 必填 |
| `FEISHU_ALLOWED_USER_IDS` | 飞书白名单用户 openId，逗号分隔（空则允许所有人） |
| `DINGTALK_APP_KEY` | 钉钉企业内部应用 AppKey，钉钉 Bot 必填 |
| `DINGTALK_APP_SECRET` | 钉钉企业内部应用 AppSecret，钉钉 Bot 必填 |
| `DINGTALK_ALLOWED_USER_IDS` | 钉钉白名单 staffId，逗号分隔（空则允许所有人） |
| `DINGTALK_WEBHOOK_PORT` | 钉钉 Webhook 监听端口，默认 `7703` |

## 架构

```
src/
├── main.js          # 统一入口，按需启动 Telegram + 飞书 + 钉钉
├── state.js         # 共享状态层（sessionManager、currentWorkDir、各 Map）
├── index.js         # Telegram Bot 消息路由与命令处理
├── feishu.js        # 飞书 Bot（WSClient 长连接 + 命令 + 文字菜单）
├── dingtalk.js      # 钉钉 Bot（HTTP Webhook + 命令 + 文本菜单）
├── session.js       # 每个 chat 的会话状态（isRunning、AbortController）
├── screenshot-helper.js # 截图工具
├── tunnel-helper.js # ngrok 内网穿透管理
└── runners/
    ├── index.js          # 注册表 + getRunner() 工厂函数
    ├── base-runner.js    # 抽象基类（Template Method 模式）
    ├── claude-runner.js  # Claude Code 实现
    ├── gemini-runner.js  # Gemini CLI 实现
    ├── qwen-runner.js    # Qwen Code 实现
    └── codex-runner.js   # Codex CLI 实现（OpenAI）
```

### 多 AI 后端

- **`/ai` 命令**：Telegram 内切换 AI 后端，每个 chat 独立，切换时自动清除对话历史
- **`DEFAULT_AI_BACKEND`**：`.env` 中配置全局默认后端，支持 `claude` / `gemini` / `qwen` / `codex`
- **`BaseRunner`**：共享 spawn + JSONL 解析逻辑（Template Method），子类只需覆盖 `buildArgs()` 等差异点
- **Gemini 差异**：权限跳过用 `-y`，stream-json 格式不同（type:init/message/result），session_id 从 type:init 取得，`--resume <uuid>` 恢复会话
- **Qwen 差异**：格式与 Claude 完全兼容（实测验证），prompt 用 positional 参数（非 -p），可执行文件为 `qwen`
- **Codex 差异**：子命令结构（`codex exec` / `codex exec resume <id>`），JSONL 事件格式不同（需覆盖 `handleMessage`），原生 `-C <dir>` 指定工作目录

### 核心数据流

1. 消息（Telegram/飞书）→ 各自 Bot 模块鉴权 → 创建 `Session`
2. `getRunner(backendName, currentWorkDir)` 按当前后端选择 Runner，`runner.run()` 用 `spawn` 启动对应 CLI
3. 逐行解析 JSON 输出：`assistant` 类型取 `text` block，`tool_result` 类型输出工具执行结果，`result` 类型作兜底
4. `onOutput` 回调 → 发回 Bot（Telegram 超 4096 字分割，飞书超 8000 字分割）

### 飞书 Bot 说明

- **长连接模式**：使用 `@larksuiteoapi/node-sdk` 的 `WSClient`，飞书主动推送事件到本地，无需公网 IP
- **飞书开发者后台配置**：事件订阅 → 订阅方式 → 选择「长连接」，无需填写 Webhook URL
- **交互菜单**：`/ai`、`/projects` 命令发送文字序号菜单，用户回复数字选择（与钉钉一致）
- **菜单超时**：等待用户选择的状态 60 秒内有效，超时自动失效
- **chatId 隔离**：飞书 chatId 是 `oc_` 字符串，与 Telegram 数字 chatId 天然不冲突

### 钉钉 Bot 说明

- **Webhook 模式**：钉钉主动 POST 到本地 HTTP 服务（默认与飞书共用端口 7702），需要公网 URL
- **获取公网 URL**：在任意 Bot 发 `/tunnel 7702`，将返回的 ngrok URL 填入钉钉开发者后台
- **事件路由**：`POST /webhook/dingtalk`（消息事件）
- **签名校验**：HMAC-SHA256(timestamp + "\n" + appSecret) 验证请求合法性
- **群聊 @**：钉钉群聊必须 @ 机器人，代码自动去除 @ 前缀
- **菜单交互**：`/ai`、`/projects` 命令发送 Markdown 文本菜单，用户回复序号选择（降级方案，无需卡片 DSL）
- **统一端口**：飞书和钉钉共用同一个 HTTP 实例，通过路由路径区分（`/webhook/event`、`/webhook/card`、`/webhook/dingtalk`）

### 权限模式

工具调用始终使用 **notify 模式**：AI 执行工具时实时发 Telegram 通知（🔧 标签），不阻塞执行，稳定可靠。

### 关键设计决策

- **多 AI 后端**：`/ai` 命令切换，`src/runners/` 目录下各实现类，新增后端只需继承 `BaseRunner` 实现 `buildArgs()`
- **不使用 `@anthropic-ai/claude-code` SDK**：该包无可导入的 API，只是 CLI 工具；改用子进程调用 `claude -p`
- **必须 `CLAUDECODE=''`**：claude CLI 检测到 `CLAUDECODE` 环境变量会拒绝启动（防止嵌套 session），仅 ClaudeRunner 设置
- **不使用 Telegram Markdown**：AI 输出含特殊字符时 Telegram 会静默丢弃消息，所有 `sendLongMessage` 均使用纯文本
- **心跳机制**：每 8 秒编辑状态消息防止用户以为卡死
- **一个 chat 同时只能有一个任务**：通过 `SessionManager` 按 `chatId` 隔离
- **多轮对话**：通过 `claudeSessionMap` 存储 `session_id`，下次用 `--resume` 恢复上下文
- **网络抖动防崩溃**：全局 `unhandledRejection` 处理器拦截 `EFATAL`/`ECONNRESET` 等 TLS 网络错误，记录日志后忽略（Telegram 轮询会自动重试）
- **`/ai` 切换**：`chatBackendMap` 存储每个 chat 的后端选择，`claudeSessionMap` 存 session_id；切换时两者都清除
