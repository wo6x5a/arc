import { realpathSync } from 'fs'
import { BaseRunner } from './base-runner.js'

const NODE_BIN = realpathSync(process.execPath)
const CLAUDE_BIN = realpathSync(process.env.CLAUDE_BIN || '/Users/chenwu.lcw/.npm-global/bin/claude')

const SYSTEM_PROMPT = '重要：如果需要启动长期运行的服务（如 npm run dev、npm start、python app.py 等），必须用后台方式运行，例如：nohup npm run dev > /tmp/app.log 2>&1 & 然后输出服务已在后台启动，PID 为 xxx。'

export class ClaudeRunner extends BaseRunner {
  get displayName() { return 'Claude Code' }

  get binPath() { return NODE_BIN }

  buildArgs({ prompt, resumeSessionId }) {
    const args = [
      CLAUDE_BIN,
      '-p', prompt,
      '--output-format', 'stream-json',
      '--verbose',
      '--dangerously-skip-permissions',
      '--append-system-prompt', SYSTEM_PROMPT,
    ]
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
