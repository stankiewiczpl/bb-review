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

const TIMEOUT_MS = 600_000 // 10 minutes

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
 * @returns {string} Full prompt
 */
export function buildPrompt(prTitle, prDescription, diffFiles, repoPath, promptPath) {
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
 * @param {function} onChunk - Called with each stdout chunk
 * @param {string} [repoPath] - Optional local repo path
 * @param {string} [promptPath] - Optional path to review-agent.md
 * @returns {Promise<{prompt: string, claudeRaw: string, claudeStderr: string, review: object}>}
 */
export async function reviewWithClaude(prTitle, prDescription, diffFiles, onChunk, repoPath, promptPath) {
  const prompt = buildPrompt(prTitle, prDescription, diffFiles, repoPath, promptPath)

  const args = ['-p']
  if (repoPath) {
    args.push('--add-dir', repoPath)
  }

  return new Promise((resolve, reject) => {
    const proc = spawn('claude', args, {
      stdio: ['pipe', 'pipe', 'pipe']
    })

    let rawOutput = ''
    let stderrOutput = ''

    const timeout = setTimeout(() => {
      proc.kill()
      reject(new Error(`Claude timeout po ${TIMEOUT_MS / 1000}s`))
    }, TIMEOUT_MS)

    proc.stdout.on('data', (chunk) => {
      const text = chunk.toString()
      rawOutput += text
      if (onChunk) onChunk(text)
    })

    proc.stderr.on('data', (chunk) => {
      stderrOutput += chunk.toString()
    })

    proc.on('close', (code) => {
      clearTimeout(timeout)

      if (code !== 0) {
        reject(new Error(`Claude zakończył się z kodem ${code}. Stderr: ${stderrOutput.slice(0, 500)}`))
        return
      }

      try {
        const review = parseClaudeResponse(rawOutput)
        resolve({
          prompt,
          claudeRaw: rawOutput,
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
