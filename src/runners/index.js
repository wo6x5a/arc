import { ClaudeRunner } from './claude-runner.js'
import { GeminiRunner } from './gemini-runner.js'
import { QwenRunner } from './qwen-runner.js'
import { CodexRunner } from './codex-runner.js'

/**
 * AI Runner 注册表
 * key: 后端标识符（用于 .env 配置和 Telegram 切换命令）
 * label: Telegram 显示名称
 * Runner: 对应的 Runner 类
 */
export const RUNNERS = {
  claude: { Runner: ClaudeRunner, label: 'Claude Code', emoji: '🤖' },
  gemini: { Runner: GeminiRunner, label: 'Gemini CLI',  emoji: '✨' },
  qwen:   { Runner: QwenRunner,   label: 'Qwen Code',   emoji: '🌟' },
  codex:  { Runner: CodexRunner,  label: 'Codex CLI',   emoji: '⚡' },
}

/**
 * 工厂函数：根据后端名称创建 Runner 实例
 * @param {string} name  后端名称（'claude' | 'gemini' | 'qwen' | 'codex'）
 * @param {string} workDir 工作目录
 * @returns {BaseRunner}
 */
export function getRunner(name, workDir) {
  const entry = RUNNERS[name] || RUNNERS.claude
  return new entry.Runner(workDir)
}

export { ClaudeRunner, GeminiRunner, QwenRunner, CodexRunner }
