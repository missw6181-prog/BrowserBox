<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { invoke } from '../services/api'
import type { AppSettings, CloseAction } from '@shared/types'

const form = reactive({
  dataDir: '',
  defaultBrowserVersion: '',
  launchIntervalMs: 1000,
  logLevel: 'INFO' as AppSettings['logLevel'],
  closeAction: 'ask' as CloseAction,
  syncLocaleWithProxy: true,
  fingerprintMode: 'ua' as AppSettings['fingerprintMode']
})

const preferredDataDir = ref('')
const dataDirMode = ref<'default' | 'custom'>('default')
const customDataDir = ref('')
const browsers = ref<Array<{ id: string; label: string }>>([])
const switching = ref(false)
const saving = ref(false)

const previewDataDir = computed(() =>
  dataDirMode.value === 'default' ? preferredDataDir.value : customDataDir.value || preferredDataDir.value
)

const dataDirChanged = computed(() => {
  const next = previewDataDir.value.replace(/\\/g, '/').replace(/\/+$/, '')
  const cur = form.dataDir.replace(/\\/g, '/').replace(/\/+$/, '')
  return !!next && next.toLowerCase() !== cur.toLowerCase()
})

async function load(): Promise<void> {
  const s = await invoke<AppSettings & { preferredDataDir?: string }>('settings:get')
  const info = await invoke<{ dataDir: string; preferredDataDir: string; isDefault: boolean }>(
    'app:getDataDirInfo'
  )
  form.dataDir = info.dataDir || s.dataDir
  preferredDataDir.value = info.preferredDataDir
  form.defaultBrowserVersion = s.defaultBrowserVersion
  form.launchIntervalMs = s.launchIntervalMs
  form.logLevel = s.logLevel
  form.closeAction = s.closeAction || 'ask'
  form.syncLocaleWithProxy = s.syncLocaleWithProxy !== false
  form.fingerprintMode =
    s.fingerprintMode === 'off' || s.fingerprintMode === 'cdp' || s.fingerprintMode === 'ua'
      ? s.fingerprintMode
      : 'ua'
  dataDirMode.value = info.isDefault ? 'default' : 'custom'
  customDataDir.value = info.isDefault ? '' : info.dataDir
  browsers.value = await invoke('browser:list')
}

async function chooseCustomDir(): Promise<void> {
  try {
    const res = await invoke<{ path: string }>('app:chooseDataDir')
    customDataDir.value = res.path
    dataDirMode.value = 'custom'
  } catch (e) {
    if (String(e).includes('取消')) return
    ElMessage.error(String(e))
  }
}

async function applyDataDir(): Promise<void> {
  const next = previewDataDir.value.trim()
  if (!next) {
    ElMessage.warning('请先选择数据目录')
    return
  }
  if (!dataDirChanged.value) {
    ElMessage.info('数据目录未变化')
    return
  }
  try {
    await ElMessageBox.confirm(
      `切换数据目录将先关闭所有已启动的浏览器，然后加载新目录下的配置。\n\n新目录：\n${next}\n\n是否继续？`,
      '切换数据目录',
      { type: 'warning', confirmButtonText: '切换并重载', cancelButtonText: '取消' }
    )
  } catch {
    return
  }
  switching.value = true
  try {
    await invoke('app:switchDataDir', next)
    ElMessage.success('数据目录已切换，正在重载…')
    location.reload()
  } catch (e) {
    ElMessage.error((e as Error).message)
  } finally {
    switching.value = false
  }
}

async function save(): Promise<void> {
  saving.value = true
  try {
    await invoke('settings:update', {
      defaultBrowserVersion: form.defaultBrowserVersion,
      launchIntervalMs: form.launchIntervalMs,
      logLevel: form.logLevel,
      closeAction: form.closeAction,
      syncLocaleWithProxy: form.syncLocaleWithProxy,
      fingerprintMode: form.fingerprintMode
    })
    ElMessage.success('已保存')
  } catch (e) {
    ElMessage.error((e as Error).message)
  } finally {
    saving.value = false
  }
}

onMounted(() => void load())
</script>

<template>
  <div>
    <h2>设置</h2>
    <el-form label-width="140px" style="max-width: 720px; margin-top: 16px">
      <el-form-item label="数据目录">
        <div class="data-dir">
          <el-radio-group v-model="dataDirMode">
            <el-radio value="default">默认目录（安装目录）</el-radio>
            <el-radio value="custom">自定义目录</el-radio>
          </el-radio-group>
          <div class="path-row">
            <el-input :model-value="previewDataDir" readonly placeholder="数据目录路径" />
            <el-button v-if="dataDirMode === 'custom'" @click="chooseCustomDir">浏览…</el-button>
            <el-button type="primary" plain :loading="switching" :disabled="!dataDirChanged" @click="applyDataDir">
              应用
            </el-button>
          </div>
          <div class="hint">
            当前：{{ form.dataDir || '—' }}
            <template v-if="preferredDataDir">；默认：{{ preferredDataDir }}</template>
          </div>
          <div class="hint">切换目录不会自动迁移旧数据，请自行备份或复制 Data 文件夹。</div>
        </div>
      </el-form-item>
      <el-form-item label="关闭窗口时">
        <div class="close-action">
          <el-select v-model="form.closeAction" style="width: 100%">
            <el-option label="每次询问（推荐）" value="ask" />
            <el-option label="退出并关闭全部环境" value="quit" />
            <el-option label="最小化到系统托盘" value="tray" />
          </el-select>
          <div class="hint">
            未设置或选择「每次询问」时，点关闭会弹出确认框。选择另外两项后，关闭窗口将直接执行对应动作。
          </div>
        </div>
      </el-form-item>
      <el-form-item label="地区语言同步">
        <div class="close-action">
          <el-switch v-model="form.syncLocaleWithProxy" active-text="开启" inactive-text="关闭" />
          <div class="hint">
            开启后，未单独指定语言的环境会按绑定代理国家同步语言 / Accept-Language / 时区。环境编辑里可覆盖语言。
          </div>
        </div>
      </el-form-item>
      <el-form-item label="指纹信息">
        <el-select v-model="form.fingerprintMode" style="width: 100%">
          <el-option label="简单伪装" value="ua" />
          <el-option label="深度伪装" value="cdp" />
          <el-option label="关闭" value="off" />
        </el-select>
      </el-form-item>
      <el-form-item label="默认浏览器">
        <el-select v-model="form.defaultBrowserVersion" clearable placeholder="自动选择" style="width: 100%">
          <el-option v-for="b in browsers" :key="b.id" :label="b.label" :value="b.id" />
        </el-select>
      </el-form-item>
      <el-form-item label="批量启动间隔(ms)">
        <el-input-number v-model="form.launchIntervalMs" :min="0" :step="500" />
      </el-form-item>
      <el-form-item label="日志级别">
        <el-select v-model="form.logLevel" style="width: 200px">
          <el-option value="DEBUG" />
          <el-option value="INFO" />
          <el-option value="WARN" />
          <el-option value="ERROR" />
        </el-select>
      </el-form-item>
      <el-form-item>
        <el-button type="primary" :loading="saving" @click="save">保存</el-button>
      </el-form-item>
    </el-form>
  </div>
</template>

<style scoped>
h2 {
  margin: 0;
}
.data-dir,
.close-action {
  width: 100%;
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.path-row {
  display: flex;
  gap: 8px;
  width: 100%;
}
.hint {
  font-size: 12px;
  color: var(--bb-muted);
  line-height: 1.4;
}
</style>
