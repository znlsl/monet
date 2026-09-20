<script setup lang="ts">
import { computed, nextTick, onUnmounted, ref, useId, watch } from 'vue'
import { invoke } from '@tauri-apps/api/core'
import { insertReference, mentionQuery, type ProjectFile } from './projectReferences'

const props = defineProps<{
  text: string
  cwd?: string | null
  cursor: number
  active: boolean
  field?: HTMLTextAreaElement
}>()
const emit = defineEmits<{ insert: [text: string, cursor: number] }>()
const id = useId()
const dismissed = ref<string | null>(null)
const query = computed(() => props.active && props.cwd ? mentionQuery(props.text, props.cursor) : null)
const signature = computed(() => JSON.stringify([props.cwd, query.value]))
const visible = computed(() => !!query.value && signature.value !== dismissed.value)
const entries = ref<ProjectFile[]>([])
const loading = ref(false)
const error = ref(false)
const truncated = ref(false)
const selected = ref(0)
const panel = ref<HTMLElement>()
const position = ref({ left: '0px', top: '0px', width: '320px', maxHeight: '240px', transform: 'translateY(-100%)' })
let timer: ReturnType<typeof setTimeout> | undefined
let generation = 0

function place() {
  const rect = props.field?.getBoundingClientRect()
  if (!rect) return
  const width = Math.min(420, window.innerWidth - 16, Math.max(280, rect.width))
  const below = rect.top < 160 && window.innerHeight - rect.bottom > rect.top
  const height = Math.min(300, Math.max(40, (below ? window.innerHeight - rect.bottom : rect.top) - 16))
  position.value = {
    left: `${Math.max(8, Math.min(rect.left, window.innerWidth - width - 8))}px`,
    top: `${below ? rect.bottom + 6 : Math.max(8, rect.top - 6)}px`,
    width: `${width}px`, maxHeight: `${height}px`,
    transform: below ? 'none' : 'translateY(-100%)',
  }
}

watch([signature, visible], () => {
  const current = ++generation
  clearTimeout(timer)
  entries.value = []
  selected.value = 0
  error.value = false
  truncated.value = false
  loading.value = visible.value
  if (!visible.value || !query.value || !props.cwd) return
  place()
  const cwd = props.cwd
  const search = query.value.query
  timer = setTimeout(async () => {
    try {
      const result = await invoke<{ entries: ProjectFile[]; truncated: boolean }>('search_project_files', { cwd, query: search })
      if (generation !== current) return
      entries.value = result.entries
      truncated.value = result.truncated
    } catch {
      if (generation === current) error.value = true
    } finally {
      if (generation === current) loading.value = false
    }
  }, 120)
}, { immediate: true })

function choose(index: number) {
  const file = entries.value[index]
  if (!file || !query.value || loading.value) return
  const result = insertReference(props.text, query.value, file)
  dismissed.value = signature.value
  emit('insert', result.text, result.cursor)
}

function onKeydown(event: KeyboardEvent): boolean {
  if (!visible.value || event.isComposing || event.keyCode === 229) return false
  if (event.ctrlKey || event.metaKey || event.altKey || event.shiftKey) return false
  if (!['ArrowDown', 'ArrowUp', 'Enter', 'Tab', 'Escape'].includes(event.key)) return false
  if (event.key === 'Tab' && !entries.value.length) {
    dismissed.value = signature.value
    return false
  }
  // 面板打开时 Enter 不应意外提交尚未选择完成的消息。
  event.preventDefault()
  event.stopPropagation()
  if (event.key === 'Escape') dismissed.value = signature.value
  else if (event.key === 'Enter' || event.key === 'Tab') choose(selected.value)
  else if (entries.value.length) {
    selected.value = (selected.value + (event.key === 'ArrowDown' ? 1 : -1) + entries.value.length) % entries.value.length
    nextTick(() => panel.value?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest' }))
  }
  return true
}

watch(visible, value => {
  const action = value ? 'addEventListener' : 'removeEventListener'
  window[action]('resize', place)
  window[action]('scroll', place, true)
})
onUnmounted(() => {
  ++generation
  clearTimeout(timer)
  window.removeEventListener('resize', place)
  window.removeEventListener('scroll', place, true)
})
defineExpose({ onKeydown, visible, id, activeId: computed(() => entries.value.length ? `${id}-${selected.value}` : undefined) })
</script>

<template>
  <Teleport to="body">
    <div v-if="visible" ref="panel" :style="position"
      class="fixed z-50 flex flex-col overflow-hidden rounded-md border border-border bg-popover text-foreground shadow-paper-lifted"
      @mousedown.prevent>
      <div class="shrink-0 border-b border-border px-3 py-2 text-xs text-muted-foreground">{{ $t('references.hint') }}</div>
      <div :id="id" role="listbox" :aria-label="$t('references.title')" :aria-busy="loading" class="min-h-0 overflow-y-auto py-1">
        <div v-if="loading || error || !entries.length" role="status" class="px-3 py-2 text-xs text-muted-foreground">
          {{ $t(loading ? 'references.loading' : error ? 'references.error' : 'references.empty') }}
        </div>
        <div v-for="(file, index) in entries" :id="`${id}-${index}`" :key="file.path" role="option"
          :aria-selected="selected === index" :title="file.path"
          class="flex cursor-pointer items-center gap-2 px-3 py-2 text-xs"
          :class="selected === index ? 'bg-primary/10 text-foreground' : 'hover:bg-muted'"
          @mouseenter="selected = index" @click="choose(index)">
          <span aria-hidden="true" class="h-4 w-4 shrink-0" :class="file.isDirectory ? 'i-carbon-folder' : 'i-carbon-document'" />
          <span class="truncate">{{ file.path }}{{ file.isDirectory ? '/' : '' }}</span>
        </div>
      </div>
      <div class="shrink-0 border-t border-border px-3 py-1.5 text-xs text-muted-foreground">
        {{ $t(truncated ? 'references.refine' : 'references.keys') }}
      </div>
    </div>
  </Teleport>
</template>
