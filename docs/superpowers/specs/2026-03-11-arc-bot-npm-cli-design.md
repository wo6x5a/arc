# arc-bot npm CLI 设计文档

**日期：** 2026-03-11
**状态：** 已确认

---

## 概述

将现有 ARC（AI Remote Coding）项目改造为可通过 `npm install -g arc-bot` 全局安装的 CLI 工具。采用最小改造策略，在现有 `src/` 代码基础上新增 CLI 入口层，不重构核心逻辑。

---

## 运行环境要求

- **Node.js >= 18**（`inquirer` v9.x + ESM 要求）
- `package.json` 添加 `"engines": { "node": ">=18" }`

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
│   └── arc-bot.js          ← CLI 入口，命令路由（ESM，首行 #!/usr/bin/env node）
├── lib/
│   ├── setup-wizard.js     ← 交互式配置向导（inquirer v9.x，ESM）
│   ├── pm2-manager.js      ← PM2 命令封装（ESM）
│   └── config.js           ← 配置读写工具（isConfigured, readEnv, writeEnv）
├── src/                    ← 现有代码，最小改动
│   ├── main.js             ← 改动：env 加载逻辑 + PID 文件路径 + PID 锁跳过逻辑
│   ├── index.js
│   ├── feishu.js
│   ├── dingtalk.js
│   └── runners/
└── package.json            ← 添加 bin 字段 + inquirer + pm2 依赖 + engines
```

**全局配置目录：** `~/.arc-bot/`
- `.env` — 用户配置（向导生成）
- `.arc.pid` — PID 锁文件（仅非 PM2 模式下使用）

---

## CLI 命令

| 命令 | 说明 |
|------|------|
| `arc-bot` / `arc-bot start` | 检测配置，未配置则触发向导；已配置则直接启动 |
| `arc-bot config` | 重新运行配置向导（预填现有值；`.env` 不存在则全新向导） |
| `arc-bot stop` | 停止服务 |
| `arc-bot restart` | 重启服务 |
| `arc-bot logs` | 查看日志 |
| `arc-bot status` | 查看运行状态 |

**"已配置"判断标准：** `~/.arc-bot/.env` 存在，且包含至少一个渠道的必填字段（非空）。否则视为未配置，触发向导。

---

## `lib/config.js` 职责

配置读写工具模块，供 `bin/arc-bot.js` 和 `lib/setup-wizard.js` 共用：

- `isConfigured()` — 检测 `~/.arc-bot/.env` 是否存在，且包含至少一个渠道的必填字段（非空）；返回 boolean
- `readEnv()` — 读取并解析 `~/.arc-bot/.env`，返回 key-value 对象；文件不存在时返回空对象
- `writeEnv(envObj)` — 将 key-value 对象按格式写入 `~/.arc-bot/.env`（创建目录如不存在）

---

## `bin/arc-bot.js` 命令路由

不引入额外的 CLI 解析库，直接读取 `process.argv[2]` 分发命令：

```js
#!/usr/bin/env node
import { start, stop, restart, logs, status } from '../lib/pm2-manager.js'
import { runWizard } from '../lib/setup-wizard.js'
import { isConfigured, readEnv } from '../lib/config.js'

const cmd = process.argv[2] ?? 'start'

switch (cmd) {
  case 'start':
    if (!isConfigured()) {
      // runWizard() 负责询问、写 .env、询问是否启动
      // 若用户选择立即启动，runWizard() 内部调用 start(envObj)
      await runWizard()
    } else {
      await start(readEnv())
    }
    break
  case 'config':
    await runWizard()    // 同上，向导内部处理启动逻辑
    break
  case 'stop':    await stop();    break
  case 'restart': await restart(); break
  case 'logs':    logs();          break
  case 'status':  status();        break
  default:
    console.log('Usage: arc-bot [start|config|stop|restart|logs|status]')
    process.exit(1)
}
```

`--help` / `-h` 显示上述 Usage 信息。未知命令退出码 1。

---

## 配置向导流程

使用 `inquirer` v9.x（ESM）实现交互式向导。

### Step 1：选择消息渠道（多选，至少选一个）

- Telegram
- 飞书
- 钉钉

> 支持同时启用多个渠道（与 `src/main.js` 统一入口按需启动架构一致）。

### Step 2：逐个填写所选渠道配置

| 渠道 | 必填字段 | 选填字段 |
|------|----------|----------|
| Telegram | `TELEGRAM_BOT_TOKEN`, `ALLOWED_USER_IDS` | `HTTPS_PROXY` |
| 飞书 | `FEISHU_APP_ID`, `FEISHU_APP_SECRET` | `FEISHU_ALLOWED_USER_IDS` |
| 钉钉 | `DINGTALK_APP_KEY`, `DINGTALK_APP_SECRET` | `DINGTALK_ALLOWED_USER_IDS` |

### Step 3：选择 AI 后端（多选，至少选一个）

- Claude（默认选中）
- Gemini
- Qwen
- Codex

多个后端时，第一个选中的设为 `DEFAULT_AI_BACKEND`。

### Step 4：逐个填写所选 AI 后端配置

| 后端 | 字段 | 说明 |
|------|------|------|
| Claude | `ANTHROPIC_AUTH_TOKEN`, `ANTHROPIC_BASE_URL` | 均选填，用三方 API 时填 |
| Gemini | `GEMINI_BIN` | 选填，留空自动查找 |
| Qwen | `QWEN_BIN` | 选填，留空自动查找 |
| Codex | `CODEX_BIN` | 选填，留空自动查找 |

### Step 5：工作目录

- `WORK_DIR`：选填，留空默认 `~/`

### Step 6：确认启动

- 询问是否立即启动，默认 Y
- 用户选 **Y**：`setup-wizard.js` 调用 `start(envObj)`（传入内存中的配置对象，无需重新读文件），然后 `runWizard()` 返回
- 用户选 **N**：`runWizard()` 直接返回，进程正常退出（退出码 0）

`runWizard()` 不返回任何值，启动行为完全在其内部处理，`bin/arc-bot.js` 的 `config` 分支无需再调用 `start()`。

**重新配置行为：** `arc-bot config` 检测 `~/.arc-bot/.env` 是否存在：存在则预填所有字段，用户回车保留；不存在则全新向导（所有字段为空）。

### `.env` 文件写入格式

- 按渠道分块，每块前加注释行（`# Telegram` / `# 飞书` / `# 钉钉`）
- AI 后端配置块以 `# AI` 注释开头
- 选填字段用户留空时**省略该行**（不写 `KEY=`）
- `PROJECTS` 字段**不在向导中询问**，用户需手动编辑 `~/.arc-bot/.env` 添加（在向导结束时打印提示）

