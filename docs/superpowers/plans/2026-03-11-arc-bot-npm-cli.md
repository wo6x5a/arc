# arc-bot npm CLI Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Convert the existing ARC project into a globally installable `arc-bot` npm CLI with an interactive setup wizard and PM2-based process management.

**Architecture:** Add a thin CLI layer (`bin/` + `lib/`) on top of the existing `src/` code. Three new files handle CLI routing (`bin/arc-bot.js`), config read/write (`lib/config.js`), PM2 integration (`lib/pm2-manager.js`), and the interactive wizard (`lib/setup-wizard.js`). Modify `src/main.js` minimally for global config path and PM2 compatibility.

**Tech Stack:** Node.js ESM, inquirer v9.x (interactive prompts), pm2 v5.x (process management), dotenv (env parsing)

---

## Chunk 1: package.json + lib/config.js

### Task 1: Update package.json

**Files:**
- Modify: `package.json`

- [ ] **Step 1: Update package.json — add the following fields only (do NOT rewrite the entire file)**

Modify these specific fields in `package.json` (keep all other existing fields unchanged):

- Change `"name"` from `"arc"` to `"arc-bot"`
- Add `"bin": { "arc-bot": "./bin/arc-bot.js" }`
- Add `"engines": { "node": ">=18" }`
- Add to `"dependencies"`: `"inquirer": "^9.3.7"` and `"pm2": "^5.4.3"`

The resulting relevant sections should look like:
```json
{
  "name": "arc-bot",
  "bin": { "arc-bot": "./bin/arc-bot.js" },
  "engines": { "node": ">=18" },
  "dependencies": {
    ... (existing deps unchanged) ...
    "inquirer": "^9.3.7",
    "pm2": "^5.4.3"
  }
}
```

- [ ] **Step 2: Install new dependencies**

Run: `npm install`
Expected: inquirer and pm2 added to node_modules, package-lock.json updated

- [ ] **Step 3: Verify inquirer is ESM-compatible**

Run: `node -e "import('inquirer').then(m => console.log('ok:', typeof m.default))"`
Expected: `ok: function`

- [ ] **Step 4: Commit**

```bash
git add package.json package-lock.json
git commit -m "chore: rename to arc-bot, add bin/engines/inquirer/pm2 to package.json"
```

---

### Task 2: Create lib/config.js

**Files:**
- Create: `lib/config.js`

The required fields that determine "is configured":
- Telegram: `TELEGRAM_BOT_TOKEN` + `ALLOWED_USER_IDS`
- 飞书: `FEISHU_APP_ID` + `FEISHU_APP_SECRET`
- 钉钉: `DINGTALK_APP_KEY` + `DINGTALK_APP_SECRET`

- [ ] **Step 1: Create lib/ directory and lib/config.js**

```bash
mkdir -p lib
```

Create `lib/config.js`:

