<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { invoke } from './services/api'
import AppIcon from './components/AppIcon.vue'

const APP_NAME = '浏览器多开工具'

const router = useRouter()
const route = useRoute()
const booting = ref(true)
const ready = ref(false)

const items = [
  { path: '/', label: '环境管理' },
  { path: '/proxies', label: '代理管理' },
  { path: '/browser', label: '浏览器管理' },
  { path: '/settings', label: '设置' }
]

const showNav = computed(() => ready.value && route.path !== '/setup')

onMounted(async () => {
  try {
    const boot = await invoke<{ dataDir: string; ready: boolean }>('app:getBoot')
    ready.value = boot.ready
    if (!boot.ready) {
      await router.replace('/setup')
    } else if (route.path === '/setup') {
      await router.replace('/')
    }
  } catch {
    await router.replace('/setup')
  } finally {
    booting.value = false
  }
})

function go(path: string): void {
  void router.push(path)
}
</script>

<template>
  <div v-if="booting" class="boot">正在启动 {{ APP_NAME }}…</div>
  <div v-else class="layout">
    <aside v-if="showNav" class="side">
      <div class="brand">
        <AppIcon :size="26" class="brand-icon" />
        <span class="brand-text">{{ APP_NAME }}</span>
      </div>
      <button
        v-for="item in items"
        :key="item.path"
        class="nav-btn"
        :class="{ active: route.path === item.path }"
        @click="go(item.path)"
      >
        {{ item.label }}
      </button>
    </aside>
    <main class="main">
      <router-view />
    </main>
  </div>
</template>

<style scoped>
.boot {
  height: 100%;
  display: grid;
  place-items: center;
  color: var(--bb-muted);
}
.layout {
  display: flex;
  height: 100%;
}
.side {
  width: 210px;
  background: #0f172a;
  color: #e2e8f0;
  padding: 20px 12px;
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.brand {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 8px 10px 20px;
  color: #3b82f6;
}
.brand-icon {
  color: #2563eb;
}
.brand-text {
  font-size: 15px;
  font-weight: 700;
  letter-spacing: 0.02em;
  line-height: 1.25;
}
.nav-btn {
  text-align: left;
  border: 0;
  background: transparent;
  color: #cbd5e1;
  padding: 10px 12px;
  border-radius: 8px;
  cursor: pointer;
  font-size: 14px;
}
.nav-btn:hover {
  background: rgba(255, 255, 255, 0.06);
}
.nav-btn.active {
  background: rgba(37, 99, 235, 0.18);
  color: #93c5fd;
}
.main {
  flex: 1;
  overflow: auto;
  padding: 20px 24px;
}
</style>
