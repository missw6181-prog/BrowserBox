<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { invoke } from '../services/api'

interface BrowserInstallInfo {
  id: string
  major: string
  version: string
  path: string
  source: 'cft' | 'system'
  label: string
}

interface MilestoneInfo {
  milestone: string
  version: string
  url: string
  installed: boolean
}

interface SystemChrome {
  path: string
  version: string
}

const installed = ref<BrowserInstallInfo[]>([])
const milestones = ref<MilestoneInfo[]>([])
const systemChrome = ref<SystemChrome | null>(null)
const latest = ref<{ version: string; url: string; major: string } | null>(null)
const selectedMilestone = ref('')
const progress = ref('')
const loading = ref(false)
const loadingList = ref(false)
const defaultVersion = ref('')
let off: (() => void) | null = null

const milestoneOptions = computed(() =>
  milestones.value.map((m) => ({
    value: m.milestone,
    label: m.installed ? `Chrome ${m.milestone}（已下载）` : `Chrome ${m.milestone}`
  }))
)

async function refresh(): Promise<void> {
  installed.value = await invoke<BrowserInstallInfo[]>('browser:list')
  systemChrome.value = await invoke<SystemChrome | null>('browser:detectSystem')
  try {
    const settings = await invoke<{ defaultBrowserVersion: string }>('settings:get')
    defaultVersion.value = settings.defaultBrowserVersion || ''
  } catch {
    /* ignore */
  }
}

async function loadMilestones(): Promise<void> {
  loadingList.value = true
  try {
    milestones.value = await invoke<MilestoneInfo[]>('browser:listMilestones')
    if (!selectedMilestone.value && milestones.value.length) {
      selectedMilestone.value = milestones.value[0].milestone
    }
    ElMessage.success(`已加载 ${milestones.value.length} 个可用主版本`)
  } catch (e) {
    ElMessage.error((e as Error).message)
  } finally {
    loadingList.value = false
  }
}

async function check(): Promise<void> {
  try {
    latest.value = await invoke('browser:checkLatest')
    ElMessage.success(`最新稳定版: ${latest.value?.version}`)
    if (latest.value?.major) selectedMilestone.value = latest.value.major
  } catch (e) {
    ElMessage.error((e as Error).message)
  }
}

async function installSelected(): Promise<void> {
  const target = selectedMilestone.value || 'stable'
  loading.value = true
  progress.value = '开始…'
  try {
    const result = await invoke<{ version: string; major: string; exe: string }>('browser:installVersion', target)
    ElMessage.success(`已安装 ${result.version}`)
    await refresh()
    await loadMilestones()
    // 安装后默认使用 Chrome for Testing 150（若已具备）
    if (installed.value.some((b) => b.id === '150' || b.major === '150')) {
      await setDefault('150')
    } else if (result.major) {
      await setDefault(result.major)
    }
  } catch (e) {
    ElMessage.error((e as Error).message)
  } finally {
    loading.value = false
    progress.value = ''
  }
}

async function installLatest(): Promise<void> {
  loading.value = true
  progress.value = '开始…'
  try {
    const result = await invoke<{ version: string; major: string; exe: string }>('browser:installLatest')
    ElMessage.success(`已安装 ${result.version}`)
    selectedMilestone.value = result.major
    await refresh()
    if (milestones.value.length) await loadMilestones()
    if (installed.value.some((b) => b.id === '150' || b.major === '150')) {
      await setDefault('150')
    } else if (result.major) {
      await setDefault(result.major)
    }
  } catch (e) {
    ElMessage.error((e as Error).message)
  } finally {
    loading.value = false
    progress.value = ''
  }
}

async function setDefault(id: string): Promise<void> {
  try {
    await invoke('browser:setDefault', id)
    defaultVersion.value = id
    ElMessage.success(id === 'system' ? '已设本机 Chrome 为默认' : `已设默认版本为 ${id}`)
  } catch (e) {
    ElMessage.error((e as Error).message)
  }
}

async function removeBrowser(row: BrowserInstallInfo): Promise<void> {
  if (row.source === 'system') {
    ElMessage.warning('本机 Google Chrome 不能通过本工具删除')
    return
  }
  if (defaultVersion.value === row.id) {
    ElMessage.warning('当前默认浏览器不能删除，请先将其它版本设为默认')
    return
  }
  try {
    await ElMessageBox.confirm(
      `确认删除 Chrome for Testing ${row.major}？\n将从数据目录移除该版本文件；安装包内置版本也不会再自动灌回（可重新下载）。`,
      '删除浏览器',
      { type: 'warning', confirmButtonText: '删除', cancelButtonText: '取消' }
    )
    await invoke('browser:uninstall', row.id)
    ElMessage.success(`已删除 ${row.major}`)
    await refresh()
    if (milestones.value.length) await loadMilestones()
  } catch (e) {
    if (e === 'cancel' || (e as { message?: string })?.message === 'cancel') return
    ElMessage.error((e as Error).message)
  }
}

