#!/usr/bin/env node
import { start, stop, restart, logs, status } from '../lib/pm2-manager.js'
import { runWizard } from '../lib/setup-wizard.js'
import { isConfigured, readEnv } from '../lib/config.js'

const USAGE = `Usage: arc-bot [command]

Commands:
  start    Start the bot (runs setup wizard if not configured)
  config   Run setup wizard to reconfigure
  stop     Stop the bot
  restart  Restart the bot
  logs     Show logs
  status   Show process status

  --help, -h  Show this help message
`

const cmd = process.argv[2] ?? 'start'

if (cmd === '--help' || cmd === '-h') {
  console.log(USAGE)
  process.exit(0)
}

switch (cmd) {
  case 'start':
    if (!isConfigured()) {
      // Wizard handles writing .env and optionally calling start()
      await runWizard()
    } else {
      await start(readEnv())
    }
    break

  case 'config':
    // Wizard handles writing .env and optionally calling start()
    await runWizard()
    break

  case 'stop':
    await stop()
    break

  case 'restart':
    await restart()
    break

  case 'logs':
    logs()
    break

  case 'status':
    status()
    break

  default:
    console.error(`Unknown command: ${cmd}\n`)
    console.log(USAGE)
    process.exit(1)
}
