# arc-bot npm CLI 设计文档

**日期：** 2026-03-11
**状态：** 已确认

---

## 概述

将现有 ARC（AI Remote Coding）项目改造为可通过 `npm install -g arc-bot` 全局安装的 CLI 工具。采用最小改造策略，在现有 `src/` 代码基础上新增 CLI 入口层，不重构核心逻辑。

---

## 用户体验目标

- `npm install -g arc-bot` 安装后，运行 `arc-bot` 自动触发交互式配置向导
- 配置完成后立即启动服务（PM2 后台运行）
- `arc-bot config` 可随时重新配置
- 配置全局存储于 `~/.arc-bot/.env`

---

## 文件结构

```
arc-bot/
├── bin/
│   └── arc-bot.js          ← CLI 入口，解析命令行参数
├── lib/
│   ├── setup-wizard.js     ← 交互式配置向导（inquirer）
│   └── pm2-manager.js      ← PM2 命令封装
├── src/                    ← 现有代码，最小改动
│   ├── main.js             ← 仅改：优先读 ~/.arc-bot/.env
│   ├── index.js
│   ├── feishu.js
│   ├── dingtalk.js
│   └── runners/
└── package.json            ← 添加 bin 字段 + inquirer + pm2 依赖
```

**全局配置目录：** `~/.arc-bot/`
- `.env` — 用户配置（向导生成）

---

## CLI 命令

| 命令 | 说明 |
|------|------|
| `arc-bot` / `arc-bot start` | 首次运行触发向导；已配置则直接启动 |
| `arc-bot config` | 重新运行配置向导（预填现有值） |
| `arc-bot stop` | 停止服务 |
| `arc-bot restart` | 重启服务 |
| `arc-bot logs` | 查看日志 |
| `arc-bot status` | 查看运行状态 |

---

## 配置向导流程

使用 `inquirer` 库实现交互式向导，步骤如下：

### Step 1：选择消息渠道（单选）
- Telegram
- 飞书
- 钉钉

### Step 2：填写渠道配置

| 渠道 | 必填字段 | 选填字段 |
|------|----------|----------|
| Telegram | `TELEGRAM_BOT_TOKEN`, `ALLOWED_USER_IDS` | `HTTPS_PROXY` |
| 飞书 | `FEISHU_APP_ID`, `FEISHU_APP_SECRET` | `FEISHU_ALLOWED_USER_IDS` |
| 钉钉 | `DINGTALK_APP_KEY`, `DINGTALK_APP_SECRET` | `DINGTALK_ALLOWED_USER_IDS` |

### Step 3：选择 AI 后端（多选，至少一个）
- Claude（默认选中）
- Gemini
- Qwen
- Codex

### Step 4：逐个填写 AI 后端配置

| 后端 | 字段 | 说明 |
|------|------|------|
| Claude | `ANTHROPIC_AUTH_TOKEN`, `ANTHROPIC_BASE_URL` | 均选填，用三方 API 时填 |
| Gemini | `GEMINI_BIN` | 选填，留空自动查找 |
| Qwen | `QWEN_BIN` | 选填，留空自动查找 |
| Codex | `CODEX_BIN` | 选填，留空自动查找 |

多个后端时，第一个选中的作为 `DEFAULT_AI_BACKEND`。

### Step 5：工作目录
- `WORK_DIR`：选填，留空默认 `~/`

### Step 6：确认启动
- 询问是否立即启动，默认 Y

**重新配置行为：** `arc-bot config` 读取 `~/.arc-bot/.env` 预填所有字段，用户直接回车保留原值。

---

## PM2 集成

### 依赖策略
`pm2` 作为 `dependencies` 打包（不要求用户预装），使用项目内部 PM2 实例。

### `lib/pm2-manager.js` 职责
- `start(envFile)` — 以 `arc-bot` 为名启动进程，传入 env 文件路径
- `stop()` — 停止 `arc-bot` 进程
- `restart()` — 重启 `arc-bot` 进程
- `logs()` — 透传 PM2 日志输出
- `status()` — 显示 PM2 进程状态
- `isRunning()` — 检测进程是否在运行

### 启动流程（`arc-bot start`）
1. 检测 `~/.arc-bot/.env` 是否存在
2. 不存在 → 触发配置向导 → 向导结束后调用 `pm2-manager.start()`
3. 存在 → 直接调用 `pm2-manager.start()`

### 环境变量传递
在 `pm2-manager.js` 中读取 `~/.arc-bot/.env` 解析为对象，通过 PM2 programmatic API 的 `env` 字段注入。

---

## `src/main.js` 改动

**唯一改动：** 环境变量加载逻辑，优先级从高到低：
1. `~/.arc-bot/.env`（全局配置）
2. `./.env`（当前目录，开发时使用）
3. 系统环境变量

---

## `package.json` 改动

```json
{
  "name": "arc-bot",
  "bin": {
    "arc-bot": "./bin/arc-bot.js"
  },
  "dependencies": {
    "inquirer": "^9.x",
    "pm2": "^5.x",
    ...现有依赖
  }
}
```

---

## 不在本次范围内

- whatsapp 渠道（`src/whatsapp.js` 现有文件，不纳入向导）
- `arc-bot update` 自动更新命令
- 多配置文件 / profile 切换
- Windows 兼容性（PM2 在 Windows 行为差异）
