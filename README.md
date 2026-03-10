# ARC — AI Remote Coding

通过 Telegram Bot、飞书 Bot 或钉钉 Bot 远程控制本机的 AI 编程助手（Claude Code、Gemini CLI、Qwen Code、Codex 等），在手机上发消息即可让 AI 帮你读代码、写代码、执行命令、提交代码等。

## 效果预览

```
你：帮我看一下 src/index.js 有没有 bug

Bot：⏳ [Claude Code] 正在处理：帮我看一下 src/index.js 有没有 bug...
Bot：🔧 读取文件: src/index.js
Bot：我检查了 src/index.js，发现第 23 行有一个潜在问题...
Bot：✅ 任务完成

你：帮我修复它

Bot：⏳ [Claude Code] 正在处理：帮我修复它...（记得上文）
Bot：已修复，改动如下...
Bot：✅ 任务完成

你：/ai   ← 切换到 Gemini

你：帮我 git commit

Bot：⏳ [Gemini CLI] 正在处理：帮我 git commit...
Bot：已提交 commit: fix: resolve null reference in index.js
Bot：✅ 任务完成
```

## 前置要求

- Node.js 18+
- 至少安装一种 AI CLI：
  - Claude Code：`npm install -g @anthropic-ai/claude-code`
  - Gemini CLI：`npm install -g @google/gemini-cli`
  - Qwen Code：`npm install -g @qwen-code/qwen-code`
  - Codex CLI：`npm install -g @openai/codex`
- Telegram 账号（或飞书企业应用，或钉钉企业内部应用）
- 本机需保持开机并运行此服务

## 安装步骤

### 第一步：创建 Bot（三选一或多选）

#### Telegram(推荐)

1. 在 Telegram 搜索 `@BotFather`，发送 `/newbot`，按提示创建
2. 保存返回的 **Bot Token**（格式如 `123456789:ABCdefGHI...`）
3. 在 Telegram 搜索 `@userinfobot`，发送任意消息，保存返回的 **Id** 数字（用于白名单）

#### 钉钉

