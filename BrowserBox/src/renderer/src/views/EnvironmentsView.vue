<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, reactive, ref } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import type { TableInstance } from 'element-plus'
import { invoke } from '../services/api'
import type { Environment, EnvironmentStatus, FingerprintProfile, FingerprintSnapshot, ProxyConfig, ProxyType } from '@shared/types'
import { LANGUAGE_PRESETS } from '@shared/localePresets'
import CountryFlag from '../components/CountryFlag.vue'
import AppIcon from '../components/AppIcon.vue'

type EnvRow = Environment & { status: EnvironmentStatus; chromePid?: number }

interface BatchResult {
  ok: string[]
  failed: Array<{ id: string; message: string }>
}

const tableRef = ref<TableInstance>()
const rows = ref<EnvRow[]>([])
const proxies = ref<ProxyConfig[]>([])
const browsers = ref<Array<{ id: string; label: string; source: string }>>([])
const loading = ref(false)
const dialogVisible = ref(false)
const batchDialogVisible = ref(false)
const exportDialogVisible = ref(false)
const exportIncludeProxies = ref(false)
const exportBusy = ref(false)
const importBusy = ref(false)
const editingId = ref<string | null>(null)
const saving = ref(false)
const batchBusy = ref(false)
const latencyRefreshing = ref(false)
/** 用 id 集合保存勾选，避免定时刷新替换行对象后丢失全选 */
const selectedIds = ref<string[]>([])
const form = reactive({
  name: '',
  proxyId: null as string | null,
  remark: '',
  browserVersion: '',
  browserLang: '' as string,
  randomFingerprint: true
})
const batchForm = reactive({
  count: 5,
  namePrefix: '环境',
  proxyIds: [] as string[],
  browserVersion: '',
  remark: '',
  browserLang: '' as string,
  randomFingerprint: true
})

const fpDrawerVisible = ref(false)
const fpLoading = ref(false)
const fpLive = ref(false)
const fpProxyCountry = ref('')
const fpApplied = ref<{
  country: string
  lang: string
  acceptLanguages: string
  timezone: string
  locale: string
} | null>(null)
const fpSnapshot = ref<FingerprintSnapshot | null>(null)
const fpProfile = ref<FingerprintProfile | null>(null)
const fpEnvLabel = ref('')
const fpEnvId = ref('')
const fpRegenBusy = ref(false)

const fpEnvStopped = computed(() => {
  const row = rows.value.find((r) => r.id === fpEnvId.value)
  if (!row) return true
  return row.status === 'stopped' || row.status === 'proxy_error' || row.status === 'browser_error' || row.status === 'crashed'
})

/** 创建时：简单伪装→简单，深度伪装→深度，未开随机指纹→没有使用 */
const fpUsageLabel = computed(() => {
  const row = rows.value.find((r) => r.id === fpEnvId.value)
  if (!row || row.randomFingerprint === false || !row.fingerprint) return '没有使用'
  if (row.fingerprintMode === 'cdp') return '深度'
  if (row.fingerprintMode === 'ua') return '简单'
  // 旧数据无快照：有档案则按当前设置推断
  return '简单'
})

const fpUsageTagType = computed(() => {
  if (fpUsageLabel.value === '深度') return 'warning'
  if (fpUsageLabel.value === '简单') return 'success'
  return 'info'
})

let statusTimer: ReturnType<typeof setInterval> | null = null
let latencyTimer: ReturnType<typeof setInterval> | null = null
let restoringSelection = false
let statusOff: (() => void) | null = null

const STATUS_LABEL: Record<EnvironmentStatus, string> = {
  stopped: '已停止',
  starting: '启动中',
  running: '运行中',
  stopping: '停止中',
  proxy_error: '代理异常',
  browser_error: '浏览器异常',
  crashed: '已崩溃'
}

const STATUS_TAG: Record<EnvironmentStatus, 'success' | 'warning' | 'info' | 'danger'> = {
  stopped: 'info',
  starting: 'warning',
  running: 'success',
  stopping: 'warning',
  proxy_error: 'danger',
  browser_error: 'danger',
  crashed: 'danger'
}

const PROXY_TYPE_LABEL: Record<ProxyType, string> = {
  direct: '直连',
  http: 'HTTP',
  https: 'HTTPS',
  socks4: 'SOCKS4',
  socks5: 'SOCKS5'
}

const isEdit = computed(() => !!editingId.value)
const dialogTitle = computed(() => (isEdit.value ? '编辑环境' : '新建环境'))
const hasSelection = computed(() => selectedIds.value.length > 0)
const exportScopeText = computed(() =>
  hasSelection.value
    ? `将导出已选的 ${selectedIds.value.length} 个环境`
    : `未勾选时将导出全部 ${rows.value.length} 个环境`
)

