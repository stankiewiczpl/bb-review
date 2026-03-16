/**
 * Express server with REST API, SSE streaming, and static file serving.
 */

import express from 'express'
import { existsSync, statSync, readdirSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { testConnection, getPrInfo, getPrDiff, postInlineComment, postGeneralComment, approvePr, requestChangesPr } from './bitbucket.js'
import { reviewWithClaude } from './claude.js'
import { parseDiffFiles } from './parser.js'
import { extractTicketKey, getJiraTicket } from './jira.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const PROJECT_ROOT = join(__dirname, '..')
const LOGS_DIR = join(PROJECT_ROOT, 'logs')

// In-memory state
let currentReview = null   // { prInfo, diffFiles, review, logPath }
let sseClients = []
let activeProcess = null

/**
 * Create Express app (for testing — no listen).
 */
export function createApp() {
  const app = express()
  app.use(express.json())
  app.use(express.static(join(PROJECT_ROOT, 'public')))

  // ── SSE ──────────────────────────────────────────────────────

  app.get('/api/stream', (req, res) => {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive'
    })
    res.write('\n')
    sseClients.push(res)
    req.on('close', () => {
      sseClients = sseClients.filter(c => c !== res)
    })
  })

  // ── Config test ──────────────────────────────────────────────

  app.post('/api/config/test', async (req, res) => {
    const { email, token } = req.body
    if (!email || !token) {
      return res.json({ ok: false, error: 'Email i token są wymagane' })
    }
    const result = await testConnection(email, token)
    res.json(result)
  })

  // ── Validate path ────────────────────────────────────────────

  app.post('/api/validate-path', (req, res) => {
    const { path } = req.body
    if (!path) {
      return res.json({ ok: false, error: 'Ścieżka jest wymagana' })
    }
    try {
      if (existsSync(path) && statSync(path).isDirectory()) {
        res.json({ ok: true })
      } else {
        res.json({ ok: false, error: 'Katalog nie istnieje' })
      }
    } catch {
      res.json({ ok: false, error: 'Katalog nie istnieje' })
    }
  })

  // ── Start review (async pipeline) ───────────────────────────

  app.post('/api/start-review', (req, res) => {
    let { workspace, repo, prId, email, token, repoPath, jiraDomain, jiraToken } = req.body

    if (!workspace || !repo || !prId || !email || !token) {
      return res.json({ ok: false, error: 'Brakuje wymaganych pól' })
    }

    // Parse PR URL if provided instead of raw ID
    if (typeof prId === 'string' && prId.includes('bitbucket.org')) {
      const m = prId.match(/\/([^/]+)\/([^/]+)\/pull-requests\/(\d+)/)
      if (m) {
        workspace = m[1]
        repo = m[2]
        prId = parseInt(m[3], 10)
      }
    }
    prId = parseInt(prId, 10)

    // Return immediately, run pipeline in background
    res.json({ ok: true })

    runReviewPipeline({ workspace, repo, prId, email, token, repoPath, jiraDomain, jiraToken })
  })

  // ── Get current review ──────────────────────────────────────

  app.get('/api/review', (req, res) => {
    if (!currentReview) {
      return res.json({ error: 'Brak aktywnego review' })
    }
    res.json(currentReview)
  })

  // ── Submit comment ──────────────────────────────────────────

  app.post('/api/submit-comment', async (req, res) => {
    const { comment, email, token, workspace, repo, prId } = req.body

    if (!comment || !comment.body) {
      return res.json({ ok: false, error: 'Komentarz jest wymagany' })
    }

    try {
      if (comment.type === 'inline') {
        // Validate line is in range
        if (currentReview && currentReview.diffFiles) {
          const file = currentReview.diffFiles.find(f => f.path === comment.path)
          if (file && comment.line > file.maxNewLine) {
            return res.json({
              ok: false,
              error: `Linia ${comment.line} poza zakresem diff (max: ${file.maxNewLine})`
            })
          }
        }
        await postInlineComment(email, token, workspace, repo, prId, {
          path: comment.path,
          line: comment.line,
          body: comment.body
        })
      } else {
        await postGeneralComment(email, token, workspace, repo, prId, comment.body)
      }

      // Update log
      if (currentReview && currentReview.logPath) {
        updateLogResults(currentReview.logPath, comment, 'approved')
      }

      res.json({ ok: true })
    } catch (err) {
      res.json({ ok: false, error: err.message })
    }
  })

  // ── PR verdict (approve / request changes) ─────────────────

  app.post('/api/pr-verdict', async (req, res) => {
    const { action, email, token, workspace, repo, prId } = req.body

    if (!email || !token || !workspace || !repo || !prId) {
      return res.json({ ok: false, error: 'Brakuje wymaganych pól' })
    }

    try {
      if (action === 'approve') {
        await approvePr(email, token, workspace, repo, prId)
      } else if (action === 'request-changes') {
        await requestChangesPr(email, token, workspace, repo, prId)
      } else {
        return res.json({ ok: false, error: 'Nieznana akcja' })
      }
      res.json({ ok: true })
    } catch (err) {
      res.json({ ok: false, error: err.message })
    }
  })

  // ── Cancel ──────────────────────────────────────────────────

  app.post('/api/cancel', (req, res) => {
    if (activeProcess) {
      activeProcess.kill()
      activeProcess = null
    }
    currentReview = null
    res.json({ ok: true })
  })

  // ── Logs ────────────────────────────────────────────────────

  app.get('/api/logs', (req, res) => {
    try {
      if (!existsSync(LOGS_DIR)) {
        return res.json([])
      }

      const files = readdirSync(LOGS_DIR).filter(f => f.endsWith('.json'))
      const logs = files.map(f => {
        try {
          const data = JSON.parse(readFileSync(join(LOGS_DIR, f), 'utf-8'))
          return {
            filename: f,
            timestamp: data.timestamp,
            workspace: data.workspace,
            repo: data.repo,
            prId: data.prId,
            prTitle: data.prTitle,
            commentsCount: data.review?.comments?.length || 0
          }
        } catch {
          return null
        }
      }).filter(Boolean)

      logs.sort((a, b) => (b.timestamp || '').localeCompare(a.timestamp || ''))
      res.json(logs)
    } catch {
      res.json([])
    }
  })

  app.get('/api/logs/check/:workspace/:repo/:prId', (req, res) => {
    const { workspace, repo, prId } = req.params
    try {
      if (!existsSync(LOGS_DIR)) {
        return res.json({ found: false })
      }

      const files = readdirSync(LOGS_DIR)
        .filter(f => f.startsWith(`${prId}_`) && f.endsWith('.json'))

      if (files.length === 0) {
        return res.json({ found: false })
      }

      // Find latest
      let lastTimestamp = ''
      for (const f of files) {
        try {
          const data = JSON.parse(readFileSync(join(LOGS_DIR, f), 'utf-8'))
          if (data.timestamp > lastTimestamp) {
            lastTimestamp = data.timestamp
          }
        } catch { /* skip */ }
      }

      res.json({ found: true, count: files.length, lastReview: lastTimestamp })
    } catch {
      res.json({ found: false })
    }
  })

  app.get('/api/logs/:filename', (req, res) => {
    const filepath = join(LOGS_DIR, req.params.filename)
    if (!existsSync(filepath)) {
      return res.status(404).json({ error: 'Log nie znaleziony' })
    }
    try {
      const data = JSON.parse(readFileSync(filepath, 'utf-8'))
      res.json(data)
    } catch {
      res.status(500).json({ error: 'Błąd odczytu logu' })
    }
  })

  return app
}

