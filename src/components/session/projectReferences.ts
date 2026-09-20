export interface ProjectFile {
  path: string
  isDirectory: boolean
}

export interface MentionQuery { start: number; end: number; query: string }

function codeRanges(text: string): [number, number][] {
  return [...text.matchAll(/@"(?:[^"\\]|\\.)*"|```[\s\S]*?(?:```|$)|~~~[\s\S]*?(?:~~~|$)|`[^`\n]*(?:`|$)/g)]
    .filter(match => !match[0].startsWith('@'))
    .map(match => [match.index, match.index + match[0].length])
}

/** 补全只在独立 @ 词元触发，邮件地址和已完成的引用不触发。 */
export function mentionQuery(text: string, cursor: number): MentionQuery | null {
  const prefix = text.slice(0, cursor)
  const match = /(?:^|[\s(（\p{Script=Han}，。:：])@([^\s@"`]*|"[^"\n]*)$/u.exec(prefix)
  if (!match) return null
  const raw = match[1]
  const start = cursor - raw.length - 1
  if (codeRanges(text).some(([from, to]) => start >= from && start < to)) return null
  const tail = text.slice(cursor)
  const end = raw.startsWith('"')
    ? cursor + (tail.match(/^[^"\n]*"/)?.[0].length ?? 0)
    : cursor + (tail.match(/^[^\s@"`]*/)?.[0].length ?? 0)
  return { start, end, query: raw.replace(/^"/, '') }
}

export function insertReference(text: string, query: MentionQuery, file: ProjectFile) {
  const path = file.path + (file.isDirectory && !file.path.endsWith('/') ? '/' : '')
  // JSON 引号保留空格、引号、反斜杠及中文；始终使用同一种可往返的引用格式。
  const token = `@${JSON.stringify(path)} `
  return {
    text: text.slice(0, query.start) + token + text.slice(query.end),
    cursor: query.start + token.length,
  }
}

export function referencePaths(text: string): string[] {
  const paths = new Set<string>()
  const code = codeRanges(text)
  for (const match of text.matchAll(/(?:^|[\s(（\p{Script=Han}，。:：])@("(?:[^"\\]|\\.)*")/gu)) {
    const start = match.index + match[0].indexOf('@')
    if (code.some(([from, to]) => start >= from && start < to)) continue
    try {
      const path: unknown = JSON.parse(match[1])
      if (typeof path === 'string' && path) paths.add(path)
    } catch { /* 未完成或手写的非 JSON 引号保持普通文本。 */ }
  }
  return [...paths]
}

export function referencePrompt(files: ProjectFile[]): string {
  if (!files.length) return ''
  return '\n\nRead the referenced local files or inspect the referenced directories as needed for this request. '
    + 'These are path references, not embedded file contents. Paths (JSON):\n'
    + JSON.stringify(files.map(file => ({ path: file.path, type: file.isDirectory ? 'directory' : 'file' })))
}
