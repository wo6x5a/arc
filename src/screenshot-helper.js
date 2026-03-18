import os from 'os'
import path from 'path'
import fs from 'fs'

/**
 * 截图指定 URL，返回图片 Buffer
 * 依赖 playwright（optionalDependency），未安装时抛出友好错误
 */
export async function takeScreenshot(url, options = {}) {
  let chromium
  try {
    ;({ chromium } = await import('playwright'))
  } catch {
    throw new Error('截图功能需要安装 playwright：npm install -g playwright && npx playwright install chromium')
  }

  const { width = 1280, height = 800, timeout = 15000 } = options
  const tmpPath = path.join(os.tmpdir(), `screenshot_${Date.now()}.png`)
  let browser

  try {
    browser = await chromium.launch({ headless: true })
    const page = await browser.newPage({ viewport: { width, height } })
    await page.goto(url, { waitUntil: 'networkidle', timeout })
    await page.screenshot({ path: tmpPath, fullPage: false })
    const buf = fs.readFileSync(tmpPath)
    return buf
  } finally {
    if (browser) await browser.close()
    if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath)
  }
}
