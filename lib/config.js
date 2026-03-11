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
