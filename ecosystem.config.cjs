module.exports = {
  apps: [
    {
      name: 'arc',
      script: 'src/index.js',
      interpreter: 'node',
      // 崩溃后自动重启，最多连续失败 10 次
      max_restarts: 10,
      // 连续重启间隔（毫秒），防止崩溃循环耗尽资源
      restart_delay: 3000,
      // 进程运行超过此时间（ms）才算"稳定"，低于此时间的崩溃不计入 max_restarts
      min_uptime: 5000,
      // 日志
      out_file: './logs/out.log',
      error_file: './logs/error.log',
      merge_logs: true,
      log_date_format: 'YYYY-MM-DD HH:mm:ss',
      // 环境变量从 .env 文件加载
      env: {
        NODE_ENV: 'production',
      },
    },
  ],
}
