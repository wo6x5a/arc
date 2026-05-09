import { existsSync, readdirSync, statSync } from 'fs'
import path from 'path'
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

  // Step 5: Work directory
  const wdAns = await inquirer.prompt([{
    type: 'input',
    name: 'WORK_DIR',
    message: 'Default work directory (optional, leave blank for ~/):'  ,
    default: existing.WORK_DIR || '',
  }])
  Object.assign(env, wdAns)

  // Step 5.5: 自动扫描 WORK_DIR 下的子目录，生成 PROJECTS
  const workDir = env.WORK_DIR?.trim()
  if (workDir && existsSync(workDir)) {
    try {
      const subdirs = readdirSync(workDir)
        .map(name => {
          const fullPath = path.join(workDir, name)
          try {
            return statSync(fullPath).isDirectory() ? { name, path: fullPath } : null
          } catch { return null }
        })
        .filter(Boolean)
        .sort((a, b) => a.name.localeCompare(b.name))

      const projects = [
        { name: 'root', path: workDir },
        ...subdirs,
      ]

      const lines = projects.map((p, i) => `  ${i + 1}. ${p.name}  →  ${p.path}`).join('\n')
      console.log(`\n📁 根据 WORK_DIR 自动生成项目列表（${projects.length} 个）：\n${lines}\n`)

      const projAns = await inquirer.prompt([{
        type: 'confirm',
        name: 'useAutoProjects',
        message: '是否使用此项目列表作为 /projects 预设？',
        default: true,
      }])

      if (projAns.useAutoProjects) {
        env.PROJECTS = JSON.stringify(projects)
      }
    } catch (err) {
      console.log('⚠ 扫描 WORK_DIR 子目录失败:', err.message)
    }
  }

  // Write config
  writeEnv(env)
  console.log('\n✅ Config saved to ~/.arc-bot/.env')
  if (env.PROJECTS) {
    console.log(`   PROJECTS 已配置，共 ${JSON.parse(env.PROJECTS).length} 个项目预设`)
  }
  console.log()

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