const proxyMap = computed(() => {
  const map = new Map<string, ProxyConfig>()
  for (const p of proxies.value) map.set(p.id, p)
  return map
})

/** 复用已有行对象，避免 el-table 因引用变化清空勾选 */
function applyEnvList(envList: EnvRow[]): void {
  const oldById = new Map(rows.value.map((r) => [r.id, r]))
  rows.value = envList.map((e) => {
    const old = oldById.get(e.id)
    if (old) {
      const prevStatus = old.status
      Object.assign(old, e)
      // 启动中/停止中时，若服务端仍短暂返回 stopped，保留过渡态
      if (
        (prevStatus === 'starting' || prevStatus === 'stopping') &&
        (e.status === 'stopped' || !e.status)
      ) {
        old.status = prevStatus
      }
      return old
    }
    return e
  })
}

async function restoreTableSelection(keepIds: string[]): Promise<void> {
  const table = tableRef.value
  restoringSelection = true
  try {
    if (!table) return
    const keep = new Set(keepIds)
    await nextTick()
    for (const row of rows.value) {
      table.toggleRowSelection(row, keep.has(row.id))
    }
    await nextTick()
  } finally {
    restoringSelection = false
  }
}

function setLocalStatus(ids: string[], status: EnvironmentStatus): void {
  const idSet = new Set(ids)
  for (const row of rows.value) {
    if (idSet.has(row.id)) row.status = status
  }
}

function onEnvStatus(payload: unknown): void {
  const p = payload as { id?: string; status?: EnvironmentStatus; chromePid?: number }
  if (!p?.id || !p.status) return
  const row = rows.value.find((r) => r.id === p.id)
  if (row) {
    row.status = p.status
    if (typeof p.chromePid === 'number') row.chromePid = p.chromePid
  }
}

async function refresh(silent = false): Promise<void> {
  if (!silent) loading.value = true
  try {
    const [envList, proxyList, browserList] = await Promise.all([
      invoke<EnvRow[]>('environment:list'),
      invoke<ProxyConfig[]>('proxy:list'),
      invoke<Array<{ id: string; label: string; source: string }>>('browser:list')
    ])
    // 网络等待期间用户可能刚勾选，取最新勾选再锁表
    const keep = [...selectedIds.value]
    const idSet = new Set(envList.map((e) => e.id))
    const nextSelected = keep.filter((id) => idSet.has(id))
    selectedIds.value = nextSelected
    restoringSelection = true
    applyEnvList(envList)
    proxies.value = proxyList
    browsers.value = browserList
    await restoreTableSelection(nextSelected)
  } catch (e) {
    restoringSelection = false
    if (!silent) ElMessage.error((e as Error).message)
  } finally {
    if (!silent) loading.value = false
  }
}

function browserLabel(version: string): string {
  if (!version) return '默认'
  if (version === 'system') return '本机 Chrome'
  const hit = browsers.value.find((b) => b.id === version)
  return hit?.label || version
}

function statusText(status: EnvironmentStatus): string {
  return STATUS_LABEL[status] || status
}

function statusTagType(status: EnvironmentStatus): 'success' | 'warning' | 'info' | 'danger' {
  return STATUS_TAG[status] || 'info'
}

function proxyTypeText(proxyId: string | null): string {
  if (!proxyId) return '直连'
  const p = proxyMap.value.get(proxyId)
  if (!p) return '未知'
  return PROXY_TYPE_LABEL[p.type] || p.type.toUpperCase()
}

function proxyNameText(proxyId: string | null): string {
  if (!proxyId) return ''
  const p = proxyMap.value.get(proxyId)
  return p?.name || ''
}

function proxyCountry(proxyId: string | null): string {
  if (!proxyId) return ''
  return proxyMap.value.get(proxyId)?.country || ''
}

function proxyLatencyText(proxyId: string | null): string {
  if (!proxyId) return '—'
  const p = proxyMap.value.get(proxyId)
  if (!p) return '—'
  if (latencyRefreshing.value && typeof p.latencyMs !== 'number') return '测速中…'
  if (typeof p.latencyMs === 'number') return `${p.latencyMs}ms`
  if (p.status === 'timeout') return '超时'
  if (p.status === 'connection_failed') return '连接失败'
  if (p.status === 'untested') return '未测速'
  return '—'
}

function latencyClass(proxyId: string | null): string {
  if (!proxyId) return 'lat-muted'
  const p = proxyMap.value.get(proxyId)
  if (!p) return 'lat-muted'
  if (typeof p.latencyMs === 'number') {
    if (p.latencyMs < 200) return 'lat-good'
    if (p.latencyMs < 800) return 'lat-mid'
    return 'lat-slow'
  }
  if (p.status === 'timeout' || p.status === 'connection_failed') return 'lat-bad'
  return 'lat-muted'
}

