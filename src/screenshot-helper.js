import { chromium } from 'playwright'
import os from 'os'
import path from 'path'
import fs from 'fs'

/**
 * 截图指定 URL，返回图片 Buffer
 * @param {string} url - 要截图的网页地址
 * @param {object} options - 配置项
 * @param {number} options.width - 视口宽度，默认 1280
 * @param {number} options.height - 视口高度，默认 800
 * @param {number} options.timeout - 页面加载超时（ms），默认 15000
 */
export async function takeScreenshot(url, options = {}) {
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
