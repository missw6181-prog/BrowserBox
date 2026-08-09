<script setup lang="ts">
import { computed } from 'vue'
import { countryDisplayName, normalizeCountryCode } from '../utils/country'

const props = withDefaults(
  defineProps<{
    code?: string | null
    /** 是否显示国家名/代码文字 */
    showText?: boolean
    size?: 'sm' | 'md'
  }>(),
  {
    showText: true,
    size: 'sm'
  }
)

const fiClass = computed(() => {
  const c = normalizeCountryCode(props.code)
  return c ? `fi fi-${c}` : ''
})

const text = computed(() => countryDisplayName(props.code))
</script>

<template>
  <span class="country-flag" :class="size">
    <span v-if="fiClass" :class="fiClass" :title="text" />
    <span v-else class="flag-placeholder" title="未知">—</span>
    <span v-if="showText" class="country-text">{{ text }}</span>
  </span>
</template>

<style scoped>
.country-flag {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  line-height: 1;
}
.country-flag :deep(.fi) {
  border-radius: 2px;
  box-shadow: 0 0 0 1px rgba(0, 0, 0, 0.08);
}
.country-flag.sm :deep(.fi) {
  width: 1.15em;
  line-height: 1em;
}
.country-flag.md :deep(.fi) {
  width: 1.4em;
  line-height: 1.05em;
}
.flag-placeholder {
  color: var(--bb-muted);
  font-size: 12px;
}
.country-text {
  font-size: 12px;
}
</style>