async function refreshLatencies(): Promise<void> {
  if (latencyRefreshing.value) return
  const ids = [...new Set(rows.value.map((r) => r.proxyId).filter((id): id is string => !!id))]
  if (!ids.length) return

  latencyRefreshing.value = true
  try {
    await invoke('proxy:pingMany', ids)
    proxies.value = await invoke<ProxyConfig[]>('proxy:list')
  } catch {
    /* 静默失败，下轮再试 */
  } finally {
    latencyRefreshing.value = false
  }
}

function onSelectionChange(selection: EnvRow[]): void {
  if (restoringSelection) return
  selectedIds.value = selection.map((r) => r.id)
}

function resetForm(): void {
  editingId.value = null
  form.name = ''
  form.proxyId = null
  form.remark = ''
  form.browserVersion = ''
  form.browserLang = ''
  form.randomFingerprint = true
}

function openCreate(): void {
  resetForm()
  dialogVisible.value = true
}

function openBatchCreate(): void {
  batchForm.count = 5
  batchForm.namePrefix = '环境'
  batchForm.proxyIds = []
  batchForm.browserVersion = ''
  batchForm.remark = ''
  batchForm.browserLang = ''
  batchForm.randomFingerprint = true
  batchDialogVisible.value = true
}

function openEdit(row: EnvRow): void {
  editingId.value = row.id
  form.name = row.name
  form.proxyId = row.proxyId
  form.remark = row.remark || ''
  form.browserVersion = row.browserVersion || ''
  form.browserLang = row.browserLang || ''
  dialogVisible.value = true
}

async function saveEnv(): Promise<void> {
  saving.value = true
  try {
    if (editingId.value) {
      await invoke('environment:update', editingId.value, {
        name: form.name || undefined,
        proxyId: form.proxyId,
        remark: form.remark,
        browserVersion: form.browserVersion || undefined,
        browserLang: form.browserLang || ''
      })
      ElMessage.success('已保存')
    } else {
      await invoke('environment:create', {
        name: form.name || undefined,
        proxyId: form.proxyId,
        remark: form.remark,
        browserVersion: form.browserVersion || undefined,
        browserLang: form.browserLang || '',
        randomFingerprint: form.randomFingerprint
      })
      ElMessage.success('已创建')
      void refreshLatencies()
    }
    dialogVisible.value = false
    resetForm()
    await refresh()
  } catch (e) {
    ElMessage.error((e as Error).message)
  } finally {
    saving.value = false
  }
}

async function saveBatchCreate(): Promise<void> {
  saving.value = true
  try {
    const list = await invoke<Environment[]>('environment:createMany', {
      count: Number(batchForm.count),
      namePrefix: String(batchForm.namePrefix || '环境'),
      proxyIds: [...batchForm.proxyIds],
      browserVersion: batchForm.browserVersion || undefined,
      remark: batchForm.remark || undefined,
      browserLang: batchForm.browserLang || '',
      randomFingerprint: batchForm.randomFingerprint
    })
    ElMessage.success(`已批量创建 ${list.length} 个环境`)
    batchDialogVisible.value = false
    void refreshLatencies()
    await refresh()
  } catch (e) {
    ElMessage.error((e as Error).message)
  } finally {
    saving.value = false
  }
}

function summarizeBatch(result: BatchResult, action: string): void {
  if (result.failed.length === 0) {
    ElMessage.success(`${action}成功 ${result.ok.length} 个`)
    return
  }
  ElMessage.warning(`${action}成功 ${result.ok.length} 个，失败 ${result.failed.length} 个`)
}

async function start(row: EnvRow): Promise<void> {
  setLocalStatus([row.id], 'starting')
  await nextTick()
  try {
    await invoke('environment:start', row.id)
    setLocalStatus([row.id], 'running')
    ElMessage.success(`已启动 ${row.displayId}`)
    await refresh(true)
  } catch (e) {
    await refresh(true)
    ElMessage.error((e as Error).message)
  }
}

async function stop(row: EnvRow): Promise<void> {
  setLocalStatus([row.id], 'stopping')
  await nextTick()
  try {
    await invoke('environment:stop', row.id)
    setLocalStatus([row.id], 'stopped')
    ElMessage.success(`已停止 ${row.displayId}`)
    await refresh(true)
  } catch (e) {
    await refresh(true)
    ElMessage.error((e as Error).message)
  }
}

