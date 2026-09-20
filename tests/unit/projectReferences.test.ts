import { describe, expect, it, vi, beforeEach } from 'vitest'
import { insertReference, mentionQuery, referencePaths, referencePrompt } from '../../src/components/session/projectReferences'

const invoke = vi.hoisted(() => vi.fn())
vi.mock('@tauri-apps/api/core', () => ({ invoke }))
vi.mock('../../src/locales', () => ({ default: { global: { t: (_key: string, args: { reason: string }) => args.reason } } }))
import { prepareReferencedInput, prepareReferencedMessage } from '../../src/composables/useProjectReferences'

describe('project reference editing', () => {
  it('finds a mention at the caret without matching emails or code', () => {
    expect(mentionQuery('检查 @src 后面的文字', 7)).toEqual({ start: 3, end: 7, query: 'src' })
    expect(mentionQuery('alice@example.com', 17)).toBeNull()
    expect(mentionQuery('检查@src', 6)?.query).toBe('src')
    expect(referencePaths('检查@"src/a.ts"')).toEqual(['src/a.ts'])
    expect(mentionQuery('`@src', 5)).toBeNull()
    expect(mentionQuery('```ts\n@src', 10)).toBeNull()
    expect(mentionQuery('@"文件 名', 6)?.query).toBe('文件 名')
    expect(mentionQuery('@"src/a.ts"', 11)).toBeNull()
  })

  it('replaces the whole partial token and preserves surrounding prose', () => {
    const text = '请看 @source 后面的说明'
    const query = mentionQuery(text, 7)!
    const result = insertReference(text, query, { path: 'src/a.ts', isDirectory: false })
    expect(result.text).toBe('请看 @"src/a.ts"  后面的说明')
    expect(result.text.slice(0, result.cursor)).toBe('请看 @"src/a.ts" ')
  })

  it('round trips spaces, unicode, quotes and backslashes and retains directory slashes', () => {
    for (const path of ['src/中文 名.ts', 'src/a"b.ts', 'src/a\\b.ts']) {
      const inserted = insertReference('@', mentionQuery('@', 1)!, { path, isDirectory: false })
      expect(referencePaths(inserted.text)).toEqual([path])
    }
    expect(referencePaths(insertReference('@', mentionQuery('@', 1)!, { path: 'src', isDirectory: true }).text)).toEqual(['src/'])
  })

  it('deduplicates and ignores quoted examples inside code', () => {
    expect(referencePaths('@"src/a.ts" @"src/a.ts" `@"example"`\n```\n@"code"\n```')).toEqual(['src/a.ts'])
    expect(referencePaths('email@"example" @unfinished')).toEqual([])
  })
})

describe('reference delivery', () => {
  beforeEach(() => { invoke.mockReset() })

  it('does not invoke the filesystem for ordinary messages', async () => {
    expect(await prepareReferencedMessage('hello', '/workspace')).toBe('hello')
    expect(invoke).not.toHaveBeenCalled()
  })

  it('passes explicit absolute references to native text transport without reading file contents', async () => {
    const files = [{ path: '/workspace/中文 名.ts', isDirectory: false }]
    invoke.mockResolvedValue(files)
    const text = '@"中文 名.ts" explain'
    expect(await prepareReferencedMessage(text, '/workspace')).toBe(text + referencePrompt(files))
    expect(invoke).toHaveBeenCalledWith('resolve_project_references', { cwd: '/workspace', paths: ['中文 名.ts'] })
  })

  it('regenerates structured files after queue editing, preserving images and skills', async () => {
    invoke.mockResolvedValue([{ path: '/workspace/new.ts', isDirectory: false }])
    const input = [
      { kind: 'text' as const, text: '@"old.ts"' },
      { kind: 'file' as const, path: '/workspace/old.ts' },
      { kind: 'image' as const, mediaType: 'image/png', data: 'sample' },
      { kind: 'skill' as const, name: 'review', path: '/workspace/skills/review' },
    ]
    const result = await prepareReferencedInput(input, '@"new.ts"', '/workspace')
    expect(result).toEqual([
      { kind: 'text', text: '@"new.ts"' }, input[2], input[3], { kind: 'file', path: '/workspace/new.ts' },
    ])
    expect(await prepareReferencedInput(result, 'no reference', '/workspace')).toEqual([
      { kind: 'text', text: 'no reference' }, input[2], input[3],
    ])
  })

  it('fails before delivery when a reference has disappeared', async () => {
    invoke.mockRejectedValue('Reference is unavailable: removed.ts')
    await expect(prepareReferencedInput([], '@"removed.ts"', '/workspace')).rejects.toThrow('Reference is unavailable')
    await expect(prepareReferencedMessage('@"removed.ts"', '/workspace')).rejects.toThrow('Reference is unavailable')
  })
})
