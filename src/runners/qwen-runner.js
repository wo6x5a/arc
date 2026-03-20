import { existsSync } from 'fs'
import { execSync } from 'child_process'
import { BaseRunner } from './base-runner.js'

const QWEN_BIN = process.env.QWEN_BIN || 'qwen'

function _binExists(bin) {
  if (bin.startsWith('/') || bin.startsWith('./')) return existsSync(bin)
  try { execSync(`which ${bin}`, { stdio: 'ignore' }); return true } catch { return false }
}

/**
 * Qwen Code Runner
 *
 * 实测验证（2026-03-10）：
 * - 可执行文件为 `qwen`
 * - stream-json 格式与 Claude 完全一致（type: system/assistant/result，message.content[].type: text）
 * - session_id 为 UUID，--resume <uuid> 可恢复上下文
 * - 权限跳过用 -y（yolo 模式）
 * - prompt 为 positional 参数（-p 已废弃），放在参数末尾
 * - 不需要 CLAUDECODE='' 环境变量
 */
export class QwenRunner extends BaseRunner {
  static isAvailable() { return _binExists(QWEN_BIN) }

  get displayName() { return 'Qwen Code' }

  get binPath() { return QWEN_BIN }

  async fetchModels() {
    try {
      const out = execSync(`${QWEN_BIN} models`, { encoding: 'utf8', timeout: 10000 })
      return out.trim().split('\n').map(l => l.trim()).filter(Boolean)
    } catch {
      return []
    }
  }

  buildArgs({ prompt, resumeSessionId, model }) {
    const args = [
      '--output-format', 'stream-json',
      '-y',  // yolo 模式：自动接受所有操作
    ]
    if (model) args.push('--model', model)
    if (resumeSessionId) {
      args.push('--resume', resumeSessionId)
    }
    // prompt 为 positional 参数，放最后
    args.push(prompt)
    return args
  }

  // handleMessage 继承基类默认实现（格式与 Claude 完全相同，实测验证）
}
