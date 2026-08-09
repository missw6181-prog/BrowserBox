<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { invoke } from '../services/api'
import type { ProxyStatus, ProxyType, ProxyViewRow } from '@shared/types'
import CountryFlag from '../components/CountryFlag.vue'

interface BatchResult {
  ok: string[]
  failed: Array<{ id: string; message: string }>
}

const rows = ref<ProxyViewRow[]>([])
const loading = ref(false)
const dialogVisible = ref(false)
const editingId = ref<string | null>(null)
const saving = ref(false)
const importVisible = ref(false)
const importText = ref('')
const exporting = ref(false)
const batchBusy = ref(false)
const selectedIds = ref<string[]>([])
const form = reactive({
  name: '',
  type: 'http' as ProxyType,
  host: '',
  port: 8080,
  username: '',
  password: '',
  remark: ''
})

const STATUS_LABEL: Record<ProxyStatus, string> = {
  untested: '未测试',
  testing: '测试中',
  ok: '正常',
  auth_failed: '认证失败',
  connection_failed: '连接失败',
  timeout: '超时',
  unknown_error: '未知错误'
}

const isEdit = computed(() => !!editingId.value)
const dialogTitle = computed(() => (isEdit.value ? '编辑代理' : '添加代理'))
const hasSelection = computed(() => selectedIds.value.length > 0)

async function refresh(): Promise<void> {
  loading.value = true
  try {
    const list = await invoke<ProxyViewRow[]>('proxy:listDetailed')
    rows.value = list
    const idSet = new Set(list.map((r) => r.id))
    selectedIds.value = selectedIds.value.filter((id) => idSet.has(id))
  } catch (e) {
    ElMessage.error((e as Error).message)
  } finally {
    loading.value = false
  }
}

function onSelectionChange(selection: ProxyViewRow[]): void {
  selectedIds.value = selection.map((r) => r.id)
}

function resetForm(): void {
  editingId.value = null
  form.name = ''
  form.type = 'http'
  form.host = ''
  form.port = 8080
  form.username = ''
  form.password = ''
  form.remark = ''
}

function openCreate(): void {
  resetForm()
  dialogVisible.value = true
}

function openEdit(row: ProxyViewRow): void {
  editingId.value = row.id
  form.name = row.name
  form.type = row.type
  form.host = row.host
  form.port = row.port
  form.username = row.username || ''
  form.password = row.password || ''
  form.remark = row.remark || ''
  dialogVisible.value = true
}

