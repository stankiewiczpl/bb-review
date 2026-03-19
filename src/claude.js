/**
 * Claude Code CLI subprocess module.
 * Builds review prompt, spawns claude CLI, parses JSON response.
 */

import { spawn } from 'node:child_process'
import { readFileSync, existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const PROJECT_ROOT = join(__dirname, '..')

const TIMEOUT_MS = 900_000 // 15 minutes

const JSON_FORMAT_INSTRUCTIONS = `
## Format odpowiedzi

Numer linii musi być linią DODANĄ (zaczynającą się od +) lub kontekstową w NOWEJ wersji pliku.
Jeśli uwaga dotyczy całego PR-a (nie konkretnej linii), użyj type="general".

Odpowiadaj WYŁĄCZNIE w formacie JSON, bez żadnego dodatkowego tekstu:
{
  "summary": "Krótkie podsumowanie PR-a (2-3 zdania)",
  "comments": [
    {
      "type": "inline",
      "path": "src/components/Cart.vue",
      "line": 42,
      "body": "Treść komentarza w markdown"
    },
    {
      "type": "general",
      "body": "Ogólna uwaga dotycząca całego PR-a"
    }
  ]
}
`

const PROJECT_CONTEXT_INSTRUCTIONS = `
## Kontekst projektu

Masz dostęp do pełnego kodu projektu w katalogu roboczym.
Używaj go jako kontekstu do review:
- Sprawdzaj importy i zależności zmienionych plików
- Weryfikuj spójność z konwencjami projektu
- Sprawdzaj czy typy/interfejsy są poprawnie użyte
- Szukaj potencjalnych regresji w powiązanych plikach

NIE komentuj plików, które nie są częścią diff-a.
Skup się WYŁĄCZNIE na zmianach w PR, ale UŻYWAJ reszty kodu
jako kontekstu do oceny tych zmian.
`

const SERENA_MCP_INSTRUCTIONS = `
## Narzędzia MCP

Pracujesz w katalogu projektu — najpierw sprawdź ustawienia projektu i dostępne narzędzia MCP.
Jeśli masz dostęp do narzędzi Serena MCP (np. serena_search_symbol, serena_find_references, serena_get_definition, serena_get_file_contents itp.) — wykorzystaj je jako GŁÓWNE narzędzie do analizy kodu.
Serena daje Ci semantyczne przeszukiwanie: definicje, referencje, symbole, hierarchie klas i zależności.
Używaj Serena zamiast zwykłego Grep/Read tam gdzie to możliwe — da to bardziej precyzyjne i kontekstowe review.
`

/**
 * Load the review-agent.md prompt file.
 * @param {string} [promptPath] - Optional custom path to review-agent.md
 * @returns {string} Prompt content
 */
export function loadReviewPrompt(promptPath) {
  const path = promptPath || join(PROJECT_ROOT, 'review-agent.md')
  if (!existsSync(path)) {
    throw new Error(
      `Nie znaleziono pliku review-agent.md w: ${path}\n` +
      'Utwórz plik z instrukcjami dla Claude dotyczącymi code review.'
    )
  }
  return readFileSync(path, 'utf-8')
}

/**
 * Build the full prompt for Claude.
 * @param {string} prTitle - PR title
 * @param {string} prDescription - PR description
 * @param {Array<{path: string, diff: string}>} diffFiles - Parsed diff files
 * @param {string} [repoPath] - Optional local repo path for --cwd context
 * @param {string} [promptPath] - Optional custom path to review-agent.md
 * @param {object} [jiraTicket] - Optional Jira ticket data
 * @param {boolean} [useSerena] - Whether to include Serena MCP instructions
 * @returns {string} Full prompt
 */
export function buildPrompt(prTitle, prDescription, diffFiles, repoPath, promptPath, jiraTicket, useSerena) {
  const reviewPrompt = loadReviewPrompt(promptPath)

  let diffSection = ''
  let totalChars = 0
  const MAX_DIFF_CHARS = 80_000

  for (const file of diffFiles) {
    const entry = `\n### Plik: ${file.path}\n\`\`\`diff\n${file.diff}\`\`\`\n`
    if (totalChars + entry.length > MAX_DIFF_CHARS) {
      diffSection += `\n\n⚠️ Diff obcięty — przekroczono limit ${MAX_DIFF_CHARS} znaków. Pominięto ${diffFiles.length - diffFiles.indexOf(file)} plików.\n`
      break
    }
    diffSection += entry
    totalChars += entry.length
  }

  let prompt = reviewPrompt + '\n\n'
  prompt += JSON_FORMAT_INSTRUCTIONS + '\n'

  if (repoPath) {
    prompt += PROJECT_CONTEXT_INSTRUCTIONS + '\n'
    if (useSerena) {
      prompt += SERENA_MCP_INSTRUCTIONS + '\n'
    }
  }

  if (jiraTicket) {
    prompt += `## Ticket Jira: ${jiraTicket.key}\n\n`
    prompt += `**Typ:** ${jiraTicket.type}\n`
    prompt += `**Status:** ${jiraTicket.status}\n`
    prompt += `**Tytuł:** ${jiraTicket.summary}\n\n`
    if (jiraTicket.description) {
      prompt += `**Opis zgłoszenia:**\n${jiraTicket.description}\n\n`
    }
  }

  prompt += `## Pull Request\n\n`
  prompt += `**Tytuł:** ${prTitle}\n\n`
  if (prDescription) {
    prompt += `**Opis:**\n${prDescription}\n\n`
  }
  prompt += `## Diff plików\n${diffSection}`

  return prompt
}

/**
 * Run Claude Code CLI to review a PR.
 * @param {string} prTitle
 * @param {string} prDescription
 * @param {Array} diffFiles
 * @param {function} onEvent - Called with {type, text} for streaming progress
 * @param {string} [repoPath] - Optional local repo path
 * @param {string} [promptPath] - Optional path to review-agent.md
 * @param {object} [jiraTicket] - Optional Jira ticket data
 * @param {boolean} [useSerena] - Whether to enable Serena MCP tools
 * @returns {Promise<{prompt: string, claudeRaw: string, claudeStderr: string, review: object}>}
 */
export async function reviewWithClaude(prTitle, prDescription, diffFiles, onEvent, repoPath, promptPath, jiraTicket, useSerena) {
  const prompt = buildPrompt(prTitle, prDescription, diffFiles, repoPath, promptPath, jiraTicket, useSerena)

  const allowedTools = useSerena ? 'mcp__serena__*,Read,Grep,Glob' : 'Read,Grep,Glob'
  const args = ['-p', '--output-format', 'stream-json', '--verbose', '--include-partial-messages', '--allowedTools', allowedTools]
  if (repoPath) {
    args.push('--add-dir', repoPath)
  }

  return new Promise((resolve, reject) => {
    const proc = spawn('claude', args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      cwd: repoPath || undefined
    })

    let resultText = ''
    let stderrOutput = ''
    let lineBuffer = ''
    let currentToolName = null
    let currentToolInput = ''

    const timeout = setTimeout(() => {
      proc.kill()
      reject(new Error(`Claude timeout po ${TIMEOUT_MS / 1000}s`))
    }, TIMEOUT_MS)

    proc.stdout.on('data', (chunk) => {
      lineBuffer += chunk.toString()
      const lines = lineBuffer.split('\n')
      lineBuffer = lines.pop()

      for (const line of lines) {
        if (!line.trim()) continue
        try {
          const event = JSON.parse(line)
          if (event.type === 'stream_event') {
            const inner = event.event
            if (inner.type === 'content_block_delta') {
              if (inner.delta?.type === 'text_delta' && inner.delta.text) {
                if (onEvent) onEvent({ type: 'text', text: inner.delta.text })
              } else if (inner.delta?.type === 'input_json_delta' && inner.delta.partial_json) {
                currentToolInput += inner.delta.partial_json
              }
            } else if (inner.type === 'content_block_start') {
              if (inner.content_block?.type === 'tool_use') {
                currentToolName = inner.content_block.name
                currentToolInput = ''
              }
            } else if (inner.type === 'content_block_stop') {
              if (currentToolName) {
                let input = null
                try { input = JSON.parse(currentToolInput) } catch { /* ignore */ }
                if (onEvent) onEvent({ type: 'tool', name: currentToolName, input })
                currentToolName = null
                currentToolInput = ''
              }
            }
          } else if (event.type === 'system') {
            if (onEvent) onEvent({ type: 'system', model: event.model, tools: event.tools })
          } else if (event.type === 'assistant') {
            const msg = event.message
            if (msg?.content) {
              for (const block of msg.content) {
                if (block.type === 'tool_result') {
                  if (onEvent) onEvent({ type: 'tool_result', name: block.tool_use_id, content: block.content })
                } else if (block.type === 'tool_use') {
                  if (onEvent) onEvent({ type: 'tool_result', name: block.name, content: block.input })
                }
              }
            }
          } else if (event.type === 'user') {
            if (event.message?.content) {
              for (const block of event.message.content) {
                if (block.type === 'tool_result') {
                  const text = Array.isArray(block.content)
                    ? block.content.filter(c => c.type === 'text').map(c => c.text).join('\n')
                    : (typeof block.content === 'string' ? block.content : '')
                  if (text && onEvent) onEvent({ type: 'tool_result', tool_use_id: block.tool_use_id, content: text })
                }
              }
            }
          } else if (event.type === 'result') {
            resultText = event.result
            if (onEvent) {
              onEvent({
                type: 'cost',
                cost_usd: event.total_cost_usd,
                duration_ms: event.duration_ms,
                input_tokens: event.usage?.input_tokens,
                output_tokens: event.usage?.output_tokens,
                cache_read: event.usage?.cache_read_input_tokens,
                cache_creation: event.usage?.cache_creation_input_tokens
              })
            }
          }
        } catch { /* skip unparseable lines */ }
      }
    })

    proc.stderr.on('data', (chunk) => {
      stderrOutput += chunk.toString()
    })

    proc.on('close', (code) => {
      clearTimeout(timeout)

      if (lineBuffer.trim()) {
        try {
          const event = JSON.parse(lineBuffer)
          if (event.type === 'result') {
            resultText = event.result
          }
        } catch { /* ignore */ }
      }

      if (code !== 0) {
        reject(new Error(`Claude zakończył się z kodem ${code}. Stderr: ${stderrOutput.slice(0, 500)}`))
        return
      }

      if (!resultText) {
        reject(new Error('Claude nie zwrócił wyniku'))
        return
      }

      try {
        const review = parseClaudeResponse(resultText)
        resolve({
          prompt,
          claudeRaw: resultText,
          claudeStderr: stderrOutput,
          review
        })
      } catch (err) {
        reject(err)
      }
    })

    proc.on('error', (err) => {
      clearTimeout(timeout)
      reject(new Error(`Nie udało się uruchomić claude: ${err.message}`))
    })

    proc.stdin.write(prompt)
    proc.stdin.end()
  })
}

/**
 * Parse JSON from Claude's response.
 * Handles: ```json blocks, raw JSON, JSON surrounded by text.
 */
export function parseClaudeResponse(raw) {
  // Try ```json ... ``` block first
  const jsonBlockMatch = raw.match(/```json\s*(\{.*?\})\s*```/s)
  if (jsonBlockMatch) {
    try {
      return JSON.parse(jsonBlockMatch[1])
    } catch { /* fall through */ }
  }

  // Try first { to last }
  const braceMatch = raw.match(/(\{.*\})/s)
  if (braceMatch) {
    try {
      return JSON.parse(braceMatch[1])
    } catch { /* fall through */ }
  }

  throw new Error(
    `Nie udało się sparsować JSON z odpowiedzi Claude.\n` +
    `Pierwsze 500 znaków: ${raw.slice(0, 500)}`
  )
}
