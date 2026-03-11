import { describe, it, beforeEach, afterEach } from 'node:test'
import assert, { strictEqual } from 'node:assert'
import { writeFileSync, unlinkSync, existsSync, mkdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const PROJECT_ROOT = join(__dirname, '..')

// Import the functions we can test without spawning a real process
import { parseClaudeResponse, buildPrompt, loadReviewPrompt } from '../src/claude.js'

// Ensure review-agent.md exists for tests
const REVIEW_AGENT_PATH = join(PROJECT_ROOT, 'review-agent.md')
let reviewAgentExisted = false

beforeEach(() => {
  reviewAgentExisted = existsSync(REVIEW_AGENT_PATH)
  if (!reviewAgentExisted) {
    writeFileSync(REVIEW_AGENT_PATH, '# Test Review Agent Prompt\nReview the code.')
  }
})

afterEach(() => {
  if (!reviewAgentExisted && existsSync(REVIEW_AGENT_PATH)) {
    unlinkSync(REVIEW_AGENT_PATH)
  }
})

describe('parseClaudeResponse', () => {

  it('parsuje czysty JSON', () => {
    const json = JSON.stringify({
      summary: 'OK',
      comments: [{ type: 'general', body: 'Dobrze' }]
    })
    const result = parseClaudeResponse(json)
    strictEqual(result.summary, 'OK')
    strictEqual(result.comments.length, 1)
  })

  it('parsuje JSON w bloku ```json```', () => {
    const json = JSON.stringify({ summary: 'OK', comments: [] })
    const response = `Oto moja analiza:\n\`\`\`json\n${json}\n\`\`\`\nTo tyle.`
    const result = parseClaudeResponse(response)
    strictEqual(result.summary, 'OK')
  })

  it('parsuje JSON gdy otoczony tekstem', () => {
    const json = JSON.stringify({ summary: 'Test', comments: [] })
    const response = `Analiza kodu:\n${json}\nKoniec.`
    const result = parseClaudeResponse(response)
    strictEqual(result.summary, 'Test')
  })

  it('rzuca Error gdy brak JSON w odpowiedzi', () => {
    const response = 'Nie wiem co powiedzieć o tym kodzie.'
    assert.throws(
      () => parseClaudeResponse(response),
      /Nie udało się sparsować/
    )
  })

  it('rzuca Error gdy niepoprawny JSON', () => {
    const response = '{ invalid json }'
    assert.throws(
      () => parseClaudeResponse(response),
      /Nie udało się sparsować/
    )
  })

})

describe('loadReviewPrompt', () => {

  it('wczytuje istniejący plik review-agent.md', () => {
    const content = loadReviewPrompt()
    assert.ok(content.length > 0)
  })

  it('rzuca Error dla nieistniejącej ścieżki', () => {
    assert.throws(
      () => loadReviewPrompt('/nonexistent/path/review-agent.md'),
      /Nie znaleziono/
    )
  })

})

describe('buildPrompt', () => {

  const sampleDiffFiles = [
    { path: 'src/file.js', diff: '+const x = 1\n', maxNewLine: 1 }
  ]

  it('zawiera tytuł PR', () => {
    const prompt = buildPrompt('Fix login bug', 'Fixes #42', sampleDiffFiles)
    assert.ok(prompt.includes('Fix login bug'))
  })

  it('zawiera opis PR', () => {
    const prompt = buildPrompt('Title', 'Detailed description', sampleDiffFiles)
    assert.ok(prompt.includes('Detailed description'))
  })

  it('zawiera diff plików', () => {
    const prompt = buildPrompt('Title', '', sampleDiffFiles)
    assert.ok(prompt.includes('src/file.js'))
    assert.ok(prompt.includes('const x = 1'))
  })

  it('obcina diff powyżej 80k znaków', () => {
    const bigDiffFiles = []
    for (let i = 0; i < 100; i++) {
      bigDiffFiles.push({
        path: `src/file${i}.js`,
        diff: '+' + 'x'.repeat(1000) + '\n',
        maxNewLine: 1
      })
    }
    const prompt = buildPrompt('Title', '', bigDiffFiles)
    assert.ok(prompt.includes('obcięty'))
  })

  it('dodaje kontekst projektu gdy repoPath podany', () => {
    const prompt = buildPrompt('Title', '', sampleDiffFiles, '/some/path')
    assert.ok(prompt.includes('Kontekst projektu'))
  })

  it('nie dodaje kontekstu gdy repoPath pusty', () => {
    const prompt = buildPrompt('Title', '', sampleDiffFiles)
    assert.ok(!prompt.includes('Kontekst projektu'))
  })

})
