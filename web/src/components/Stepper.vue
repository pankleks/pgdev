<script setup lang="ts">
import { ChevronDown, ChevronUp } from 'lucide-vue-next'

// Numeric setting control: text field, unit suffix, and a chevron stack.
// Typing commits on blur/Enter (the settings store clamps); chevrons step live.
const props = defineProps<{
  modelValue: number
  min: number
  max: number
  step?: number
  unit?: string
}>()
const emit = defineEmits<{ 'update:modelValue': [value: number] }>()

function commit(raw: unknown) {
  const n = Number(raw)
  if (Number.isFinite(n)) emit('update:modelValue', n)
}
function bump(direction: 1 | -1) {
  const step = props.step ?? 1
  emit('update:modelValue', Math.min(props.max, Math.max(props.min, props.modelValue + direction * step)))
}
</script>

<template>
  <div class="stepper">
    <input
      class="stepper-input"
      type="number"
      :value="modelValue"
      :min="min"
      :max="max"
      :step="step ?? 1"
      @change="commit(($event.target as HTMLInputElement).value)"
    />
    <span v-if="unit" class="stepper-unit">{{ unit }}</span>
    <span class="stepper-sep" />
    <span class="stepper-btns">
      <button type="button" :title="`Increase by ${step ?? 1}`" @click="bump(1)"><ChevronUp :size="13" /></button>
      <button type="button" :title="`Decrease by ${step ?? 1}`" @click="bump(-1)"><ChevronDown :size="13" /></button>
    </span>
  </div>
</template>
