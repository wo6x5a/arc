import ngrok from '@ngrok/ngrok'
import { readFileSync, existsSync } from 'fs'
import { join } from 'path'
import { execSync } from 'child_process'

let activeTunnel = null

/**
 * 从工作目录自动检测项目端口
 * 检测顺序：package.json scripts → vite.config → next.config → 进程监听端口
 * @param {string} workDir - 项目工作目录
 * @returns {number|null} 检测到的端口号，未找到返回 null
 */
export function detectProjectPort(workDir) {
  if (!workDir) return null

  // 1. 尝试从 package.json scripts 提取端口
  const pkgPath = join(workDir, 'package.json')
  if (existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'))
      const scripts = Object.values(pkg.scripts || {}).join(' ')
      const m = scripts.match(/(?:--port[= ]|PORT=|:)(\d{4,5})\b/)
      if (m) return parseInt(m[1])
    } catch {}
  }

  // 2. 尝试从 vite.config.* 提取端口
  for (const name of ['vite.config.ts', 'vite.config.js', 'vite.config.mjs']) {
    const p = join(workDir, name)
    if (existsSync(p)) {
      try {
        const content = readFileSync(p, 'utf8')
        const m = content.match(/port\s*:\s*(\d{4,5})/)
        if (m) return parseInt(m[1])
      } catch {}
    }
  }

  // 3. 尝试从 next.config.* 提取端口（next dev -p XXXX 形式较少，但尝试）
  // Next.js 默认 3000，若 package.json 无特殊配置则用默认
  const nextConfig = join(workDir, 'next.config.js')
  const nextConfigTs = join(workDir, 'next.config.ts')
  if (existsSync(nextConfig) || existsSync(nextConfigTs)) {
    return 3000
  }

  // 4. 检测当前进程中监听的本地端口（lsof 方式）
  try {
    const output = execSync('lsof -iTCP -sTCP:LISTEN -P -n 2>/dev/null', { timeout: 3000 }).toString()
    const ports = []
    for (const line of output.split('\n')) {
      const m = line.match(/:(\d{4,5})\s*\(LISTEN\)/)
      if (m) {
        const p = parseInt(m[1])
        // 排除常见系统/数据库端口，只保留典型 web 端口
        if (p >= 1024 && p <= 65535 && ![3306, 5432, 5672, 6379, 27017, 27018].includes(p)) {
          ports.push(p)
        }
      }
    }
    // 优先选择常见 web 端口
    const preferred = [3000, 3001, 4000, 5000, 5173, 8080, 8000, 8888, 8888, 4173]
    for (const p of preferred) {
      if (ports.includes(p)) return p
    }
    if (ports.length > 0) return ports[0]
  } catch {}

  return null
}

/**
 * 开启 ngrok 隧道，暴露本地端口
 * @param {number} port - 本地端口号
 * @param {string} authToken - ngrok authtoken（可选，从环境变量 NGROK_AUTHTOKEN 读取）
 * @returns {string} 公网 URL
 */
export async function startTunnel(port, authToken) {
  if (activeTunnel) {
    await activeTunnel.close()
    activeTunnel = null
  }

  const token = authToken || process.env.NGROK_AUTHTOKEN
  if (token) {
    await ngrok.authtoken(token)
  }

  activeTunnel = await ngrok.forward({
    addr: port,
    request_header_add: [`host:localhost:${port}`],
  })
  return activeTunnel.url()
}

/**
 * 关闭当前隧道
 */
export async function stopTunnel() {
  if (activeTunnel) {
    await activeTunnel.close()
    activeTunnel = null
  }
}

/**
 * 获取当前隧道 URL（若存在）
 */
export function getTunnelUrl() {
  return activeTunnel ? activeTunnel.url() : null
}