```js
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs'
import { homedir } from 'os'
import path from 'path'
import dotenv from 'dotenv'

export const CONFIG_DIR = path.join(homedir(), '.arc-bot')
export const CONFIG_FILE = path.join(CONFIG_DIR, '.env')

const CHANNEL_REQUIRED = {
  telegram: ['TELEGRAM_BOT_TOKEN', 'ALLOWED_USER_IDS'],
  feishu:   ['FEISHU_APP_ID', 'FEISHU_APP_SECRET'],
  dingtalk: ['DINGTALK_APP_KEY', 'DINGTALK_APP_SECRET'],
}

/** Returns true if ~/.arc-bot/.env exists and has at least one channel's required fields */
export function isConfigured() {
  if (!existsSync(CONFIG_FILE)) return false
  const env = readEnv()
  return Object.values(CHANNEL_REQUIRED).some(
    fields => fields.every(k => env[k] && env[k].trim() !== '')
  )
}

/** Parse ~/.arc-bot/.env into a key-value object. Returns {} if file doesn't exist. */
export function readEnv() {
  if (!existsSync(CONFIG_FILE)) return {}
  const result = dotenv.parse(readFileSync(CONFIG_FILE, 'utf8'))
  return result
}

/** Write envObj to ~/.arc-bot/.env in formatted blocks. Skips keys with empty values. */
export function writeEnv(envObj) {
  mkdirSync(CONFIG_DIR, { recursive: true })

  const blocks = []

  // Telegram block
  const telegramKeys = ['TELEGRAM_BOT_TOKEN', 'ALLOWED_USER_IDS', 'HTTPS_PROXY']
  const telegramLines = telegramKeys
    .filter(k => envObj[k] && envObj[k].trim() !== '')
    .map(k => `${k}=${envObj[k]}`)
  if (telegramLines.length) blocks.push(['# Telegram', ...telegramLines])

  // Feishu block
  const feishuKeys = ['FEISHU_APP_ID', 'FEISHU_APP_SECRET', 'FEISHU_ALLOWED_USER_IDS']
  const feishuLines = feishuKeys
    .filter(k => envObj[k] && envObj[k].trim() !== '')
    .map(k => `${k}=${envObj[k]}`)
  if (feishuLines.length) blocks.push(['# 飞书', ...feishuLines])

  // Dingtalk block
  const dingtalkKeys = ['DINGTALK_APP_KEY', 'DINGTALK_APP_SECRET', 'DINGTALK_ALLOWED_USER_IDS']
  const dingtalkLines = dingtalkKeys
    .filter(k => envObj[k] && envObj[k].trim() !== '')
    .map(k => `${k}=${envObj[k]}`)
  if (dingtalkLines.length) blocks.push(['# 钉钉', ...dingtalkLines])

  // AI block
  const aiKeys = [
    'DEFAULT_AI_BACKEND',
    'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_BASE_URL',
    'GEMINI_BIN', 'QWEN_BIN', 'CODEX_BIN',
    'CLAUDE_BIN',
  ]
  const aiLines = aiKeys
    .filter(k => envObj[k] && envObj[k].trim() !== '')
    .map(k => `${k}=${envObj[k]}`)
  if (aiLines.length) blocks.push(['# AI', ...aiLines])

  // WORK_DIR
  if (envObj.WORK_DIR && envObj.WORK_DIR.trim() !== '') {
    blocks.push([`WORK_DIR=${envObj.WORK_DIR}`])
  }

  const content = blocks.map(b => b.join('\n')).join('\n\n') + '\n'
  writeFileSync(CONFIG_FILE, content, 'utf8')
}
```

- [ ] **Step 2: Write a quick smoke test inline**

Run:
```bash
node --input-type=module <<'EOF'
import { writeEnv, readEnv, isConfigured, CONFIG_FILE } from './lib/config.js'
import { unlinkSync } from 'fs'
const env = { TELEGRAM_BOT_TOKEN: 'test-tok', ALLOWED_USER_IDS: '123', DEFAULT_AI_BACKEND: 'claude' }
writeEnv(env)
const read = readEnv()
console.assert(read.TELEGRAM_BOT_TOKEN === 'test-tok', 'readEnv failed')
console.assert(isConfigured() === true, 'isConfigured failed')
// Clean up test file
unlinkSync(CONFIG_FILE)
console.log('lib/config.js smoke test PASSED (test file cleaned up)')
EOF
```
Expected: `lib/config.js smoke test PASSED (test file cleaned up)`

- [ ] **Step 3: Commit**

```bash
git add lib/config.js
git commit -m "feat: add lib/config.js — config read/write/isConfigured"
```

---

## Chunk 2: lib/pm2-manager.js

### Task 3: Create lib/pm2-manager.js

**Files:**
- Create: `lib/pm2-manager.js`

- [ ] **Step 1: Create lib/pm2-manager.js**