async function saveProxy(): Promise<void> {
  if (!form.host.trim()) {
    ElMessage.warning('请填写主机地址')
    return
  }
  saving.value = true
  try {
    const payload = {
      name: form.name,
      type: form.type,
      host: form.host.trim(),
      port: form.port,
      username: form.username,
      password: form.password,
      remark: form.remark
    }
    if (editingId.value) {
      await invoke('proxy:update', editingId.value, payload)
      ElMessage.success('已保存')
    } else {
      await invoke('proxy:create', payload)
      ElMessage.success('已添加代理')
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

async function testProxy(row: ProxyViewRow): Promise<void> {
  try {
    ElMessage.info('测试中…')
    const result = await invoke<{ status: string; exitIp?: string; country?: string; latencyMs?: number; error?: string }>(
      'proxy:test',
      row.id
    )
    if (result.status === 'ok') {
      ElMessage.success(`正常 · ${result.exitIp} · ${result.country} · ${result.latencyMs}ms`)
    } else {
      ElMessage.error('测试失败')
    }
    await refresh()
  } catch {
    ElMessage.error('测试失败')
  }
}

async function remove(row: ProxyViewRow): Promise<void> {
  try {
    await ElMessageBox.confirm(`删除代理 ${row.name}？`, '确认', { type: 'warning' })
    await invoke('proxy:delete', row.id, false)
    ElMessage.success('已删除')
    await refresh()
  } catch (e) {
    if ((e as Error).message?.includes('正在被')) {
      try {
        await ElMessageBox.confirm((e as Error).message + ' 是否强制删除并解绑？', '强制删除', { type: 'warning' })
        await invoke('proxy:delete', row.id, true)
        ElMessage.success('已强制删除')
        await refresh()
      } catch {
        /* cancel */
      }
    }
  }
}

async function batchRemove(): Promise<void> {
  if (!hasSelection.value) return
  const ids = [...selectedIds.value]
  try {
    await ElMessageBox.confirm(`确认删除选中的 ${ids.length} 个代理？`, '批量删除', { type: 'warning' })
  } catch {
    return
  }

  batchBusy.value = true
  try {
    let result = await invoke<BatchResult>('proxy:deleteMany', ids, false)
    if (result.failed.length) {
      const inUse = result.failed.filter((f) => f.message.includes('正在被'))
      if (inUse.length) {
        try {
          await ElMessageBox.confirm(
            `其中 ${inUse.length} 个代理正在被环境使用。是否强制删除并解绑？`,
            '强制删除',
            { type: 'warning', confirmButtonText: '强制删除', cancelButtonText: '跳过' }
          )
          const forced = await invoke<BatchResult>(
            'proxy:deleteMany',
            inUse.map((f) => f.id),
            true
          )
          result = {
            ok: [...result.ok, ...forced.ok],
            failed: [
              ...result.failed.filter((f) => !f.message.includes('正在被')),
              ...forced.failed
            ]
          }
        } catch {
          /* skip force */
        }
      }
    }
    if (result.failed.length === 0) {
      ElMessage.success(`已删除 ${result.ok.length} 个代理`)
    } else {
      ElMessage.warning(`删除成功 ${result.ok.length} 个，失败 ${result.failed.length} 个`)
    }
    selectedIds.value = []
    await refresh()
  } catch (e) {
    ElMessage.error((e as Error).message)
  } finally {
    batchBusy.value = false
  }
}

async function doImport(): Promise<void> {
  try {
    const res = await invoke<{ created: number; failed: number; errors: string[] }>('proxy:import', importText.value)
    ElMessage.success(`导入成功 ${res.created}，失败 ${res.failed}`)
    importVisible.value = false
    importText.value = ''
    await refresh()
  } catch (e) {
    ElMessage.error((e as Error).message)
  }
}

async function doExport(): Promise<void> {
  if (!rows.value.length) {
    ElMessage.warning('暂无代理可导出')
    return
  }
  exporting.value = true
  try {
    const res = await invoke<{ path: string }>('proxy:export')
    ElMessage.success(`已导出：${res.path}`)
  } catch (e) {
    if (String((e as Error).message || e).includes('取消')) return
    ElMessage.error((e as Error).message)
  } finally {
    exporting.value = false
  }
}

function statusText(status: ProxyStatus): string {
  return STATUS_LABEL[status] || status
}

onMounted(() => void refresh())
</script>

<template>
  <div>
    <div class="head">
      <div>
        <h2>代理管理</h2>
        <p class="desc">支持 HTTP / HTTPS / SOCKS4 / SOCKS5；密码本地加密存储，页面可查看；导出为 TXT（含账号密码）请妥善保管</p>
        <p v-if="hasSelection" class="sub">已选 {{ selectedIds.length }} 个</p>
      </div>
      <div class="actions">
        <el-button :disabled="!hasSelection" :loading="batchBusy" type="danger" plain @click="batchRemove">
          批量删除
        </el-button>
        <el-button :loading="exporting" @click="doExport">导出</el-button>
        <el-button @click="importVisible = true">批量导入</el-button>
        <el-button type="primary" @click="openCreate">添加代理</el-button>
      </div>
    </div>

    <el-card shadow="never" class="format-card">
      <template #header>
        <div class="card-head">各类型代理格式</div>
      </template>
      <div class="format-grid">
        <div class="format-item">
          <div class="format-title">HTTP</div>
          <code>http://1.1.1.1:8080</code>
          <code>http://user:pass@1.1.1.1:8080</code>
        </div>
        <div class="format-item">
          <div class="format-title">HTTPS</div>
          <code>https://1.1.1.1:8443</code>
          <code>https://user:pass@1.1.1.1:8443</code>
        </div>
        <div class="format-item">
          <div class="format-title">SOCKS4</div>
          <code>socks4://1.1.1.1:1080</code>
          <code>socks4://user:pass@1.1.1.1:1080</code>
        </div>
        <div class="format-item">
          <div class="format-title">SOCKS5</div>
          <code>socks5://1.1.1.1:1080</code>
          <code>socks5://user:pass@1.1.1.1:1080</code>
        </div>
      </div>
    </el-card>

    <el-table
      :data="rows"
      v-loading="loading"
      stripe
      border
      row-key="id"
      @selection-change="onSelectionChange"
    >
      <el-table-column type="selection" width="48" />
      <el-table-column prop="name" label="名称" min-width="110" />
      <el-table-column prop="type" label="类型" width="90" />
      <el-table-column prop="address" label="地址" min-width="150" />
      <el-table-column label="状态" width="100">
        <template #default="{ row }">{{ statusText(row.status) }}</template>
      </el-table-column>
      <el-table-column prop="exitIp" label="出口IP" width="130" />
      <el-table-column label="国家" width="120">
        <template #default="{ row }">
          <CountryFlag :code="row.country" />
        </template>
      </el-table-column>
      <el-table-column prop="username" label="账号" min-width="100" show-overflow-tooltip />
      <el-table-column prop="password" label="密码" min-width="100" show-overflow-tooltip />
      <el-table-column label="延迟" width="80">
        <template #default="{ row }">
          {{ typeof row.latencyMs === 'number' ? row.latencyMs + 'ms' : '—' }}
        </template>
      </el-table-column>
      <el-table-column label="操作" width="180" fixed="right">
        <template #default="{ row }">
          <el-button link type="primary" @click="testProxy(row)">测试</el-button>
          <el-button link @click="openEdit(row)">编辑</el-button>
          <el-button link type="danger" @click="remove(row)">删除</el-button>
        </template>
      </el-table-column>
    </el-table>

    <el-dialog v-model="dialogVisible" :title="dialogTitle" width="520px" @closed="resetForm">
      <el-form label-width="80px">
        <el-form-item label="名称"><el-input v-model="form.name" /></el-form-item>
        <el-form-item label="类型">
          <el-select v-model="form.type" style="width: 100%">
            <el-option value="http" label="HTTP" />
            <el-option value="https" label="HTTPS" />
            <el-option value="socks4" label="SOCKS4" />
            <el-option value="socks5" label="SOCKS5" />
          </el-select>
        </el-form-item>
        <el-form-item label="主机"><el-input v-model="form.host" /></el-form-item>
        <el-form-item label="端口"><el-input-number v-model="form.port" :min="1" :max="65535" /></el-form-item>
        <el-form-item label="用户名"><el-input v-model="form.username" /></el-form-item>
        <el-form-item label="密码"><el-input v-model="form.password" type="password" show-password /></el-form-item>
        <el-form-item label="备注"><el-input v-model="form.remark" /></el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="dialogVisible = false">取消</el-button>
        <el-button type="primary" :loading="saving" @click="saveProxy">保存</el-button>
      </template>
    </el-dialog>

    <el-dialog v-model="importVisible" title="批量导入" width="620px">
      <div class="import-help">
        <p>每行一条，支持以下格式：</p>
        <ul>
          <li><code>http://1.1.1.1:8080</code>　<code>http://user:pass@1.1.1.1:8080</code></li>
          <li><code>https://1.1.1.1:8443</code>　<code>https://user:pass@1.1.1.1:8443</code></li>
          <li><code>socks4://1.1.1.1:1080</code>　<code>socks4://user:pass@1.1.1.1:1080</code></li>
          <li><code>socks5://1.1.1.1:1080</code>　<code>socks5://user:pass@1.1.1.1:1080</code></li>
        </ul>
      </div>
      <el-input v-model="importText" type="textarea" :rows="12" placeholder="粘贴代理列表…" />
      <template #footer>
        <el-button @click="importVisible = false">取消</el-button>
        <el-button type="primary" @click="doImport">导入</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<style scoped>
.head {
  display: flex;
  justify-content: space-between;
  margin-bottom: 16px;
  gap: 12px;
}
h2 {
  margin: 0 0 4px;
}
.desc {
  margin: 0;
  color: var(--bb-muted);
  font-size: 13px;
}
.sub {
  margin: 6px 0 0;
  font-size: 13px;
  color: var(--bb-muted);
}
.actions {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  justify-content: flex-end;
  align-items: flex-start;
}
.format-card {
  margin-bottom: 16px;
}
.card-head {
  font-weight: 600;
}
.format-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 14px 20px;
}
.format-item {
  display: flex;
  flex-direction: column;
  gap: 4px;
  min-width: 0;
}
.format-title {
  font-weight: 600;
  font-size: 13px;
  margin-bottom: 2px;
}
.format-item code,
.import-help code {
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: 12px;
  background: #f1f5f9;
  padding: 2px 6px;
  border-radius: 4px;
  word-break: break-all;
}
.import-help {
  margin: 0 0 12px;
  font-size: 13px;
  color: var(--bb-muted);
  line-height: 1.55;
}
.import-help p {
  margin: 0 0 6px;
}
.import-help ul {
  margin: 0;
  padding-left: 18px;
}
.import-help li {
  margin: 4px 0;
}
@media (max-width: 900px) {
  .format-grid {
    grid-template-columns: 1fr;
  }
}
</style>
