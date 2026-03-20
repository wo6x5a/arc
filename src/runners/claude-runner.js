import { realpathSync, existsSync } from 'fs'
import { execSync } from 'child_process'
import { BaseRunner } from './base-runner.js'

const NODE_BIN = realpathSync(process.execPath)
let CLAUDE_BIN = process.env.CLAUDE_BIN || '/Users/chenwu.lcw/.npm-global/bin/claude'
try { CLAUDE_BIN = realpathSync(CLAUDE_BIN) } catch { /* 路径不存在，保留原始值 */ }

const SYSTEM_PROMPT = '重要：如果需要启动长期运行的服务（如 npm run dev、npm start、python app.py 等），必须用后台方式运行，例如：nohup npm run dev > /tmp/app.log 2>&1 & 然后输出服务已在后台启动，PID 为 xxx。'

export class ClaudeRunner extends BaseRunner {
  static isAvailable() { return existsSync(CLAUDE_BIN) }

  get displayName() { return 'Claude Code' }

  get binPath() { return NODE_BIN }

  async fetchModels() {
    try {
      const out = execSync(`${NODE_BIN} ${CLAUDE_BIN} models`, { encoding: 'utf8', timeout: 10000 })
      return out.trim().split('\n').map(l => l.trim()).filter(Boolean)
    } catch {
      return []
    }
  }

  buildArgs({ prompt, resumeSessionId, model }) {
    const args = [
      CLAUDE_BIN,
      '-p', prompt,
      '--output-format', 'stream-json',
      '--verbose',
      '--dangerously-skip-permissions',
      '--append-system-prompt', SYSTEM_PROMPT,
    ]
    if (model) args.push('--model', model)
    if (resumeSessionId) args.push('--resume', resumeSessionId)
    return args
  }

  buildEnv() {
    return {
      ...process.env,
      CLAUDECODE: '',
      HOOK_SERVER_URL: process.env.HOOK_SERVER_URL || 'http://127.0.0.1:7701',
    }
  }
}