```js
import pm2 from 'pm2'  // pm2 is CJS — must use default import in ESM
import { spawn } from 'child_process'
import { fileURLToPath } from 'url'
import path from 'path'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
export const MAIN_SCRIPT = path.resolve(__dirname, '../src/main.js')
// Use project-local pm2 binary, not system-wide
const PM2_BIN = path.resolve(__dirname, '../node_modules/.bin/pm2')

function pm2Connect() {
  return new Promise((resolve, reject) =>
    pm2.connect(err => err ? reject(err) : resolve())
  )
}

function pm2Disconnect() {
  return new Promise(resolve => pm2.disconnect(resolve))
}

/** Start arc-bot under PM2 with the given env object */
export async function start(envObj) {
  await pm2Connect()
  try {
    await new Promise((resolve, reject) =>
      pm2.start({
        script: MAIN_SCRIPT,
        name: 'arc-bot',
        env: { ...envObj, ARC_SKIP_PID_LOCK: '1' },
        autorestart: true,
      }, (err) => err ? reject(err) : resolve())
    )
    console.log('arc-bot started successfully (PM2)')
  } finally {
    await pm2Disconnect()
  }
}

/** Stop the arc-bot PM2 process */
export async function stop() {
  await pm2Connect()
  try {
    await new Promise((resolve, reject) =>
      pm2.stop('arc-bot', (err) => err ? reject(err) : resolve())
    )
    console.log('arc-bot stopped')
  } finally {
    await pm2Disconnect()
  }
}

/** Restart the arc-bot PM2 process */
export async function restart() {
  await pm2Connect()
  try {
    await new Promise((resolve, reject) =>
      pm2.restart('arc-bot', (err) => err ? reject(err) : resolve())
    )
    console.log('arc-bot restarted')
  } finally {
    await pm2Disconnect()
  }
}

/** Tail arc-bot logs via PM2 CLI (inherits stdio for interactive output) */
export function logs() {
  spawn(PM2_BIN, ['logs', 'arc-bot'], { stdio: 'inherit' })
}

/** Show arc-bot PM2 process status */
export function status() {
  spawn(PM2_BIN, ['status', 'arc-bot'], { stdio: 'inherit' })
}

/** Returns true if arc-bot PM2 process is running (status === 'online') */
export async function isRunning() {
  await pm2Connect()
  try {
    const list = await new Promise((resolve, reject) =>
      pm2.list((err, list) => err ? reject(err) : resolve(list))
    )
    return list.some(p => p.name === 'arc-bot' && p.pm2_env?.status === 'online')
  } finally {
    await pm2Disconnect()
  }
}
```

- [ ] **Step 2: Verify module loads and PM2_BIN exists**

Run: `node --input-type=module <<'EOF'
import { MAIN_SCRIPT } from './lib/pm2-manager.js'
import { existsSync } from 'fs'
import path from 'path'
const __dirname = new URL('.', import.meta.url).pathname
const PM2_BIN = path.resolve(__dirname, 'node_modules/.bin/pm2')
console.assert(existsSync(MAIN_SCRIPT), 'MAIN_SCRIPT path invalid: ' + MAIN_SCRIPT)
console.assert(existsSync(PM2_BIN), 'PM2_BIN not found (run npm install first): ' + PM2_BIN)
console.log('pm2-manager.js loads OK, MAIN_SCRIPT =', MAIN_SCRIPT)
console.log('PM2_BIN exists:', PM2_BIN)
EOF`

Expected: both assertions pass, MAIN_SCRIPT and PM2_BIN paths printed

- [ ] **Step 3: Commit**

```bash
git add lib/pm2-manager.js
git commit -m "feat: add lib/pm2-manager.js — PM2 process management wrapper"
```

---

## Chunk 3: src/main.js modifications

### Task 4: Modify src/main.js

**Files:**
- Modify: `src/main.js`

