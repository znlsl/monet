import { invoke } from '@tauri-apps/api/core'
import i18n from '@/locales'
import { referencePaths, referencePrompt, type ProjectFile } from '@/components/session/projectReferences'
import type { RuntimeInputItem } from '@/engines/types'

export async function resolveProjectReferences(text: string, cwd: string | null | undefined): Promise<ProjectFile[]> {
  const paths = referencePaths(text)
  if (!paths.length) return []
  try {
    if (!cwd) throw new Error('Missing project directory')
    return await invoke<ProjectFile[]>('resolve_project_references', { cwd, paths })
  } catch (cause) {
    throw new Error(i18n.global.t('references.unavailable', { reason: String(cause) }))
  }
}

export async function prepareReferencedMessage(text: string, cwd: string): Promise<string> {
  return text + referencePrompt(await resolveProjectReferences(text, cwd))
}

/** 重新由草稿生成 File 输入，队列编辑、删除引用及重试都不保留旧的文件列表。 */
export async function prepareReferencedInput(input: RuntimeInputItem[], text: string, cwd: string | null | undefined): Promise<RuntimeInputItem[]> {
  const files = await resolveProjectReferences(text, cwd)
  return [
    ...(text ? [{ kind: 'text' as const, text }] : []),
    ...input.filter(item => item.kind !== 'text' && item.kind !== 'file'),
    ...files.map(file => ({ kind: 'file' as const, path: file.path })),
  ]
}
