import 'dotenv/config'
import { SessionManager } from './session.js'

export const sessionManager = new SessionManager()

// 全局工作目录（所有 Bot 共享，切换时调用 setCurrentWorkDir）
export let currentWorkDir = process.env.WORK_DIR || process.cwd()
export function setCurrentWorkDir(path) {
  currentWorkDir = path
}

// Per-chatId 状态（Telegram chatId 是数字，飞书 chatId 是 oc_ 字符串，天然不冲突）
export const chatBackendMap = new Map()    // chatId -> 'claude'|'gemini'|'qwen'|'codex'
export const claudeSessionMap = new Map()  // chatId -> sessionId（多轮对话恢复）
export const pendingCustomDir = new Map()  // chatId -> messageId（仅 Telegram 用）

// 全局配置
export const projects = (() => {
  try {
    return JSON.parse(process.env.PROJECTS || '[]')
  } catch {
    console.warn('警告：PROJECTS 环境变量格式错误，请检查 .env 文件中的 JSON 格式')
    return []
  }
})()

export const defaultBackend = process.env.DEFAULT_AI_BACKEND || 'claude'

// Telegram 白名单（数字 userId）
export const allowedUserIds = (process.env.ALLOWED_USER_IDS || '').split(',').map(id => parseInt(id.trim()))
