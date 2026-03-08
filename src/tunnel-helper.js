import ngrok from '@ngrok/ngrok'

let activeTunnel = null

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