Three changes needed — **apply Steps 1–4 in order** (each step depends on the previous):
1. Replace `import 'dotenv/config'` with dual-path dotenv loading (introduces `path` and `homedir`)
2. Move PID file to `~/.arc-bot/.arc.pid` and add SKIP_PID_LOCK guard (uses `path` and `homedir` from step 1)
3. Wrap PID write/cleanup in SKIP_PID_LOCK guard
4. Remove now-unused `import { resolve } from 'path'` (safe only after step 1 added `import path from 'path'`)

- [ ] **Step 1: Replace dotenv import (line 1)**

Replace:
```js
import 'dotenv/config'
```
With:
```js
import dotenv from 'dotenv'
import { homedir } from 'os'
import path from 'path'

// Priority: ~/.arc-bot/.env (global config) > ./.env (dev fallback)
dotenv.config({ path: path.join(homedir(), '.arc-bot', '.env') })
dotenv.config() // second call: existing keys are NOT overwritten (dotenv default)
```

- [ ] **Step 2: Update PID file path (line 8) and add SKIP_PID_LOCK guard**

Replace:
```js
const __dirname = fileURLToPath(new URL('.', import.meta.url))
const PID_FILE = resolve(__dirname, '../.arc.pid')

if (existsSync(PID_FILE)) {
```
With:
```js
const __dirname = fileURLToPath(new URL('.', import.meta.url))
const PID_FILE = path.join(homedir(), '.arc-bot', '.arc.pid')

const SKIP_PID_LOCK = process.env.ARC_SKIP_PID_LOCK === '1'

if (!SKIP_PID_LOCK && existsSync(PID_FILE)) {
```

- [ ] **Step 3: Wrap PID write and cleanup in SKIP_PID_LOCK guard**

Find the lines:
```js
writeFileSync(PID_FILE, String(process.pid))
process.on('exit', () => { try { unlinkSync(PID_FILE) } catch {} })
```
Replace with:
```js
if (!SKIP_PID_LOCK) {
  writeFileSync(PID_FILE, String(process.pid))
  process.on('exit', () => { try { unlinkSync(PID_FILE) } catch {} })
}
```

- [ ] **Step 4: Remove now-unused `resolve` named import**

After Step 1 added `import path from 'path'`, the original `import { resolve } from 'path'` line is now unused. Remove it.

Find and delete exactly this line from `src/main.js`:
```js
import { resolve } from 'path'
```

Do NOT remove `import path from 'path'` (added in Step 1) — only remove the old named import above.

- [ ] **Step 5: Verify src/main.js still loads (no syntax errors)**

Run: `node --check src/main.js`
Expected: no output (syntax OK)

- [ ] **Step 6: Quick smoke test — verify main.js syntax and PID path**