function canDelete(row: BrowserInstallInfo): boolean {
  return row.source === 'cft' && defaultVersion.value !== row.id
}

function sourceLabel(source: string): string {
  return source === 'system' ? '本机 Chrome' : 'Chrome for Testing'
}

onMounted(() => {
  void refresh()
  void loadMilestones()
  off = window.browserBox.on('browser:installProgress', (msg) => {
    progress.value = String(msg)
  })
})

onUnmounted(() => {
  off?.()
})
</script>

<template>
  <div>
    <div class="head">
      <div>
        <h2>浏览器管理</h2>
        <p class="desc">可下载指定主版本的官方 Chrome for Testing，也可使用本机已安装的 Google Chrome</p>
      </div>
    </div>

    <el-card shadow="never" class="block">
      <template #header>
        <div class="card-head">本机 Google Chrome</div>
      </template>
      <div v-if="systemChrome" class="system-ok">
        <div>已检测到：{{ systemChrome.version }}</div>
        <div class="path">{{ systemChrome.path }}</div>
        <div class="row-actions">
          <el-button type="primary" size="small" @click="setDefault('system')">设为默认浏览器</el-button>
          <el-tag v-if="defaultVersion === 'system'" type="success" size="small">当前默认</el-tag>
        </div>
      </div>
      <el-alert
        v-else
        title="未检测到本机 Google Chrome"
        type="warning"
        :closable="false"
        description="请先安装 Google Chrome，或改用下方下载 Chrome for Testing。"
        show-icon
      />
    </el-card>

    <el-card shadow="never" class="block">
      <template #header>
        <div class="card-head">下载 Chrome for Testing</div>
      </template>
      <div class="download-row">
        <el-select
          v-model="selectedMilestone"
          filterable
          placeholder="选择主版本"
          style="width: 280px"
          :loading="loadingList"
        >
          <el-option v-for="o in milestoneOptions" :key="o.value" :label="o.label" :value="o.value" />
        </el-select>
        <el-button :loading="loadingList" @click="loadMilestones">刷新版本列表</el-button>
        <el-button @click="check">检查最新稳定版</el-button>
        <el-button type="primary" :loading="loading" :disabled="!selectedMilestone" @click="installSelected">
          下载所选版本
        </el-button>
        <el-button :loading="loading" @click="installLatest">下载最新稳定版</el-button>
      </div>
      <el-alert v-if="progress" :title="progress" type="info" show-icon :closable="false" style="margin-top: 12px" />
      <el-alert
        v-if="latest"
        :title="`线上最新稳定版: ${latest.version}（主版本 ${latest.major}）`"
        type="success"
        show-icon
        :closable="false"
        style="margin-top: 12px"
      />
    </el-card>

    <el-card shadow="never" class="block">
      <template #header>
        <div class="card-head">可用浏览器</div>
      </template>
      <el-table :data="installed" border stripe>
        <el-table-column label="来源" width="150">
          <template #default="{ row }">{{ sourceLabel(row.source) }}</template>
        </el-table-column>
        <el-table-column prop="major" label="标识" width="100" />
        <el-table-column prop="version" label="版本" width="160" />
        <el-table-column prop="path" label="路径" min-width="280" show-overflow-tooltip />
        <el-table-column label="操作" width="220" fixed="right">
          <template #default="{ row }">
            <el-button
              link
              type="primary"
              :disabled="defaultVersion === row.id"
              @click="setDefault(row.id)"
            >
              {{ defaultVersion === row.id ? '默认' : '设为默认' }}
            </el-button>
            <el-button
              v-if="row.source === 'cft'"
              link
              type="danger"
              :disabled="!canDelete(row)"
              @click="removeBrowser(row)"
            >
              删除
            </el-button>
          </template>
        </el-table-column>
      </el-table>
      <p v-if="!installed.length" class="empty">尚无可用浏览器，请下载 CfT 或安装本机 Google Chrome。</p>
    </el-card>
  </div>
</template>

<style scoped>
.head {
  margin-bottom: 16px;
}
h2 {
  margin: 0 0 4px;
}
.desc {
  margin: 0;
  color: var(--bb-muted);
  font-size: 13px;
}
.block {
  margin-bottom: 16px;
}
.card-head {
  font-weight: 600;
}
.system-ok {
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.path {
  font-size: 12px;
  color: var(--bb-muted);
  word-break: break-all;
}
.row-actions {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-top: 8px;
}
.download-row {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  align-items: center;
}
.empty {
  color: var(--bb-muted);
  margin-top: 12px;
}
</style>