1. 进入[钉钉开放平台](https://open.dingtalk.com) → 创建**企业内部应用**
2. 「添加应用能力」→ 添加**机器人**
3. 机器人配置中，消息接收模式选择 **Stream 模式**（无需公网 IP）
4. 将机器人发布到企业内部
5. 保存「基础信息」中的 **AppKey** 和 **AppSecret**
6. 获取白名单用户的 staffId：进入钉钉管理后台 → 通讯录，点击成员查看 staffId

#### 飞书

1. 进入[飞书开放平台](https://open.feishu.cn) → 创建**企业自建应用**
2. 「添加应用能力」→ 启用**机器人**
3. 「权限管理」→ 开通以下权限：
   - `im:message`（接收消息）
   - `im:message:send_as_bot`（发送消息）
4. 「事件订阅」→ 订阅方式选择**长连接**（无需公网 IP，无需填 Webhook URL）
5. 「事件订阅」→ 添加事件 `im.message.receive_v1`
6. 发布应用（审核通过后生效）
7. 保存「凭证与基础信息」中的 **App ID** 和 **App Secret**

### 第二步：配置

```bash
cd arc
npm install
cp .env.example .env
```

编辑 `.env`，按需填写对应平台的配置（不使用的平台留空即可，对应 Bot 不会启动）：

```env
# ── Telegram ──────────────────────────────────────────────
TELEGRAM_BOT_TOKEN=123456789:ABCdefGHI...
ALLOWED_USER_IDS=123456789          # 白名单用户 ID，逗号分隔
HTTPS_PROXY=http://127.0.0.1:7890   # 国内访问 Telegram 必填

# ── 飞书 ──────────────────────────────────────────────────
FEISHU_APP_ID=cli_xxxxxxxxxxxxxxxx
FEISHU_APP_SECRET=xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
FEISHU_ALLOWED_USER_IDS=ou_xxxxxxxx # 白名单 openId（ou_ 开头），逗号分隔，空则允许所有人

# ── 钉钉 ──────────────────────────────────────────────────
DINGTALK_APP_KEY=dingxxxxxxxxxxxxxxxx
DINGTALK_APP_SECRET=xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
DINGTALK_ALLOWED_USER_IDS=          # 白名单 staffId，逗号分隔，空则允许所有人

# ── 通用 ──────────────────────────────────────────────────
DEFAULT_AI_BACKEND=claude            # claude / gemini / qwen / codex
WORK_DIR=/Users/your_username/your_project
PROJECTS=[{"name":"项目A","path":"/path/a"},{"name":"项目B","path":"/path/b"}]

# 三方 Claude API（可选，使用官方账号时不填）
ANTHROPIC_AUTH_TOKEN=your_token
ANTHROPIC_BASE_URL=https://your-api-endpoint.com/api

# ngrok token，使用 /tunnel 命令必填
NGROK_AUTHTOKEN=your_ngrok_token
```

### 第三步：启动

```bash
npm install -g pm2        # 首次需要全局安装 PM2
npm run pm2:start         # 启动（后台运行，崩溃自动重启）
npm run pm2:status        # 确认运行状态，显示 online 即成功
```

## 功能说明

### 多平台支持

三个平台同时运行，共享同一套 AI 后端和工作目录配置：

| 平台 | 连接方式 | 是否需要公网 IP |
|------|----------|-----------------|
| Telegram | 长轮询 | 否（需代理） |
| 飞书 | WSClient 长连接 | 否 |
| 钉钉 | Stream 模式 | 否 |

### 多 AI 后端切换

支持 Claude Code、Gemini CLI、Qwen Code、Codex CLI 四种后端，随时切换：

```
你：/ai

Bot：切换 AI 后端（当前：Claude Code）

     1. ✅ 🤖 Claude Code（当前）
     2. ✨ Gemini CLI
     3. 🌟 Qwen Code
     4. ⚡ Codex CLI

     回复序号即可选择，或直接发送命令

你：3

Bot：✅ 已切换到 🌟 Qwen Code
     对话历史已自动清除
```

每个对话独立选择后端，切换时自动清除上下文历史。默认后端在 `.env` 中通过 `DEFAULT_AI_BACKEND` 配置。

### 多轮对话

Bot 会记住上下文，可以连续对话：

```
你：帮我读一下 package.json
Bot：这个项目使用了...

你：有没有安全漏洞？
Bot：（记得上文）检查了依赖，发现...
```

发送 `/clear` 清除历史，开始新对话。切换项目或切换 AI 后端时也会自动清除历史。

### 任务队列

同一个 Bot 对话里可以连续发多条消息，后面的会自动排队：

```
你：任务A
Bot：⏳ 正在处理：任务A...

你：任务B
Bot：已加入队列（排第 1 位）：任务B

Bot：（任务A的回复）
Bot：✅ 任务完成（队列中还有 1 个任务）

Bot：⏳ 正在处理：任务B...
```

### 工具执行通知

AI 执行操作时，Bot 会实时通知你正在做什么：

```
Bot：⏳ 正在处理：帮我修复 bug...
Bot：🔧 读取文件: src/index.js
Bot：🔧 编辑文件: src/index.js
Bot：🔧 执行命令: npm run test
Bot：修复完成，已通过测试...
Bot：✅ 任务完成
```

### 切换项目

```
你：/projects

Bot：切换工作项目（当前：/path/a）

     1. ✅ 项目A（当前）
     2. 项目B

     回复序号即可选择

你：2

Bot：✅ 已切换到：项目B
```

### 自定义工作目录

不在预设列表里的目录，可以用 `/cd` 命令直接切换：

```
你：/cd /Users/your_username/some-other-project

Bot：✅ 已切换工作目录：/Users/your_username/some-other-project
     对话历史已自动清除
```

## 命令列表

| 命令 | 说明 |
|------|------|
| `/help` | 显示所有命令帮助 |
| `/ai` | 切换 AI 后端（Claude / Gemini / Qwen / Codex） |
| `/projects` | 列出预设项目，回复序号切换工作目录 |
| `/cd <路径>` | 切换到任意自定义工作目录 |
| `/clear` | 清除对话历史，开始新对话 |
| `/stop` | 中止当前任务并清空队列 |
| `/status` | 查看当前状态（AI 后端、工作目录、是否执行中、对话历史） |
| `/test [命令]` | 在当前工作目录运行测试/构建，不传命令时自动探测 package.json scripts |
| `/screenshot [URL]` | 截图指定网页（Telegram 发回图片，飞书/钉钉提示查看本地文件） |
| `/tunnel <端口>` | 用 ngrok 开启内网穿透，获取公网链接；`/tunnel stop` 关闭 |

## 任务示例

```
帮我看一下项目里有没有明显的 bug

给 src/utils.js 加上单元测试

运行 npm run build，如果有报错帮我修复

帮我把 main 分支最新代码 pull 下来

帮我 git commit，message 写清楚改了什么
```

## 验证改动效果

改完代码后，可以用以下命令验证：

```
# 自动跑测试（探测 package.json scripts）
/test

# 指定命令
/test npm run build
/test go test ./...

# 截图网页（适合 UI 改动）
/screenshot http://localhost:3000

# 开内网穿透，手机直接访问
/tunnel 3000
# Bot 返回：https://xxxx.ngrok-free.app
# 之后截图可省略 URL
/screenshot
```

> `/tunnel` 需要在 `.env` 配置 `NGROK_AUTHTOKEN`，从 [ngrok.com](https://dashboard.ngrok.com) 免费注册获取。

## 进程管理

使用 PM2 管理进程，崩溃后自动重启：

```bash
npm run pm2:status   # 查看状态
npm run pm2:logs     # 查看日志
npm run pm2:restart  # 手动重启
npm run pm2:stop     # 停止
```

### 开机自启

```bash
pm2 startup   # 生成开机自启命令（按提示执行输出的命令）
pm2 save      # 保存当前进程列表，重启后自动恢复
```

PM2 配置文件为项目根目录的 `ecosystem.config.cjs`，崩溃后默认等待 3 秒重启，连续失败 10 次后停止重试。

## 本地调试

不需要 PM2 守护时，可以直接前台运行，日志会实时打印到终端：

```bash
npm start       # 前台运行，Ctrl+C 停止
npm run dev     # 开发模式，文件改动自动重启
```

## 安全说明

ARC 在设计上将安全性放在首位。**服务本身不对外暴露任何端口**，所有通信均由本机主动向平台发起长连接，外部无法主动连入你的机器。

### 架构层面的安全保障

- **无公网暴露**：飞书和钉钉均采用 Stream/WSClient 长连接模式，本机主动连接平台，无需开放任何端口，防火墙不需要做任何配置
- **端到端加密**：所有平台通过官方 SDK 建立 TLS 加密连接，消息不经过任何第三方中转
- **白名单鉴权**：每条消息到达前都会验证发送者身份，未在白名单中的请求直接丢弃，不执行任何操作
- **进程隔离**：AI CLI 以独立子进程运行，由 PM2 托管，崩溃不影响宿主系统

### 白名单配置（推荐）

确保只有你自己能使用，三个平台均支持白名单：

| 平台 | 环境变量 | ID 获取方式 |
|------|----------|-------------|
| Telegram | `ALLOWED_USER_IDS` | 向 @userinfobot 发任意消息获取数字 ID |
| 飞书 | `FEISHU_ALLOWED_USER_IDS` | openId，以 `ou_` 开头，可从飞书开放平台获取 |
| 钉钉 | `DINGTALK_ALLOWED_USER_IDS` | staffId，在钉钉管理后台 → 通讯录中查看 |

留空表示允许所有人使用，**仅建议在个人内网或可信环境中这样配置**。

### 其他注意事项

- `.env` 已加入 `.gitignore`，不会被 git 提交；不要将其内容分享给他人
- Bot Token / App Secret 一旦泄露，立即在对应平台重新生成
- `/tunnel` 开启的 ngrok 隧道公网可访问，仅用于临时验证，用完及时关闭（`/tunnel stop`）
- AI 拥有工作目录下的完整读写和命令执行权限，建议将 `WORK_DIR` 配置为具体项目目录，而非系统根目录