Run:
```bash
node --check src/main.js && echo "syntax OK"
ARC_SKIP_PID_LOCK=1 node src/main.js &
sleep 2
kill $! 2>/dev/null || true
echo "smoke test done"
```
Expected: `syntax OK`, process starts (may print "未配置任何 Bot" if no .env, that's fine), exits after kill. No PID file written (SKIP_PID_LOCK=1).

If `~/.arc-bot/.env` is configured, also verify PID file appears at `~/.arc-bot/.arc.pid`.

- [ ] **Step 7: Commit**

```bash
git add src/main.js
git commit -m "feat: main.js — global config path, PM2-compatible PID lock"
```

---

## Chunk 4: lib/setup-wizard.js

### Task 5: Create lib/setup-wizard.js

**Files:**
- Create: `lib/setup-wizard.js`

Note on wizard code: `CLAUDE_BIN` is intentionally included in the Claude backend config prompts — it's listed in `.env.example` and `CLAUDE.md` env vars table as a supported config field, even though the spec's AI table omitted it. This is a deliberate alignment with the full env var spec.

- [ ] **Step 1: Create lib/setup-wizard.js**

```js
import inquirer from 'inquirer'
import { readEnv, writeEnv } from './config.js'
import { start } from './pm2-manager.js'

/** Run the interactive setup wizard. Handles writing .env and optionally starting. */
export async function runWizard() {
  const existing = readEnv()

  console.log('\n🤖 Welcome to arc-bot setup!\n')

  // Step 1: Select channels (multi-select, at least one)
  let channels
  while (true) {
    const ans = await inquirer.prompt([{
      type: 'checkbox',
      name: 'channels',
      message: 'Which messaging channels do you want to enable? (space to select)',
      choices: [
        { name: 'Telegram', value: 'telegram' },
        { name: '飞书 (Feishu)', value: 'feishu' },
        { name: '钉钉 (DingTalk)', value: 'dingtalk' },
      ],
      default: Object.keys(existing).length > 0 ? _detectExistingChannels(existing) : [],
    }])
    if (ans.channels.length > 0) { channels = ans.channels; break }
    console.log('Please select at least one channel.')
  }

  const env = { ...existing }

  // Step 2: Channel config
  if (channels.includes('telegram')) {
    const ans = await inquirer.prompt([
      { type: 'input', name: 'TELEGRAM_BOT_TOKEN', message: 'Telegram Bot Token:', default: existing.TELEGRAM_BOT_TOKEN || '' },
      { type: 'input', name: 'ALLOWED_USER_IDS', message: 'Allowed User IDs (comma-separated):', default: existing.ALLOWED_USER_IDS || '' },
      { type: 'input', name: 'HTTPS_PROXY', message: 'HTTPS Proxy (optional, e.g. http://127.0.0.1:7890):', default: existing.HTTPS_PROXY || '' },
    ])
    Object.assign(env, ans)
  }

  if (channels.includes('feishu')) {
    const ans = await inquirer.prompt([
      { type: 'input', name: 'FEISHU_APP_ID', message: '飞书 App ID:', default: existing.FEISHU_APP_ID || '' },
      { type: 'input', name: 'FEISHU_APP_SECRET', message: '飞书 App Secret:', default: existing.FEISHU_APP_SECRET || '' },
      { type: 'input', name: 'FEISHU_ALLOWED_USER_IDS', message: '飞书白名单 openId（选填，留空允许所有人）:', default: existing.FEISHU_ALLOWED_USER_IDS || '' },
    ])
    Object.assign(env, ans)
  }

  if (channels.includes('dingtalk')) {
    const ans = await inquirer.prompt([
      { type: 'input', name: 'DINGTALK_APP_KEY', message: '钉钉 App Key:', default: existing.DINGTALK_APP_KEY || '' },
      { type: 'input', name: 'DINGTALK_APP_SECRET', message: '钉钉 App Secret:', default: existing.DINGTALK_APP_SECRET || '' },
      { type: 'input', name: 'DINGTALK_ALLOWED_USER_IDS', message: '钉钉白名单 staffId（选填，留空允许所有人）:', default: existing.DINGTALK_ALLOWED_USER_IDS || '' },
    ])
    Object.assign(env, ans)
  }

  // Step 3: AI backends (multi-select, at least one)
  let backends
  while (true) {
    const ans = await inquirer.prompt([{
      type: 'checkbox',
      name: 'backends',
      message: 'Which AI backends do you want to use?',
      choices: [
        { name: 'Claude', value: 'claude' },
        { name: 'Gemini', value: 'gemini' },
        { name: 'Qwen', value: 'qwen' },
        { name: 'Codex', value: 'codex' },
      ],
      default: existing.DEFAULT_AI_BACKEND ? [existing.DEFAULT_AI_BACKEND] : ['claude'],
    }])
    if (ans.backends.length > 0) { backends = ans.backends; break }
    console.log('Please select at least one AI backend.')
  }

  env.DEFAULT_AI_BACKEND = backends[0]

  // Step 4: AI backend config
  if (backends.includes('claude')) {
    const ans = await inquirer.prompt([
      { type: 'input', name: 'ANTHROPIC_AUTH_TOKEN', message: 'Claude API Token (optional, for 3rd-party API):', default: existing.ANTHROPIC_AUTH_TOKEN || '' },
      { type: 'input', name: 'ANTHROPIC_BASE_URL', message: 'Claude API Base URL (optional):', default: existing.ANTHROPIC_BASE_URL || '' },
      { type: 'input', name: 'CLAUDE_BIN', message: 'Claude CLI path (optional, leave blank to auto-detect):', default: existing.CLAUDE_BIN || '' },
    ])
    Object.assign(env, ans)
  }

  if (backends.includes('gemini')) {
    const ans = await inquirer.prompt([
      { type: 'input', name: 'GEMINI_BIN', message: 'Gemini CLI path (optional, leave blank to auto-detect):', default: existing.GEMINI_BIN || '' },
    ])
    Object.assign(env, ans)
  }

  if (backends.includes('qwen')) {
    const ans = await inquirer.prompt([
      { type: 'input', name: 'QWEN_BIN', message: 'Qwen CLI path (optional, leave blank to auto-detect):', default: existing.QWEN_BIN || '' },
    ])
    Object.assign(env, ans)
  }

  if (backends.includes('codex')) {
    const ans = await inquirer.prompt([
      { type: 'input', name: 'CODEX_BIN', message: 'Codex CLI path (optional, leave blank to auto-detect):', default: existing.CODEX_BIN || '' },
    ])
    Object.assign(env, ans)
  }

  // Step 5: Work directory
  const wdAns = await inquirer.prompt([{
    type: 'input',
    name: 'WORK_DIR',
    message: 'Default work directory (optional, leave blank for ~/):'  ,
    default: existing.WORK_DIR || '',
  }])
  Object.assign(env, wdAns)

  // Write config
  writeEnv(env)
  console.log('\n✅ Config saved to ~/.arc-bot/.env')
  console.log('   To add PROJECTS presets, edit ~/.arc-bot/.env manually.')
  console.log('   Example: PROJECTS=[{"name":"myapp","path":"/Users/you/myapp"}]\n')

  // Step 6: Start now?
  const startAns = await inquirer.prompt([{
    type: 'confirm',
    name: 'startNow',
    message: 'Start arc-bot now?',
    default: true,
  }])

  if (startAns.startNow) {
    await start(env)
  }
}

function _detectExistingChannels(env) {
  const result = []
  if (env.TELEGRAM_BOT_TOKEN) result.push('telegram')
  if (env.FEISHU_APP_ID) result.push('feishu')
  if (env.DINGTALK_APP_KEY) result.push('dingtalk')
  return result
}
```

- [ ] **Step 2: Verify module loads without error**

Run: `node --input-type=module <<'EOF'
import { runWizard } from './lib/setup-wizard.js'
console.log('setup-wizard.js loads OK, runWizard type:', typeof runWizard)
EOF`

Expected: `setup-wizard.js loads OK, runWizard type: function`

- [ ] **Step 3: Commit**

```bash
git add lib/setup-wizard.js
git commit -m "feat: add lib/setup-wizard.js — interactive inquirer-based setup wizard"
```

---

## Chunk 5: bin/arc-bot.js + integration test

### Task 6: Create bin/arc-bot.js

**Files:**
- Create: `bin/arc-bot.js`

- [ ] **Step 1: Create bin/ directory and bin/arc-bot.js**

```bash
mkdir -p bin
```

Create `bin/arc-bot.js`:

```js
#!/usr/bin/env node
import { start, stop, restart, logs, status } from '../lib/pm2-manager.js'
import { runWizard } from '../lib/setup-wizard.js'
import { isConfigured, readEnv } from '../lib/config.js'

const USAGE = `Usage: arc-bot [command]

Commands:
  start    Start the bot (runs setup wizard if not configured)
  config   Run setup wizard to reconfigure
  stop     Stop the bot
  restart  Restart the bot
  logs     Show logs
  status   Show process status

  --help, -h  Show this help message
`

const cmd = process.argv[2] ?? 'start'

if (cmd === '--help' || cmd === '-h') {
  console.log(USAGE)
  process.exit(0)
}

switch (cmd) {
  case 'start':
    if (!isConfigured()) {
      // Wizard handles writing .env and optionally calling start()
      await runWizard()
    } else {
      await start(readEnv())
    }
    break

  case 'config':
    // Wizard handles writing .env and optionally calling start()
    await runWizard()
    break

  case 'stop':
    await stop()
    break

  case 'restart':
    await restart()
    break

  case 'logs':
    logs()
    break

  case 'status':
    status()
    break

  default:
    console.error(`Unknown command: ${cmd}\n`)
    console.log(USAGE)
    process.exit(1)
}
```

- [ ] **Step 2: Make the file executable**

Run: `chmod +x bin/arc-bot.js`

- [ ] **Step 3: Verify --help works**

Run: `node bin/arc-bot.js --help`
Expected: Usage message printed, process exits 0

- [ ] **Step 4: Verify unknown command exits with code 1**

Run: `node bin/arc-bot.js unknowncmd; echo "exit: $?"`
Expected: `Unknown command: unknowncmd` + `exit: 1`

- [ ] **Step 5: Simulate npm link to test global install locally**

Run:
```bash
npm link
arc-bot --help
```
Expected: same usage message as step 3 via global `arc-bot` command

- [ ] **Step 6: Commit**

```bash
git add bin/arc-bot.js
git commit -m "feat: add bin/arc-bot.js — CLI entry point with command routing"
```

---

### Task 7: End-to-end manual integration test

**Files:** (none created — verification only)

- [ ] **Step 1: Test config wizard (dry run, say N to start)**

Run: `arc-bot config`
Expected:
- Wizard prompts for channels, tokens, AI backends, work dir
- Wizard asks "Start arc-bot now?" — answer **N**
- Process exits cleanly
- `~/.arc-bot/.env` file created/updated

- [ ] **Step 2: Verify ~/.arc-bot/.env contents**

Run: `cat ~/.arc-bot/.env`
Expected: formatted output with `# Telegram` / `# AI` blocks, no empty `KEY=` lines

- [ ] **Step 3: Test `arc-bot start` uses existing config (clean PM2 state first)**

First ensure no leftover PM2 process from previous attempts:
```bash
node_modules/.bin/pm2 delete arc-bot 2>/dev/null || true
```

Then run: `arc-bot start`
Expected: PM2 starts `arc-bot` process without running wizard again

- [ ] **Step 4: Verify PM2 process is running**

Run: `arc-bot status`
Expected: PM2 status table showing `arc-bot` as `online`

- [ ] **Step 5: Test stop and restart**

Run:
```bash
arc-bot stop
arc-bot status   # should show stopped
arc-bot restart
arc-bot status   # should show online
```

- [ ] **Step 6: Test logs command**

Run: `arc-bot logs` (Ctrl+C to exit)
Expected: log output from PM2, no crash

- [ ] **Step 7: Final commit**

```bash
git add -A
git commit -m "chore: arc-bot npm CLI complete — bin+lib layer, wizard, PM2 integration"
```

---

## Summary: Files Changed

| File | Action | Purpose |
|------|--------|---------|
| `package.json` | Modify | name=arc-bot, add bin/engines/inquirer/pm2 |
| `lib/config.js` | Create | Config read/write/isConfigured |
| `lib/pm2-manager.js` | Create | PM2 process management |
| `lib/setup-wizard.js` | Create | Interactive inquirer wizard |
| `bin/arc-bot.js` | Create | CLI entry point |
| `src/main.js` | Modify | Global env path, PM2-safe PID lock |
