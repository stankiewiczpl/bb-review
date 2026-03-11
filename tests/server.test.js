import { describe, it, before, after, mock } from 'node:test'
import assert, { strictEqual } from 'node:assert'
import http from 'node:http'

// Save original fetch for making test HTTP requests to our server
const testFetch = globalThis.fetch

let server
let baseUrl

before(async () => {
  const { createApp } = await import('../src/server.js')
  const app = createApp()

  server = http.createServer(app)
  await new Promise(resolve => server.listen(0, resolve))
  const port = server.address().port
  baseUrl = `http://localhost:${port}`
})

after(() => {
  server.close()
})

describe('POST /api/config/test', () => {

  it('zwraca ok:true przy prawidłowych credentials', async () => {
    const originalFetch = global.fetch
    global.fetch = mock.fn(() => Promise.resolve({
      ok: true,
      status: 200,
      json: () => Promise.resolve({
        display_name: 'Jan',
        links: { avatar: { href: 'https://img.url' } }
      })
    }))

    const res = await testFetch(`${baseUrl}/api/config/test`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'a@b.com', token: 'tok' })
    })
    const data = await res.json()
    strictEqual(data.ok, true)
    strictEqual(data.user.displayName, 'Jan')

    global.fetch = originalFetch
  })

  it('zwraca ok:false przy błędnych credentials', async () => {
    const originalFetch = global.fetch
    global.fetch = mock.fn(() => Promise.resolve({
      ok: false,
      status: 401,
      text: () => Promise.resolve('Unauthorized')
    }))

    const res = await testFetch(`${baseUrl}/api/config/test`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'a@b.com', token: 'bad' })
    })
    const data = await res.json()
    strictEqual(data.ok, false)

    global.fetch = originalFetch
  })

  it('zwraca błąd gdy brak email/token', async () => {
    const res = await testFetch(`${baseUrl}/api/config/test`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({})
    })
    const data = await res.json()
    strictEqual(data.ok, false)
  })

})

describe('POST /api/validate-path', () => {

  it('zwraca ok:true dla istniejącego katalogu', async () => {
    const res = await testFetch(`${baseUrl}/api/validate-path`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: '/tmp' })
    })
    const data = await res.json()
    strictEqual(data.ok, true)
  })

  it('zwraca ok:false dla nieistniejącej ścieżki', async () => {
    const res = await testFetch(`${baseUrl}/api/validate-path`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: '/nonexistent/path/xyz' })
    })
    const data = await res.json()
    strictEqual(data.ok, false)
  })

  it('zwraca ok:false dla pliku (nie katalogu)', async () => {
    const res = await testFetch(`${baseUrl}/api/validate-path`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: '/etc/hosts' })
    })
    const data = await res.json()
    strictEqual(data.ok, false)
  })

})

describe('GET /api/logs', () => {

  it('zwraca tablicę', async () => {
    const res = await testFetch(`${baseUrl}/api/logs`)
    const data = await res.json()
    assert.ok(Array.isArray(data))
  })

})

describe('GET /api/logs/check/:workspace/:repo/:prId', () => {

  it('zwraca found:false gdy brak logów dla PR', async () => {
    const res = await testFetch(`${baseUrl}/api/logs/check/ws/repo/9999`)
    const data = await res.json()
    strictEqual(data.found, false)
  })

})

describe('POST /api/cancel', () => {

  it('zwraca ok:true', async () => {
    const res = await testFetch(`${baseUrl}/api/cancel`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' }
    })
    const data = await res.json()
    strictEqual(data.ok, true)
  })

})

describe('GET /api/review', () => {

  it('zwraca błąd gdy brak aktywnego review', async () => {
    const res = await testFetch(`${baseUrl}/api/review`)
    const data = await res.json()
    assert.ok(data.error)
  })

})

describe('GET /api/stream (SSE)', () => {

  it('łączy się i zwraca text/event-stream', async () => {
    const controller = new AbortController()
    const res = await testFetch(`${baseUrl}/api/stream`, { signal: controller.signal })
    strictEqual(res.headers.get('content-type'), 'text/event-stream')
    controller.abort()
  })

})

describe('POST /api/submit-comment', () => {

  it('zwraca błąd gdy brak komentarza', async () => {
    const res = await testFetch(`${baseUrl}/api/submit-comment`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({})
    })
    const data = await res.json()
    strictEqual(data.ok, false)
  })

  it('wysyła general komentarz', async () => {
    const originalFetch = global.fetch
    global.fetch = mock.fn(() => Promise.resolve({
      ok: true,
      json: () => Promise.resolve({ id: 1 })
    }))

    const res = await testFetch(`${baseUrl}/api/submit-comment`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        comment: { type: 'general', body: 'Ogólna uwaga' },
        email: 'a@b.com', token: 'tok', workspace: 'ws', repo: 'repo', prId: 42
      })
    })
    const data = await res.json()
    strictEqual(data.ok, true)

    global.fetch = originalFetch
  })

})
