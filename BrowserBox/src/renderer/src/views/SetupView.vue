<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import { ElMessage } from 'element-plus'
import { invoke } from '../services/api'
import AppIcon from '../components/AppIcon.vue'

const APP_NAME = '浏览器多开工具'
const router = useRouter()
const dataDir = ref('')
const preferred = ref('')
const loading = ref(false)

onMounted(async () => {
  try {
    const boot = await invoke<{
      dataDir: string
      ready: boolean
      preferredDataDir?: string
    }>('app:getBoot')
    if (boot.ready) {
      await router.replace('/')
      return
    }
    preferred.value = boot.preferredDataDir || ''
    dataDir.value = boot.dataDir || boot.preferredDataDir || ''
  } catch {
    /* ignore */
  }
})

async function choose(): Promise<void> {
  try {
    const res = await invoke<{ path: string }>('app:chooseDataDir')
    dataDir.value = res.path
  } catch (e) {
    if (String(e).includes('取消')) return
    ElMessage.error(String(e))
  }
}

async function confirm(): Promise<void> {
  if (!dataDir.value) {
    ElMessage.warning('请先选择数据目录')
    return
  }
  loading.value = true
  try {
    await invoke('app:initDataDir', dataDir.value)
    ElMessage.success('初始化完成')
    await router.replace('/')
    location.reload()
  } catch (e) {
    ElMessage.error(String((e as Error).message || e))
  } finally {
    loading.value = false
  }
}
</script>

<template>
  <div class="setup">
    <div class="card">
      <div class="title-row">
        <AppIcon :size="40" class="title-icon" />
        <h1>{{ APP_NAME }}</h1>
      </div>
      <p class="sub">
        正常安装后会自动使用安装目录下的 <code>Data</code> 文件夹。仅在自动初始化失败时需要手动指定。
      </p>
      <div class="row">
        <el-input v-model="dataDir" :placeholder="preferred || '例如 D:\\浏览器多开工具\\Data'" readonly />
        <el-button type="primary" @click="choose">浏览…</el-button>
      </div>
      <el-button type="primary" class="go" :loading="loading" @click="confirm">开始使用</el-button>
      <p class="hint">建议安装到可写磁盘（如 D:\浏览器多开工具）。若装在 Program Files，系统可能禁止写入，将自动回退到用户目录。</p>
    </div>
  </div>
</template>

<style scoped>
.setup {
  min-height: 100%;
  display: grid;
  place-items: center;
  background:
    radial-gradient(ellipse at 20% 20%, #ccfbf1 0%, transparent 50%),
    radial-gradient(ellipse at 80% 80%, #e0f2fe 0%, transparent 45%),
    #f8fafc;
}
.card {
  width: min(560px, 92vw);
  background: #fff;
  border: 1px solid var(--bb-border);
  border-radius: 16px;
  padding: 32px;
}
.title-row {
  display: flex;
  align-items: center;
  gap: 12px;
  margin-bottom: 8px;
}
.title-icon {
  color: #2563eb;
}
h1 {
  margin: 0;
  font-size: 26px;
  color: #1d4ed8;
}
.sub {
  color: var(--bb-muted);
  line-height: 1.6;
  margin: 0 0 20px;
}
.sub code {
  font-size: 13px;
  padding: 1px 6px;
  border-radius: 4px;
  background: #f1f5f9;
}
.row {
  display: flex;
  gap: 8px;
}
.go {
  margin-top: 16px;
  width: 100%;
}
.hint {
  margin: 14px 0 0;
  font-size: 12px;
  color: var(--bb-muted);
  line-height: 1.5;
}
</style>