async function focusEnv(row: EnvRow): Promise<void> {
  try {
    await invoke('environment:focus', row.id)
    ElMessage.success(`已定位到 ${row.displayId}`)
  } catch (e) {
    ElMessage.error((e as Error).message)
  }
}

async function loadFingerprint(envId: string): Promise<void> {
  fpLoading.value = true
  try {
    const res = await invoke<{
      live: boolean
      snapshot: FingerprintSnapshot | null
      profile: FingerprintProfile | null
      proxyCountry: string
      appliedRegion: {
        country: string
        lang: string
        acceptLanguages: string
        timezone: string
        locale: string
      } | null
    }>('environment:getFingerprint', envId)
    fpLive.value = res.live
    fpSnapshot.value = res.snapshot
    fpProfile.value = res.profile
    fpProxyCountry.value = res.proxyCountry || ''
    fpApplied.value = res.appliedRegion
  } catch (e) {
    ElMessage.error((e as Error).message)
  } finally {
    fpLoading.value = false
  }
}

async function openFingerprint(row: EnvRow): Promise<void> {
  fpEnvId.value = row.id
  fpEnvLabel.value = `${row.displayId} ${row.name}`
  fpDrawerVisible.value = true
  fpSnapshot.value = row.lastFingerprint || null
  fpProfile.value = row.fingerprint || null
  fpLive.value = false
  fpProxyCountry.value = proxyCountry(row.proxyId) || ''
  fpApplied.value = null
  await loadFingerprint(row.id)
}

async function regenerateFingerprint(): Promise<void> {
  if (!fpEnvId.value || !fpEnvStopped.value) return
  fpRegenBusy.value = true
  try {
    const env = await invoke<Environment>('environment:regenerateFingerprint', fpEnvId.value)
    fpProfile.value = env.fingerprint || null
    fpSnapshot.value = null
    await refresh(true)
    ElMessage.success('已重新随机指纹，下次启动生效')
  } catch (e) {
    ElMessage.error((e as Error).message)
  } finally {
    fpRegenBusy.value = false
  }
}

async function batchStart(): Promise<void> {
  if (!hasSelection.value) return
  const ids = [...selectedIds.value]
  setLocalStatus(ids, 'starting')
  await nextTick()
  batchBusy.value = true
  try {
    const result = await invoke<BatchResult>('environment:startMany', ids)
    summarizeBatch(result, '批量启动')
    await refresh(true)
  } catch (e) {
    await refresh(true)
    ElMessage.error((e as Error).message)
  } finally {
    batchBusy.value = false
  }
}

async function batchStop(): Promise<void> {
  if (!hasSelection.value) return
  const ids = [...selectedIds.value]
  setLocalStatus(ids, 'stopping')
  await nextTick()
  batchBusy.value = true
  try {
    const result = await invoke<BatchResult>('environment:stopMany', ids)
    summarizeBatch(result, '批量关闭')
    await refresh(true)
  } catch (e) {
    await refresh(true)
    ElMessage.error((e as Error).message)
  } finally {
    batchBusy.value = false
  }
}

function openExportDialog(): void {
  if (!rows.value.length) {
    ElMessage.warning('当前没有可导出的环境')
    return
  }
  exportIncludeProxies.value = false
  exportDialogVisible.value = true
}

async function doExportBox(): Promise<void> {
  const ids = hasSelection.value ? [...selectedIds.value] : rows.value.map((r) => r.id)
  if (!ids.length) {
    ElMessage.warning('没有可导出的环境')
    return
  }
  exportBusy.value = true
  try {
    const res = await invoke<{ path: string; count: number; missingProfiles: string[] }>(
      'environment:exportBox',
      { ids, includeProxies: exportIncludeProxies.value }
    )
    exportDialogVisible.value = false
    let msg = `已导出 ${res.count} 个环境\n${res.path}`
    if (res.missingProfiles?.length) {
      msg += `\n其中 ${res.missingProfiles.length} 个缺少 Profile 目录`
    }
    ElMessage.success(msg)
  } catch (e) {
    const msg = (e as Error).message
    if (msg.includes('取消')) return
    ElMessage.error(msg)
  } finally {
    exportBusy.value = false
  }
}

async function doImportBox(): Promise<void> {
  importBusy.value = true
  try {
    const res = await invoke<{
      imported: Array<{ id: string; displayId: string; name: string }>
      proxiesCreated: number
      needPassword: string[]
      skipped: Array<{ name: string; reason: string }>
    }>('environment:importBox')
    const parts = [`已导入 ${res.imported.length} 个环境`]
    if (res.proxiesCreated) parts.push(`新建代理 ${res.proxiesCreated} 个`)
    if (res.needPassword?.length) parts.push(`${res.needPassword.length} 个代理需补密码`)
    if (res.skipped?.length) parts.push(`跳过 ${res.skipped.length} 个`)
    ElMessage.success(parts.join('；'))
    await refresh()
    void refreshLatencies()
  } catch (e) {
    const msg = (e as Error).message
    if (msg.includes('取消')) return
    ElMessage.error(msg)
  } finally {
    importBusy.value = false
  }
}

