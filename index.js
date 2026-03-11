#!/usr/bin/env node

import { execSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import chalk from 'chalk'
import open from 'open'
import { startServer } from './src/server.js'

const __dirname = dirname(fileURLToPath(import.meta.url))

function checkClaude() {
  try {
    execSync('which claude', { stdio: 'ignore' })
  } catch {
    console.error(chalk.red('Nie znaleziono `claude` w PATH.'))
    console.error(chalk.yellow('   Zainstaluj: npm install -g @anthropic-ai/claude-code'))
    console.error(chalk.yellow('   Zaloguj sie: claude auth'))
    process.exit(1)
  }
}

function checkReviewPrompt() {
  const promptPath = join(__dirname, 'review-agent.md')
  if (!existsSync(promptPath)) {
    console.error(chalk.red('Nie znaleziono pliku: review-agent.md'))
    console.error(chalk.yellow('   Utworz plik review-agent.md z system promptem dla Claude.'))
    process.exit(1)
  }
}

function parseArgs() {
  const args = process.argv.slice(2)
  let port = parseInt(process.env.PORT) || 5177

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--port' && args[i + 1]) {
      port = parseInt(args[i + 1])
      i++
    }
  }

  return { port }
}

async function main() {
  checkClaude()
  checkReviewPrompt()

  const { port } = parseArgs()

  console.log(chalk.blue('Bitbucket AI Code Review'))
  console.log(chalk.gray(`   Uruchamiam serwer na porcie ${port}...`))

  await startServer({ port })

  const url = `http://localhost:${port}`
  console.log(chalk.green(`   Serwer dziala: ${url}`))
  console.log(chalk.gray('   Ctrl+C aby zakonczyc\n'))

  await open(url)
}

main().catch(err => {
  console.error(chalk.red('Blad:'), err.message)
  process.exit(1)
})