// ── Review pipeline ─────────────────────────────────────────────

async function runReviewPipeline({ workspace, repo, prId, email, token, repoPath, jiraDomain, jiraToken }) {
  try {
    sendSSE('status', { step: 'pr-loading', message: 'Pobieranie informacji o PR...' })

    const prInfo = await getPrInfo(email, token, workspace, repo, prId)
    sendSSE('pr-loaded', {
      title: prInfo.title,
      author: prInfo.author?.display_name,
      description: prInfo.description
    })

    sendSSE('status', { step: 'diff-loading', message: 'Pobieranie diff...' })
    const rawDiff = await getPrDiff(email, token, workspace, repo, prId)
    const diffFiles = parseDiffFiles(rawDiff)
    sendSSE('diff-loaded', { filesCount: diffFiles.length })

    // Jira ticket (optional)
    let jiraTicket = null
    if (jiraDomain && jiraToken) {
      const ticketKey = extractTicketKey(prInfo.title) || extractTicketKey(prInfo.source?.branch?.name)
      if (ticketKey) {
        sendSSE('status', { step: 'jira-loading', message: `Pobieranie ticketa Jira: ${ticketKey}...` })
        jiraTicket = await getJiraTicket(email, jiraToken, jiraDomain, ticketKey)
        if (jiraTicket) {
          sendSSE('jira-loaded', { key: jiraTicket.key, summary: jiraTicket.summary })
        } else {
          sendSSE('status', { step: 'jira-skipped', message: `Nie udało się pobrać ticketa ${ticketKey}` })
        }
      }
    }

    sendSSE('status', { step: 'claude-working', message: 'Claude analizuje kod...' })
    const result = await reviewWithClaude(
      prInfo.title,
      prInfo.description || '',
      diffFiles,
      (event) => {
        if (event.type === 'text') {
          sendSSE('claude-chunk', { text: event.text })
        } else if (event.type === 'tool') {
          sendSSE('claude-tool', { name: event.name, input: event.input })
        } else if (event.type === 'cost') {
          sendSSE('claude-cost', { cost_usd: event.cost_usd, duration_ms: event.duration_ms })
        }
      },
      repoPath,
      undefined,
      jiraTicket
    )

    const logPath = saveLog(workspace, repo, prId, {
      prTitle: prInfo.title,
      prAuthor: prInfo.author?.display_name,
      prompt: result.prompt,
      claudeRaw: result.claudeRaw,
      claudeStderr: result.claudeStderr,
      review: result.review,
      diffFiles: diffFiles.map(f => ({ path: f.path, maxNewLine: f.maxNewLine }))
    })

    currentReview = {
      prInfo,
      diffFiles,
      review: result.review,
      logPath
    }

    sendSSE('review-ready', {
      summary: result.review.summary,
      comments: result.review.comments,
      diffFiles: diffFiles.map(f => ({ path: f.path, diff: f.diff, maxNewLine: f.maxNewLine }))
    })
  } catch (err) {
    sendSSE('error', { message: err.message })
  }
}