async function remove(row: EnvRow): Promise<void> {
  try {
    await ElMessageBox.confirm(`确认删除环境 ${row.displayId} ${row.name}？将同时删除 Profile。`, '删除', {
      type: 'warning'
    })
    await invoke('environment:delete', row.id, 'config+profile')
    ElMessage.success('已删除')
    await refresh()
  } catch {
    /* cancel */
  }
}

async function batchRemove(): Promise<void> {
  if (!hasSelection.value) return
  try {
    await ElMessageBox.confirm(
      `确认删除选中的 ${selectedIds.value.length} 个环境？将同时删除 Profile。`,
      '批量删除',
      { type: 'warning' }
    )
    batchBusy.value = true
    const result = await invoke<BatchResult>(
      'environment:deleteMany',
      [...selectedIds.value],
      'config+profile'
    )
    summarizeBatch(result, '批量删除')
    selectedIds.value = []
    await refresh()
  } catch {
    /* cancel */
  } finally {
    batchBusy.value = false
  }
}

onMounted(async () => {
  await refresh()
  void refreshLatencies()
  statusOff = window.browserBox.on('environment:status', onEnvStatus)
  statusTimer = setInterval(() => void refresh(true), 2000)
  latencyTimer = setInterval(() => void refreshLatencies(), 3000)
})

onUnmounted(() => {
  statusOff?.()
  if (statusTimer) clearInterval(statusTimer)
  if (latencyTimer) clearInterval(latencyTimer)
})
</script>

