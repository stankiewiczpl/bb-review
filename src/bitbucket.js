/**
 * Bitbucket REST API 2.0 client.
 * Credentials are always passed as function parameters — never stored in module state.
 */

const BB_API = 'https://api.bitbucket.org/2.0'

/**
 * Build Basic Auth headers.
 */
export function bbHeaders(email, token) {
  const credentials = Buffer.from(`${email}:${token}`).toString('base64')
  return {
    'Authorization': `Basic ${credentials}`,
    'Content-Type': 'application/json',
    'Accept': 'application/json'
  }
}

/**
 * Test connection by fetching current user.
 * Never throws — always returns { ok, user?, error? }.
 */
export async function testConnection(email, token) {
  try {
    const res = await fetch(`${BB_API}/user`, {
      headers: bbHeaders(email, token)
    })

    if (res.ok) {
      const data = await res.json()
      return {
        ok: true,
        user: {
          displayName: data.display_name,
          avatarUrl: data.links?.avatar?.href || ''
        }
      }
    }

    if (res.status === 401 || res.status === 403) {
      return { ok: false, error: 'Nieprawidłowe dane logowania' }
    }

    const text = await res.text()
    return { ok: false, error: `HTTP ${res.status}: ${text}` }
  } catch (err) {
    return { ok: false, error: `Błąd połączenia: ${err.message}` }
  }
}

/**
 * Get PR info (title, description, author, etc.).
 * Throws on HTTP error.
 */
export async function getPrInfo(email, token, workspace, repo, prId) {
  const url = `${BB_API}/repositories/${workspace}/${repo}/pullrequests/${prId}`
  const res = await fetch(url, { headers: bbHeaders(email, token) })

  if (!res.ok) {
    const text = await res.text()
    throw new Error(`HTTP ${res.status}: ${text}`)
  }

  return res.json()
}

/**
 * Get PR diff as raw text.
 * Throws on HTTP error.
 */
export async function getPrDiff(email, token, workspace, repo, prId) {
  const url = `${BB_API}/repositories/${workspace}/${repo}/pullrequests/${prId}/diff`
  const headers = bbHeaders(email, token)
  headers['Accept'] = 'text/plain'

  const res = await fetch(url, { headers })

  if (!res.ok) {
    const text = await res.text()
    throw new Error(`HTTP ${res.status}: ${text}`)
  }

  return res.text()
}

/**
 * Post an inline comment on a specific file/line.
 * Throws on HTTP error.
 */
export async function postInlineComment(email, token, workspace, repo, prId, { path, line, body }) {
  const url = `${BB_API}/repositories/${workspace}/${repo}/pullrequests/${prId}/comments`
  const res = await fetch(url, {
    method: 'POST',
    headers: bbHeaders(email, token),
    body: JSON.stringify({
      content: { raw: body },
      inline: { path, to: line }
    })
  })

  if (!res.ok) {
    const text = await res.text()
    throw new Error(`HTTP ${res.status}: ${text}`)
  }

  return res.json()
}

/**
 * Approve a PR.
 * Throws on HTTP error.
 */
export async function approvePr(email, token, workspace, repo, prId) {
  const url = `${BB_API}/repositories/${workspace}/${repo}/pullrequests/${prId}/approve`
  const headers = bbHeaders(email, token)
  delete headers['Content-Type']
  const res = await fetch(url, { method: 'POST', headers })

  if (!res.ok) {
    const text = await res.text()
    throw new Error(`HTTP ${res.status}: ${text}`)
  }

  return res.json()
}

/**
 * Request changes on a PR.
 * Throws on HTTP error.
 */
export async function requestChangesPr(email, token, workspace, repo, prId) {
  const url = `${BB_API}/repositories/${workspace}/${repo}/pullrequests/${prId}/request-changes`
  const headers = bbHeaders(email, token)
  delete headers['Content-Type']
  const res = await fetch(url, { method: 'POST', headers })

  if (!res.ok) {
    const text = await res.text()
    throw new Error(`HTTP ${res.status}: ${text}`)
  }

  return res.json()
}

/**
 * Post a general (non-inline) comment on a PR.
 * Throws on HTTP error.
 */
export async function postGeneralComment(email, token, workspace, repo, prId, body) {
  const url = `${BB_API}/repositories/${workspace}/${repo}/pullrequests/${prId}/comments`
  const res = await fetch(url, {
    method: 'POST',
    headers: bbHeaders(email, token),
    body: JSON.stringify({
      content: { raw: body }
    })
  })

  if (!res.ok) {
    const text = await res.text()
    throw new Error(`HTTP ${res.status}: ${text}`)
  }

  return res.json()
}
