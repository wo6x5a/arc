# ARC — AI Remote Coding

通过 Telegram Bot 远程控制本机的 AI 编程助手（Claude Code等），在手机上发消息即可让 AI 帮你读代码、写代码、执行命令、提交代码等。

## 效果预览

```
你：帮我看一下 src/index.js 有没有 bug

Bot：⏳ 正在处理：帮我看一下 src/index.js 有没有 bug...
Bot：我检查了 src/index.js，发现第 23 行有一个潜在问题...
Bot：✅ 任务完成

你：帮我修复它

Bot：⏳ 正在处理：帮我修复它...（记得上文）
Bot：已修复，改动如下...
Bot：✅ 任务完成

你：帮我 git commit

Bot：⏳ 正在处理：帮我 git commit...
Bot：已提交 commit: fix: resolve null reference in index.js
Bot：✅ 任务完成
```

## 前置要求

- Node.js 18+
- 已安装 Claude Code：`npm install -g @anthropic-ai/claude-code`
- Telegram 账号
- 本机需保持开机并运行此服务

## 安装步骤

### 第一步：创建 Telegram Bot

1. 在 Telegram 搜索 `@BotFather`
2. 发送 `/newbot`，按提示创建
3. 保存返回的 **Bot Token**（格式如 `123456789:ABCdefGHI...`）

### 第二步：获取你的 User ID

1. 在 Telegram 搜索 `@userinfobot`，发送任意消息
2. 保存返回的 **Id** 数字（用于白名单，防止他人使用你的 Bot）

### 第三步：配置

```bash
cd arc
npm install
cp .env.example .env
```

编辑 `.env`：

```env
# Bot Token（必填）
TELEGRAM_BOT_TOKEN=123456789:ABCdefGHI...

# 白名单用户 ID，多个用逗号分隔（强烈建议填写）
ALLOWED_USER_IDS=123456789

# Claude Code 默认工作目录
WORK_DIR=/Users/your_username/your_project

# 预设项目列表，发送 /projects 可点按钮快速切换
PROJECTS=[{"name":"项目A","path":"/Users/your_username/project-a"},{"name":"项目B","path":"/Users/your_username/project-b"}]

# 国内访问 Telegram 必填，填本地代理地址
HTTPS_PROXY=http://127.0.0.1:7890

# 三方 API（不使用官方 Anthropic 账号时填写）
ANTHROPIC_AUTH_TOKEN=your_token
ANTHROPIC_BASE_URL=https://your-api-endpoint.com/api

# 权限模式：notify（默认）或 confirm
# notify: Claude 执行操作后发通知，不阻塞
# confirm: 每次操作前发 Telegram 消息让你确认-待完善
PERMISSION_MODE=notify

# ngrok token，使用 /tunnel 命令必填（免费注册 ngrok.com 获取）
NGROK_AUTHTOKEN=your_ngrok_token
```

### 第四步：启动

```bash
npm start
```

看到以下输出即表示启动成功：

```
ARC 启动成功
工作目录: /Users/your_username/your_project
允许的用户 ID: 123456789
预设项目数量: 2
```

## 功能说明

### 多轮对话

Bot 会记住上下文，可以连续对话：

```
你：帮我读一下 package.json
Bot：这个项目使用了...

你：有没有安全漏洞？
Bot：（记得上文）检查了依赖，发现...
```

发送 `/clear` 清除历史，开始新对话。切换项目时也会自动清除历史。

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

Claude 执行操作时，Bot 会实时通知你正在做什么：

```
Bot：⏳ 正在处理：帮我修复 bug...
Bot：🔧 读取文件: src/index.js
Bot：🔧 编辑文件: src/index.js
Bot：🔧 执行命令: npm run test
Bot：修复完成，已通过测试...
Bot：✅ 任务完成
```

### 权限确认模式（confirm）

在 `.env` 中设置 `PERMISSION_MODE=confirm` 可开启权限确认模式。
每次 Claude 准备执行写文件、运行命令等操作时，Bot 会先发消息让你确认：

```
Bot：⚠️ Claude 请求执行操作：
     执行命令: rm -rf dist/

     是否允许？
     [✅ 允许]  [❌ 拒绝]
```

### 切换项目

```
你：/projects

Bot：当前工作目录：/Users/your_username/project-a
     [✅ 项目A]
     [项目B]

你：点击 项目B

Bot：已切换到：项目B
```

## 命令列表

### 基础命令

| 命令 | 说明 |
|------|------|
| `/help` | 显示所有命令帮助 |
| `/projects` | 列出预设项目，点按钮切换工作目录 |
| `/clear` | 清除对话历史，开始新对话 |
| `/stop` | 中止当前任务并清空队列 |
| `/status` | 查看当前状态（是否执行中、队列情况、是否有对话历史） |

### 验证命令

| 命令 | 说明 |
|------|------|
| `/test [命令]` | 在当前工作目录运行测试/构建，不传命令时自动探测 package.json scripts |
| `/screenshot [URL]` | 截图指定网页并发回 Telegram，已开隧道时可省略 URL |
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
# 方案1：自动跑测试（探测 package.json scripts）
/test

# 方案1：指定命令
/test npm run build
/test go test ./...

# 方案2：截图网页（适合 UI 改动）
/screenshot http://localhost:3000

# 方案3：开内网穿透，手机直接访问
/tunnel 3000
# Bot 返回：https://xxxx.ngrok-free.app
# 之后截图可省略 URL
/screenshot
```

> `/tunnel` 需要在 `.env` 配置 `NGROK_AUTHTOKEN`，从 [ngrok.com](https://dashboard.ngrok.com) 免费注册获取。

## 开机自启（可选）

```bash
npm install -g pm2
pm2 start src/index.js --name arc
pm2 save
pm2 startup
```

## 注意事项

- `.env` 已加入 `.gitignore`，不会被提交到 git
- `ALLOWED_USER_IDS` 一定要填，否则任何人都能控制你的电脑
- 国内使用需配置 `HTTPS_PROXY`，否则连不上 Telegram
- 服务运行期间本机需保持开机和网络连接
- 默认 `PERMISSION_MODE=notify` 模式下 Claude 拥有完整权限，如需审批每个操作请改为 `confirm`
