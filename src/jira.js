/**
 * Jira REST API client (optional integration).
 * Supports scoped API tokens via api.atlassian.com gateway.
 * Credentials are always passed as function parameters — never stored in module state.
 *
 * Required token scope: read:jira-work
 */

/**
 * Extract Jira ticket key from text (PR title or branch name).
 * @param {string} text
 * @returns {string|null} Ticket key like "S3-10741" or null
 */
export function extractTicketKey(text) {
  if (!text) return null
  const match = text.match(/([A-Z][A-Z0-9]+-\d+)/)
  return match ? match[1] : null
}

/**
 * Flatten Atlassian Document Format (ADF) to plain text.
 * ADF is a nested JSON structure used by Jira API v3.
 */
function flattenAdf(node) {
  if (!node) return ''
  if (typeof node === 'string') return node
  if (node.type === 'text') return node.text || ''
  if (node.type === 'hardBreak') return '\n'
  if (!node.content) return ''
  return node.content.map(flattenAdf).join(
    node.type === 'paragraph' || node.type === 'bulletList' || node.type === 'orderedList' ? '\n' : ''
  )
}

/**
 * Build Basic Auth headers for Jira (same Atlassian credentials as Bitbucket).
 */
function jiraHeaders(email, token) {
  const credentials = Buffer.from(`${email}:${token}`).toString('base64')
  return {
    'Authorization': `Basic ${credentials}`,
    'Accept': 'application/json'
  }
}

// Cache cloudId per domain to avoid repeated lookups
const cloudIdCache = new Map()

/**
 * Get Atlassian Cloud ID for a Jira domain.
 * @param {string} jiraDomain - e.g. "firma.atlassian.net"
 * @returns {Promise<string|null>}
 */
async function getCloudId(jiraDomain) {
  if (cloudIdCache.has(jiraDomain)) return cloudIdCache.get(jiraDomain)

  try {
    const res = await fetch(`https://${jiraDomain}/_edge/tenant_info`)
    if (!res.ok) return null
    const data = await res.json()
    const cloudId = data.cloudId
    if (cloudId) cloudIdCache.set(jiraDomain, cloudId)
    return cloudId || null
  } catch {
    return null
  }
}

/**
 * Fetch Jira ticket details via Atlassian API gateway (scoped tokens).
 * Never throws — returns null if ticket cannot be fetched.
 * @param {string} email
 * @param {string} token - API token with read:jira-work scope
 * @param {string} jiraDomain - e.g. "firma.atlassian.net"
 * @param {string} ticketKey - e.g. "S3-10741"
 * @returns {Promise<{key: string, summary: string, description: string, type: string, status: string}|null>}
 */
export async function getJiraTicket(email, token, jiraDomain, ticketKey) {
  try {
    const cloudId = await getCloudId(jiraDomain)
    if (!cloudId) return null

    const url = `https://api.atlassian.com/ex/jira/${cloudId}/rest/api/3/issue/${ticketKey}?fields=summary,description,issuetype,status`
    const res = await fetch(url, { headers: jiraHeaders(email, token) })

    if (!res.ok) return null

    const data = await res.json()
    return {
      key: data.key,
      summary: data.fields?.summary || '',
      description: flattenAdf(data.fields?.description) || '',
      type: data.fields?.issuetype?.name || '',
      status: data.fields?.status?.name || ''
    }
  } catch {
    return null
  }
}