<template>
  <div>
    <div class="head">
      <div>
        <h2>环境管理</h2>
        <p v-if="hasSelection" class="sub">已选 {{ selectedIds.length }} 个</p>
        <p v-else class="sub">创建时自动随机轻量硬件指纹；行内「指纹」可查看档案与采集结果，语言/时区见「设置 → 地区语言同步」。</p>
      </div>
      <div class="actions">
        <el-button :loading="latencyRefreshing" @click="refreshLatencies">刷新延迟</el-button>
        <el-button @click="refresh()">刷新</el-button>
        <el-button :loading="importBusy" @click="doImportBox">导入</el-button>
        <el-button :disabled="!rows.length" @click="openExportDialog">导出</el-button>
        <el-button :disabled="!hasSelection" :loading="batchBusy" type="success" @click="batchStart">
          批量启动
        </el-button>
        <el-button :disabled="!hasSelection" :loading="batchBusy" type="warning" @click="batchStop">
          批量关闭
        </el-button>
        <el-button :disabled="!hasSelection" :loading="batchBusy" type="danger" plain @click="batchRemove">
          批量删除
        </el-button>
        <el-button @click="openBatchCreate">批量创建</el-button>
        <el-button type="primary" @click="openCreate">新建环境</el-button>
      </div>
    </div>

    <el-table
      ref="tableRef"
      :data="rows"
      v-loading="loading"
      stripe
      border
      row-key="id"
      @selection-change="onSelectionChange"
    >
      <el-table-column type="selection" width="48" reserve-selection />
      <el-table-column prop="displayId" label="编号" width="80" />
      <el-table-column label="图标" width="72" align="center">
        <template #default="{ row }">
          <div class="env-icon-cell">
            <AppIcon :size="22" class="env-app-icon" />
            <span class="env-icon-badge">{{ row.displayId }}</span>
          </div>
        </template>
      </el-table-column>
      <el-table-column prop="name" label="名称" min-width="140" />
      <el-table-column label="状态" width="110">
        <template #default="{ row }">
          <el-tag :key="`${row.id}-${row.status}`" :type="statusTagType(row.status)" size="small" effect="dark">
            {{ statusText(row.status) }}
          </el-tag>
        </template>
      </el-table-column>
      <el-table-column label="代理" min-width="220">
        <template #default="{ row }">
          <div v-if="!row.proxyId" class="proxy-cell proxy-direct">直连</div>
          <div v-else class="proxy-cell">
            <div class="proxy-row-main">
              <span class="proxy-type">{{ proxyTypeText(row.proxyId) }}</span>
              <span class="proxy-sep">·</span>
              <span class="proxy-name" :title="proxyNameText(row.proxyId)">{{ proxyNameText(row.proxyId) }}</span>
            </div>
            <div class="proxy-row-meta">
              <CountryFlag :code="proxyCountry(row.proxyId)" size="sm" />
              <span class="proxy-latency" :class="latencyClass(row.proxyId)">
                {{ proxyLatencyText(row.proxyId) }}
              </span>
            </div>
          </div>
        </template>
      </el-table-column>
      <el-table-column label="浏览器" min-width="160">
        <template #default="{ row }">{{ browserLabel(row.browserVersion) }}</template>
      </el-table-column>
      <el-table-column label="语言" width="110">
        <template #default="{ row }">
          {{ LANGUAGE_PRESETS.find((p) => p.id === row.browserLang)?.label?.split(' ')[0] || '自动' }}
        </template>
      </el-table-column>
      <el-table-column label="操作" width="390" fixed="right">
        <template #default="{ row }">
          <el-button link type="primary" :disabled="row.status === 'running' || row.status === 'starting'" @click="start(row)">
            启动
          </el-button>
          <el-button
            link
            type="success"
            :disabled="row.status !== 'running' && row.status !== 'starting'"
            @click="focusEnv(row)"
          >
            定位
          </el-button>
          <el-button link type="warning" :disabled="row.status === 'stopped'" @click="stop(row)">关闭</el-button>
          <el-button link type="primary" @click="openFingerprint(row)">指纹</el-button>
          <el-button link @click="openEdit(row)">编辑</el-button>
          <el-button link type="danger" @click="remove(row)">删除</el-button>
        </template>
      </el-table-column>
    </el-table>

    <el-dialog v-model="dialogVisible" :title="dialogTitle" width="480px" @closed="resetForm">
      <el-form label-width="90px">
        <el-form-item label="名称">
          <el-input v-model="form.name" placeholder="例如 韩国001" />
        </el-form-item>
        <el-form-item label="代理">
          <el-select v-model="form.proxyId" clearable placeholder="直连" style="width: 100%">
            <el-option
              v-for="p in proxies"
              :key="p.id"
              :label="`${PROXY_TYPE_LABEL[p.type]} ${p.host}:${p.port}${typeof p.latencyMs === 'number' ? ' · ' + p.latencyMs + 'ms' : ''}`"
              :value="p.id"
            />
          </el-select>
        </el-form-item>
        <el-form-item label="浏览器">
          <el-select v-model="form.browserVersion" clearable placeholder="使用默认" style="width: 100%">
            <el-option
              v-for="b in browsers"
              :key="b.id"
              :label="b.label"
              :value="b.id"
            />
          </el-select>
        </el-form-item>
        <el-form-item label="浏览器语言">
          <el-select v-model="form.browserLang" clearable placeholder="自动（跟随代理国家 / 系统）" style="width: 100%">
            <el-option
              v-for="p in LANGUAGE_PRESETS"
              :key="p.id"
              :label="p.label"
              :value="p.id"
            />
          </el-select>
          <div class="hint">单独指定后优先于「设置 → 地区语言同步」；时区仍优先跟代理国家。</div>
        </el-form-item>
        <el-form-item label="备注">
          <el-input v-model="form.remark" type="textarea" />
        </el-form-item>
        <el-form-item v-if="!isEdit" label="随机浏览器指纹">
          <el-switch v-model="form.randomFingerprint" />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="dialogVisible = false">取消</el-button>
        <el-button type="primary" :loading="saving" @click="saveEnv">保存</el-button>
      </template>
    </el-dialog>

    <el-dialog v-model="exportDialogVisible" title="导出环境" width="460px">
      <el-form label-width="110px">
        <el-form-item label="范围">
          <div class="hint">{{ exportScopeText }}（含 Profile；请先关闭运行中的环境）</div>
        </el-form-item>
        <el-form-item label="导出代理">
          <el-switch v-model="exportIncludeProxies" />
          <div class="hint">勾选后导出完整代理信息（含账号密码）。.box 请妥善保管。</div>
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="exportDialogVisible = false">取消</el-button>
        <el-button type="primary" :loading="exportBusy" @click="doExportBox">导出</el-button>
      </template>
    </el-dialog>

    <el-dialog v-model="batchDialogVisible" title="批量创建环境" width="520px">
      <el-form label-width="100px">
        <el-form-item label="数量">
          <el-input-number v-model="batchForm.count" :min="1" :max="200" />
        </el-form-item>
        <el-form-item label="名称前缀">
          <el-input v-model="batchForm.namePrefix" placeholder="例如 韩国 → 韩国001" />
        </el-form-item>
        <el-form-item label="代理">
          <el-select
            v-model="batchForm.proxyIds"
            multiple
            clearable
            collapse-tags
            collapse-tags-tooltip
            placeholder="不选则直连；多选按顺序轮询分配"
            style="width: 100%"
          >
            <el-option
              v-for="p in proxies"
              :key="p.id"
              :label="`${PROXY_TYPE_LABEL[p.type]} · ${p.name || p.host}:${p.port}`"
              :value="p.id"
            />
          </el-select>
        </el-form-item>
        <el-form-item label="浏览器">
          <el-select v-model="batchForm.browserVersion" clearable placeholder="使用默认" style="width: 100%">
            <el-option
              v-for="b in browsers"
              :key="b.id"
              :label="b.label"
              :value="b.id"
            />
          </el-select>
        </el-form-item>
        <el-form-item label="浏览器语言">
          <el-select v-model="batchForm.browserLang" clearable placeholder="自动（跟随代理国家 / 系统）" style="width: 100%">
            <el-option
              v-for="p in LANGUAGE_PRESETS"
              :key="p.id"
              :label="p.label"
              :value="p.id"
            />
          </el-select>
        </el-form-item>
        <el-form-item label="备注">
          <el-input v-model="batchForm.remark" type="textarea" />
        </el-form-item>
        <el-form-item label="随机浏览器指纹">
          <el-switch v-model="batchForm.randomFingerprint" />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="batchDialogVisible = false">取消</el-button>
        <el-button type="primary" :loading="saving" @click="saveBatchCreate">创建</el-button>
      </template>
    </el-dialog>

    <el-drawer v-model="fpDrawerVisible" :title="`指纹 · ${fpEnvLabel}`" size="460px" destroy-on-close>
      <div class="fp-toolbar">
        <el-tag :type="fpUsageTagType" size="small">{{ fpUsageLabel }}</el-tag>
        <el-tag :type="fpLive ? 'success' : 'info'" size="small">
          {{ fpLive ? '实时采集' : '缓存 / 未运行' }}
        </el-tag>
        <el-button size="small" :loading="fpLoading" @click="loadFingerprint(fpEnvId)">刷新</el-button>
        <el-button
          size="small"
          type="warning"
          plain
          :disabled="!fpEnvStopped"
          :loading="fpRegenBusy"
          @click="regenerateFingerprint"
        >
          重新随机指纹
        </el-button>
      </div>

      <el-descriptions v-if="fpProfile" title="伪装档案" :column="1" border size="small" class="fp-block">
        <el-descriptions-item label="生成时间">{{ fpProfile.generatedAt }}</el-descriptions-item>
        <el-descriptions-item label="seed">
          <span class="fp-mono">{{ fpProfile.seed }}</span>
        </el-descriptions-item>
        <el-descriptions-item label="User-Agent">
          <span class="fp-mono">{{ fpProfile.userAgent }}</span>
        </el-descriptions-item>
        <el-descriptions-item label="platform">{{ fpProfile.platform }}</el-descriptions-item>
        <el-descriptions-item label="languages">{{ fpProfile.languages?.join(', ') }}</el-descriptions-item>
        <el-descriptions-item label="CPU 并发">{{ fpProfile.hardwareConcurrency }}</el-descriptions-item>
        <el-descriptions-item label="deviceMemory">{{ fpProfile.deviceMemory }}</el-descriptions-item>
        <el-descriptions-item label="屏幕">
          {{ fpProfile.screen.width }}×{{ fpProfile.screen.height }}
          · {{ fpProfile.screen.colorDepth }}bit
          · DPR {{ fpProfile.screen.pixelRatio }}
        </el-descriptions-item>
        <el-descriptions-item label="WebGL Vendor">{{ fpProfile.webglVendor }}</el-descriptions-item>
        <el-descriptions-item label="WebGL Renderer">{{ fpProfile.webglRenderer }}</el-descriptions-item>
      </el-descriptions>

      <el-descriptions v-if="fpProxyCountry || fpApplied" title="地区对照" :column="1" border size="small" class="fp-block">
        <el-descriptions-item label="代理国家">
          <CountryFlag v-if="fpProxyCountry" :code="fpProxyCountry" size="sm" />
          <span v-else>—</span>
        </el-descriptions-item>
        <el-descriptions-item v-if="fpApplied" label="已应用语言">{{ fpApplied.lang }}</el-descriptions-item>
        <el-descriptions-item v-if="fpApplied" label="Accept-Language">{{ fpApplied.acceptLanguages }}</el-descriptions-item>
        <el-descriptions-item v-if="fpApplied" label="目标时区">{{ fpApplied.timezone }}</el-descriptions-item>
        <el-descriptions-item v-if="fpApplied" label="目标 Locale">{{ fpApplied.locale }}</el-descriptions-item>
      </el-descriptions>

      <el-empty v-if="!fpSnapshot && !fpLoading" description="暂无采集数据，启动环境后可对照伪装是否生效" />
      <el-descriptions
        v-else-if="fpSnapshot"
        title="实际采集"
        :column="1"
        border
        size="small"
        class="fp-block"
        v-loading="fpLoading"
      >
        <el-descriptions-item label="采集时间">{{ fpSnapshot.collectedAt }}</el-descriptions-item>
        <el-descriptions-item label="User-Agent">
          <span class="fp-mono">{{ fpSnapshot.userAgent }}</span>
        </el-descriptions-item>
        <el-descriptions-item label="language">{{ fpSnapshot.language }}</el-descriptions-item>
        <el-descriptions-item label="languages">{{ fpSnapshot.languages?.join(', ') }}</el-descriptions-item>
        <el-descriptions-item label="timezone">{{ fpSnapshot.timezone }}</el-descriptions-item>
        <el-descriptions-item label="locale">{{ fpSnapshot.locale || '—' }}</el-descriptions-item>
        <el-descriptions-item label="platform">{{ fpSnapshot.platform }}</el-descriptions-item>
        <el-descriptions-item label="CPU 并发">{{ fpSnapshot.hardwareConcurrency ?? '—' }}</el-descriptions-item>
        <el-descriptions-item label="deviceMemory">{{ fpSnapshot.deviceMemory ?? '—' }}</el-descriptions-item>
        <el-descriptions-item label="屏幕">
          {{ fpSnapshot.screen.width }}×{{ fpSnapshot.screen.height }}
          · {{ fpSnapshot.screen.colorDepth }}bit
          · DPR {{ fpSnapshot.screen.pixelRatio }}
        </el-descriptions-item>
        <el-descriptions-item label="Canvas hash">{{ fpSnapshot.canvasHash || '—' }}</el-descriptions-item>
        <el-descriptions-item label="WebGL Vendor">{{ fpSnapshot.webglVendor || '—' }}</el-descriptions-item>
        <el-descriptions-item label="WebGL Renderer">{{ fpSnapshot.webglRenderer || '—' }}</el-descriptions-item>
      </el-descriptions>
    </el-drawer>
  </div>
