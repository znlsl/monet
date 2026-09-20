<script setup lang="ts">
import { nextTick, onMounted, onUnmounted, ref, watch } from 'vue'
import FileReferencePanel from './FileReferencePanel.vue'

defineOptions({ inheritAttrs: false })

const props = withDefaults(defineProps<{
  modelValue: string
  placeholder?: string
  disabled?: boolean
  maxHeight?: number
  cwd?: string | null
}>(), {
  placeholder: '',
  disabled: false,
  maxHeight: 160,
})

const emit = defineEmits<{
  (event: 'update:modelValue', value: string): void
  (event: 'keydown', value: KeyboardEvent): void
  (event: 'input', value: Event): void
  (event: 'keyup', value: KeyboardEvent): void
  (event: 'click', value: MouseEvent): void
  (event: 'select', value: Event): void
}>()

const element = ref<HTMLTextAreaElement>()
const referencePanel = ref<InstanceType<typeof FileReferencePanel>>()
const cursor = ref(0)
const focused = ref(false)
const composing = ref(false)
function syncReferenceCursor() {
  cursor.value = element.value?.selectionStart ?? 0
}
function onKeydown(event: KeyboardEvent) {
  if (!referencePanel.value?.onKeydown(event)) emit('keydown', event)
}
async function insertReference(text: string, position: number) {
  emit('update:modelValue', text)
  await nextTick()
  element.value?.focus()
  element.value?.setSelectionRange(position, position)
  syncReferenceCursor()
  resize()
  if (element.value) emit('input', new Event('input'))
}
let widthObserver: ResizeObserver | null = null
let resizeFrame = 0
let observedWidth = 0

function resize() {
  const textarea = element.value
  if (!textarea) return
  textarea.style.height = 'auto'
  textarea.style.height = `${Math.min(textarea.scrollHeight, props.maxHeight)}px`
}

function scheduleResize() {
  if (resizeFrame) cancelAnimationFrame(resizeFrame)
  resizeFrame = requestAnimationFrame(() => {
    resizeFrame = 0
    resize()
  })
}

function resetHeight() {
  if (element.value) element.value.style.height = 'auto'
}

function onInput(event: Event) {
  emit('update:modelValue', (event.target as HTMLTextAreaElement).value)
  resize()
  syncReferenceCursor()
  emit('input', event)
}

watch(() => props.modelValue, () => nextTick(scheduleResize))
onMounted(() => {
  const textarea = element.value
  if (!textarea) return
  observedWidth = textarea.getBoundingClientRect().width
  resize()
  widthObserver = new ResizeObserver(([entry]) => {
    const width = entry?.contentRect.width ?? 0
    if (width <= 0 || Math.abs(width - observedWidth) < 0.5) return
    observedWidth = width
    scheduleResize()
  })
  widthObserver.observe(textarea)
})
onUnmounted(() => {
  widthObserver?.disconnect()
  widthObserver = null
  if (resizeFrame) cancelAnimationFrame(resizeFrame)
})

defineExpose({ element, resize, resetHeight })
</script>

<template>
  <textarea
    v-bind="$attrs"
    ref="element"
    :value="modelValue"
    :placeholder="placeholder"
    :disabled="disabled"
    rows="1"
    :aria-controls="referencePanel?.visible ? referencePanel.id : undefined"
    :aria-expanded="referencePanel?.visible || false"
    :aria-activedescendant="referencePanel?.visible ? referencePanel.activeId : undefined"
    :aria-autocomplete="cwd ? 'list' : undefined"
    :aria-haspopup="cwd ? 'listbox' : undefined"
    @focus="focused = true; syncReferenceCursor()"
    @blur="focused = false"
    @compositionstart="composing = true"
    @compositionend="composing = false; syncReferenceCursor()"
    @keydown="onKeydown"
    @input="onInput"
    @keyup="syncReferenceCursor(); emit('keyup', $event)"
    @click="syncReferenceCursor(); emit('click', $event)"
    @select="syncReferenceCursor(); emit('select', $event)"
  />
  <FileReferencePanel ref="referencePanel" :text="modelValue" :cwd="cwd" :cursor="cursor"
    :field="element" :active="focused && !disabled && !composing && element?.selectionStart === element?.selectionEnd"
    @insert="insertReference" />
</template>
