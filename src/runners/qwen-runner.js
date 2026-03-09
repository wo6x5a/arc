import { BaseRunner } from './base-runner.js'

const QWEN_BIN = process.env.QWEN_BIN || 'qwen'

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
  get displayName() { return 'Qwen Code' }

  get binPath() { return QWEN_BIN }

  buildArgs({ prompt, resumeSessionId }) {
    const args = [
      '--output-format', 'stream-json',
      '-y',  // yolo 模式：自动接受所有操作
    ]
    if (resumeSessionId) {
      args.push('--resume', resumeSessionId)
    }
    // prompt 为 positional 参数，放最后
    args.push(prompt)
    return args
  }

  // handleMessage 继承基类默认实现（格式与 Claude 完全相同，实测验证）
}