// ── SSE helper ──────────────────────────────────────────────────

function sendSSE(event, data) {
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`
  for (const client of sseClients) {
    try {
      client.write(payload)
    } catch { /* client disconnected */ }
  }
}

// ── Log helpers ─────────────────────────────────────────────────

function saveLog(workspace, repo, prId, logData) {
  mkdirSync(LOGS_DIR, { recursive: true })
  const now = new Date()
  const ts = now.toISOString().replace(/[:.]/g, '-').slice(0, 19)
  const filename = `${prId}_${ts}.json`
  const filepath = join(LOGS_DIR, filename)

  const fullLog = {
    timestamp: now.toISOString(),
    workspace,
    repo,
    prId,
    ...logData,
    results: { details: [] }
  }

  writeFileSync(filepath, JSON.stringify(fullLog, null, 2), 'utf-8')
  return filepath
}

function updateLogResults(logPath, comment, action) {
  try {
    const data = JSON.parse(readFileSync(logPath, 'utf-8'))
    if (!data.results) data.results = { details: [] }
    data.results.details.push({
      comment: { type: comment.type, path: comment.path, line: comment.line, body: comment.body },
      action,
      timestamp: new Date().toISOString()
    })
    writeFileSync(logPath, JSON.stringify(data, null, 2), 'utf-8')
  } catch { /* log update is non-critical */ }
}

// ── Start server ────────────────────────────────────────────────

export async function startServer({ port }) {
  const app = createApp()
  return new Promise(resolve => {
    const server = app.listen(port, () => resolve(server))
  })
}
