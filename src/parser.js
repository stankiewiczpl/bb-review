/**
 * Unified diff parser for Bitbucket PR diffs.
 */

/**
 * Parse unified diff text into per-file structures.
 * @param {string} diffText - Raw unified diff from Bitbucket API
 * @returns {Array<{ path: string, diff: string, maxNewLine: number }>}
 */
export function parseDiffFiles(diffText) {
  const files = []
  let currentFile = null
  const lines = diffText.split('\n')

  for (const line of lines) {
    if (line.startsWith('diff --git')) {
      if (currentFile) {
        currentFile.maxNewLine = calcMaxNewLine(currentFile.diff)
        files.push(currentFile)
      }
      currentFile = { path: '', diff: '', maxNewLine: 0 }
      continue
    }

    if (!currentFile) continue

    if (line.startsWith('+++ b/')) {
      currentFile.path = line.slice(6)
      currentFile.diff += line + '\n'
      continue
    }

    if (line.startsWith('+++ /dev/null')) {
      // Deleted file — path already set from --- line
      currentFile.diff += line + '\n'
      continue
    }

    if (line.startsWith('--- a/')) {
      // For deleted files (+++ /dev/null), use this as the path
      if (!currentFile.path) {
        currentFile.path = line.slice(6)
      }
      currentFile.diff += line + '\n'
      continue
    }

    if (line.startsWith('--- /dev/null')) {
      currentFile.diff += line + '\n'
      continue
    }

    currentFile.diff += line + '\n'
  }

  if (currentFile) {
    currentFile.maxNewLine = calcMaxNewLine(currentFile.diff)
    files.push(currentFile)
  }

  return files
}

const HUNK_HEADER_RE = /^@@ -\d+(?:,\d+)? \+(\d+)/

/**
 * Calculate the maximum new-side line number from a file's diff.
 */
function calcMaxNewLine(diff) {
  let newLine = 0
  let maxNewLine = 0
  const lines = diff.split('\n')

  for (const line of lines) {
    const m = HUNK_HEADER_RE.exec(line)
    if (m) {
      newLine = parseInt(m[1], 10) - 1
      continue
    }

    if (line.startsWith('+') && !line.startsWith('+++')) {
      newLine++
      maxNewLine = Math.max(maxNewLine, newLine)
    } else if (line.startsWith('-') && !line.startsWith('---')) {
      // Removed line — don't increment newLine
    } else if (line.startsWith(' ')) {
      // Context line (unified diff: always space-prefixed)
      newLine++
      maxNewLine = Math.max(maxNewLine, newLine)
    }
  }

  return maxNewLine
}

/**
 * Get diff context around a specific line for display in review UI.
 * @param {Array} diffFiles - Result from parseDiffFiles()
 * @param {string} path - File path to look up
 * @param {number} targetLine - Line number in the new version
 * @param {number} [contextLines=3] - Number of context lines before/after
 * @returns {Array<{ lineNum: number|null, type: 'add'|'remove'|'context'|'header', content: string }>}
 */
export function getDiffContext(diffFiles, path, targetLine, contextLines = 3) {
  const file = diffFiles.find(f => f.path === path)
  if (!file) return []

  // Build line map with new-side line numbers
  const lineMap = []
  let newLine = 0
  const diffLines = file.diff.split('\n')

  for (const line of diffLines) {
    const m = HUNK_HEADER_RE.exec(line)
    if (m) {
      newLine = parseInt(m[1], 10) - 1
      lineMap.push({ lineNum: null, type: 'header', content: line })
      continue
    }

    if (line.startsWith('+++') || line.startsWith('---')) {
      continue
    }

    if (line.startsWith('+')) {
      newLine++
      lineMap.push({ lineNum: newLine, type: 'add', content: line.slice(1) })
    } else if (line.startsWith('-')) {
      lineMap.push({ lineNum: null, type: 'remove', content: line.slice(1) })
    } else if (line.startsWith(' ')) {
      newLine++
      lineMap.push({ lineNum: newLine, type: 'context', content: line.slice(1) })
    }
  }

  // Find the index of the target line
  const targetIdx = lineMap.findIndex(
    entry => entry.lineNum === targetLine && (entry.type === 'add' || entry.type === 'context')
  )
  if (targetIdx === -1) {
    // Fallback: find closest line
    let closest = -1
    let minDist = Infinity
    for (let i = 0; i < lineMap.length; i++) {
      if (lineMap[i].lineNum !== null) {
        const dist = Math.abs(lineMap[i].lineNum - targetLine)
        if (dist < minDist) {
          minDist = dist
          closest = i
        }
      }
    }
    if (closest === -1) return []
    const start = Math.max(0, closest - contextLines)
    const end = Math.min(lineMap.length, closest + contextLines + 1)
    return lineMap.slice(start, end)
  }

  const start = Math.max(0, targetIdx - contextLines)
  const end = Math.min(lineMap.length, targetIdx + contextLines + 1)
  return lineMap.slice(start, end)
}