示例输出：
```
# Telegram
TELEGRAM_BOT_TOKEN=xxx
ALLOWED_USER_IDS=123,456

# AI
DEFAULT_AI_BACKEND=claude
ANTHROPIC_AUTH_TOKEN=sk-xxx
```

---

## PM2 集成

### 依赖策略

`pm2` 作为 `dependencies` 打包，使用项目内部 PM2（`node_modules/.bin/pm2`），不依赖系统全局 PM2。

`ecosystem.config.cjs` 保留，供开发者直接使用（app name 为 `arc`）；`pm2-manager.js` 使用 app name `arc-bot`，两者名称不同，**刻意区分**，互不干扰，可同时运行。

### `lib/pm2-manager.js`

```js
import pm2 from 'pm2'  // pm2 是 CJS 模块，需用默认导入
import { spawn } from 'child_process'
import { fileURLToPath } from 'url'
import path from 'path'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const MAIN_SCRIPT = path.resolve(__dirname, '../src/main.js')
const PM2_BIN = path.resolve(__dirname, '../node_modules/.bin/pm2')  // 使用项目内 PM2

export function start(envObj) { /* pm2.connect() then pm2.start({ script: MAIN_SCRIPT, name: 'arc-bot', env: { ...envObj, ARC_SKIP_PID_LOCK: '1' } }) then pm2.disconnect() */ }
export function stop()    { /* pm2.connect() then pm2.stop('arc-bot') then pm2.disconnect() */ }
export function restart() { /* pm2.connect() then pm2.restart('arc-bot') then pm2.disconnect() */ }
export function logs()    { spawn(PM2_BIN, ['logs', 'arc-bot'], { stdio: 'inherit' }) }
export function status()  { spawn(PM2_BIN, ['status', 'arc-bot'], { stdio: 'inherit' }) }
export async function isRunning() { /* pm2.connect() then pm2.list() 过滤 name=arc-bot && status=online then pm2.disconnect() */ }
```

### 启动流程（`arc-bot start`）

1. 检测 `~/.arc-bot/.env` 是否存在且包含必填字段
2. 未配置 → 触发配置向导 → 读取写入的 `.env` → 调用 `pm2-manager.start(envObj)`
3. 已配置 → 读取 `~/.arc-bot/.env` 解析为对象 → 调用 `pm2-manager.start(envObj)`

---

## `src/main.js` 改动

### 1. 环境变量加载

替换 `import 'dotenv/config'`，改为：

```js
import dotenv from 'dotenv'
import { homedir } from 'os'
import path from 'path'

// 优先级：~/.arc-bot/.env > ./.env（开发时使用）
dotenv.config({ path: path.join(homedir(), '.arc-bot', '.env') })
dotenv.config()  // 第二次调用，已有的 key 不覆盖（dotenv 默认行为）
```

### 2. PID 文件路径

将 PID 文件路径从 `resolve(__dirname, '../.arc.pid')` 改为：

```js
const PID_FILE = path.join(homedir(), '.arc-bot', '.arc.pid')
```

### 3. PM2 模式下跳过 PID 锁

PM2 已管理进程生命周期，PID 锁在 PM2 模式下会造成竞态（PM2 restart 时旧实例被杀，PM2 再重启）。通过环境变量跳过：

```js
const SKIP_PID_LOCK = process.env.ARC_SKIP_PID_LOCK === '1'
if (!SKIP_PID_LOCK) {
  // 现有 PID 锁逻辑
}
```

`pm2-manager.start()` 在启动时注入 `ARC_SKIP_PID_LOCK: '1'` 到 env 对象。

---

## `package.json` 改动

```json
{
  "name": "arc-bot",
  "bin": {
    "arc-bot": "./bin/arc-bot.js"
  },
  "engines": {
    "node": ">=18"
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

- WhatsApp 渠道（`src/whatsapp.js` 已存在但未完善，不纳入向导）
- `PROJECTS` 预设项目配置（需用户手动编辑 `.env`，向导结束时打印说明）
- `arc-bot update` 自动更新命令
- 多配置文件 / profile 切换
- Windows 兼容性（PM2 在 Windows 行为有差异）
- 向导中验证 token 有效性（如测试 Telegram Bot Token 是否可用）
