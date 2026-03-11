import { describe, it, beforeEach, afterEach, mock } from 'node:test'
import assert, { strictEqual } from 'node:assert'

// We need to mock global.fetch before importing the module
let originalFetch
let mockFetch

beforeEach(() => {
  originalFetch = global.fetch
  mockFetch = mock.fn()
  global.fetch = mockFetch
})

afterEach(() => {
  global.fetch = originalFetch
  mock.restoreAll()
})

// Import after setup — the module uses fetch at call time, not import time
const {
  bbHeaders,
  testConnection,
  getPrInfo,
  getPrDiff,
  postInlineComment,
  postGeneralComment
} = await import('../src/bitbucket.js')

describe('bbHeaders', () => {

  it('generuje poprawny nagłówek Basic Auth', () => {
    const headers = bbHeaders('user@test.com', 'token123')
    const expected = Buffer.from('user@test.com:token123').toString('base64')
    strictEqual(headers['Authorization'], `Basic ${expected}`)
  })

  it('ustawia Content-Type i Accept na JSON', () => {
    const headers = bbHeaders('a', 'b')
    strictEqual(headers['Content-Type'], 'application/json')
    strictEqual(headers['Accept'], 'application/json')
  })

})

describe('testConnection', () => {

  it('zwraca ok:true przy sukcesie', async () => {
    mockFetch.mock.mockImplementation(() => Promise.resolve({
      ok: true,
      status: 200,
      json: () => Promise.resolve({
        display_name: 'Jan Kowalski',
        links: { avatar: { href: 'https://avatar.url/img.png' } }
      })
    }))

    const result = await testConnection('user@test.com', 'validtoken')
    strictEqual(result.ok, true)
    strictEqual(result.user.displayName, 'Jan Kowalski')
  })

  it('zwraca ok:false przy 401', async () => {
    mockFetch.mock.mockImplementation(() => Promise.resolve({
      ok: false,
      status: 401,
      text: () => Promise.resolve('Unauthorized')
    }))

    const result = await testConnection('user@test.com', 'badtoken')
    strictEqual(result.ok, false)
    assert.ok(result.error.includes('Nieprawidłowe'))
  })

  it('zwraca ok:false przy błędzie sieci', async () => {
    mockFetch.mock.mockImplementation(() => Promise.reject(new Error('Network error')))

    const result = await testConnection('user@test.com', 'token')
    strictEqual(result.ok, false)
    assert.ok(result.error.length > 0)
  })

})

describe('getPrInfo', () => {

  it('zwraca dane PR przy sukcesie', async () => {
    mockFetch.mock.mockImplementation(() => Promise.resolve({
      ok: true,
      json: () => Promise.resolve({
        title: 'Fix bug',
        description: 'Fixes #123',
        author: { display_name: 'Jan' }
      })
    }))

    const pr = await getPrInfo('u@t.com', 'tok', 'ws', 'repo', 42)
    strictEqual(pr.title, 'Fix bug')
  })

  it('rzuca Error przy 404', async () => {
    mockFetch.mock.mockImplementation(() => Promise.resolve({
      ok: false,
      status: 404,
      text: () => Promise.resolve('Not Found')
    }))

    await assert.rejects(
      () => getPrInfo('u@t.com', 'tok', 'ws', 'repo', 999),
      /404/
    )
  })

})

describe('getPrDiff', () => {

  it('zwraca diff jako string', async () => {
    mockFetch.mock.mockImplementation(() => Promise.resolve({
      ok: true,
      text: () => Promise.resolve('diff --git a/file.js b/file.js\n...')
    }))

    const diff = await getPrDiff('u@t.com', 'tok', 'ws', 'repo', 42)
    assert.ok(diff.startsWith('diff --git'))
  })

  it('rzuca Error przy błędzie HTTP', async () => {
    mockFetch.mock.mockImplementation(() => Promise.resolve({
      ok: false,
      status: 500,
      text: () => Promise.resolve('Server Error')
    }))

    await assert.rejects(
      () => getPrDiff('u@t.com', 'tok', 'ws', 'repo', 42),
      /500/
    )
  })

})

describe('postInlineComment', () => {

  it('wysyła poprawny payload', async () => {
    mockFetch.mock.mockImplementation(() => Promise.resolve({
      ok: true,
      json: () => Promise.resolve({ id: 1 })
    }))

    await postInlineComment('u@t.com', 'tok', 'ws', 'repo', 42, {
      path: 'src/file.js',
      line: 10,
      body: 'Uwaga'
    })

    const call = mockFetch.mock.calls[0]
    const body = JSON.parse(call.arguments[1].body)
    strictEqual(body.inline.path, 'src/file.js')
    strictEqual(body.inline.to, 10)
    strictEqual(body.content.raw, 'Uwaga')
  })

})

describe('postGeneralComment', () => {

  it('wysyła poprawny payload', async () => {
    mockFetch.mock.mockImplementation(() => Promise.resolve({
      ok: true,
      json: () => Promise.resolve({ id: 2 })
    }))

    await postGeneralComment('u@t.com', 'tok', 'ws', 'repo', 42, 'Ogólna uwaga')

    const call = mockFetch.mock.calls[0]
    const body = JSON.parse(call.arguments[1].body)
    strictEqual(body.content.raw, 'Ogólna uwaga')
    strictEqual(body.inline, undefined)
  })

})