</template>

<style scoped>
.head {
  display: flex;
  justify-content: space-between;
  align-items: flex-start;
  margin-bottom: 16px;
  gap: 12px;
}
h2 {
  margin: 0 0 4px;
}
.sub {
  margin: 0;
  font-size: 13px;
  color: var(--bb-muted);
}
.actions {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  justify-content: flex-end;
}
.proxy-cell {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 4px 0;
  line-height: 1.35;
  min-width: 0;
}
.proxy-direct {
  color: var(--bb-muted);
  font-size: 13px;
}
.proxy-row-main {
  display: flex;
  align-items: baseline;
  gap: 6px;
  min-width: 0;
}
.proxy-type {
  flex-shrink: 0;
  font-weight: 600;
  font-size: 13px;
}
.proxy-sep {
  flex-shrink: 0;
  color: var(--bb-muted);
  font-size: 12px;
}
.proxy-name {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 13px;
  color: var(--bb-text);
}
.proxy-row-meta {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  min-width: 0;
}
.proxy-latency {
  flex-shrink: 0;
  font-size: 12px;
  font-variant-numeric: tabular-nums;
}
.lat-good {
  color: #059669;
}
.lat-mid {
  color: #d97706;
}
.lat-slow {
  color: #dc2626;
}
.lat-bad {
  color: #dc2626;
}
.lat-muted {
  color: var(--bb-muted);
}
.env-icon-cell {
  position: relative;
  width: 28px;
  height: 28px;
  margin: 0 auto;
  display: flex;
  align-items: center;
  justify-content: center;
}
.env-app-icon {
  color: #2563eb;
}
.env-icon-badge {
  position: absolute;
  top: -2px;
  left: 50%;
  transform: translateX(-50%);
  min-width: 18px;
  padding: 0 3px;
  height: 12px;
  line-height: 12px;
  border-radius: 3px;
  background: rgba(15, 23, 42, 0.9);
  color: #fff;
  font-size: 9px;
  font-weight: 700;
  font-variant-numeric: tabular-nums;
  text-align: center;
  pointer-events: none;
}
.fp-toolbar {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 8px;
  margin-bottom: 12px;
}
.fp-block {
  margin-bottom: 16px;
}
.fp-mono {
  word-break: break-all;
  font-family: ui-monospace, Consolas, monospace;
  font-size: 12px;
}
.hint {
  font-size: 12px;
  color: var(--bb-muted);
  line-height: 1.5;
}
</style>
