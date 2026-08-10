import { ipcMain, dialog, BrowserWindow, app } from 'electron'
import { writeFileSync } from 'fs'
import { configManager } from '../config/ConfigManager'
import { environmentManager } from '../environment/EnvironmentManager'
import { proxyManager } from '../proxy/ProxyManager'
import { proxyTester } from '../proxy/ProxyTester'
import { browserManager } from '../browser/BrowserManager'
import { localProxyManager } from '../proxy/LocalProxyManager'
import { logger } from '../logger/Logger'
import {
  ensureDataDirReady,
  getPreferredDataDir,
  writeBoot
} from '../app/dataDir'
import { ErrorCodes } from '../../shared/types'

function ok<T>(data: T): { ok: true; data: T } {
  return { ok: true, data }
}

function fail(err: unknown): { ok: false; error: { code: string; message: string; details?: unknown } } {
  if (err && typeof err === 'object' && 'code' in err && 'message' in err) {
    const e = err as { code: string; message: string; details?: unknown }
    return { ok: false, error: e }
  }
  return { ok: false, error: { code: 'UNKNOWN', message: String(err) } }
}

export function registerIpc(): void {
  ipcMain.handle('app:getBoot', async () => {
    try {
      // 首次启动自动落到 {安装目录}/Data，无需手动选择
      const state = await ensureDataDirReady()
      return ok({
        dataDir: state.dataDir,
        ready: state.ready,
        preferredDataDir: getPreferredDataDir(),
        version: app.getVersion()
      })
    } catch (err) {
      return fail(err)
    }
  })

  ipcMain.handle('app:chooseDataDir', async () => {
    const win = BrowserWindow.getFocusedWindow()
    const result = await dialog.showOpenDialog(win!, {
      title: '选择数据目录',
      defaultPath: getPreferredDataDir(),
      properties: ['openDirectory', 'createDirectory']
    })
    if (result.canceled || !result.filePaths[0]) {
      return fail({ code: 'CANCELLED', message: '已取消' })
    }
    return ok({ path: result.filePaths[0] })
  })

  ipcMain.handle('app:initDataDir', async (_e, dataDir: string) => {
    try {
      await configManager.initialize(dataDir)
      const seeded = browserManager.seedBundledBrowsers()
      writeBoot({ dataDir })
      logger.info('app', `数据目录初始化: ${dataDir}`, { seeded })
      return ok({ settings: configManager.get('settings'), seeded })
    } catch (err) {
      return fail(err)
    }
  })

  ipcMain.handle('app:getDataDirInfo', async () => {
    try {
      const preferred = getPreferredDataDir()
      const dataDir = configManager.isReady() ? configManager.getDataDir() : preferred
      const norm = (p: string): string => p.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()
      return ok({
        dataDir,
        preferredDataDir: preferred,
        isDefault: norm(dataDir) === norm(preferred)
      })
    } catch (err) {
      return fail(err)
    }
  })

  ipcMain.handle('app:switchDataDir', async (_e, dataDir: string) => {
    try {
      const next = String(dataDir || '').trim()
      if (!next) throw { code: 'INVALID', message: '数据目录不能为空' }
      await environmentManager.stopAll(true)
      await configManager.initialize(next)
      environmentManager.clearRuntime()
      const seeded = browserManager.seedBundledBrowsers()
      writeBoot({ dataDir: next })
      logger.info('app', `已切换数据目录 ${next}`, { seeded })
      return ok({ dataDir: next, settings: configManager.get('settings'), seeded })
    } catch (err) {
      return fail(err)
    }
  })

  ipcMain.handle('settings:get', async () => {
    try {
      return ok(configManager.get('settings'))
    } catch (err) {
      return fail(err)
    }
  })

  ipcMain.handle('settings:update', async (_e, patch) => {
    try {
      return ok(configManager.updateSettings(patch))
    } catch (err) {
      return fail(err)
    }
  })

  // Environments
  ipcMain.handle('environment:list', async () => {
    try {
      return ok(environmentManager.list())
    } catch (err) {
      return fail(err)
    }
  })

  ipcMain.handle('environment:create', async (_e, input) => {
    try {
      return ok(environmentManager.create(input))
    } catch (err) {
      return fail(err)
    }
  })

  ipcMain.handle('environment:createMany', async (_e, input) => {
    try {
      return ok(environmentManager.createMany(input))
    } catch (err) {
      return fail(err)
    }
  })

  ipcMain.handle('environment:update', async (_e, id: string, patch) => {
    try {
      return ok(environmentManager.update(id, patch))
    } catch (err) {
      return fail(err)
    }
  })

  ipcMain.handle('environment:delete', async (_e, id: string, mode?: 'config' | 'config+profile') => {
    try {
      environmentManager.delete(id, mode)
      return ok(true)
    } catch (err) {
      return fail(err)
    }
  })

  ipcMain.handle('environment:deleteMany', async (_e, ids: string[], mode?: 'config' | 'config+profile') => {
    try {
      return ok(environmentManager.deleteMany(ids, mode))
    } catch (err) {
      return fail(err)
    }
  })

  ipcMain.handle('environment:clone', async (_e, id: string) => {
    try {
      return ok(environmentManager.clone(id))
    } catch (err) {
      return fail(err)
    }
  })

  ipcMain.handle('environment:start', async (_e, id: string) => {
    try {
      await environmentManager.start(id)
      return ok(true)
    } catch (err) {
      return fail(err)
    }
  })

  ipcMain.handle('environment:startMany', async (_e, ids: string[]) => {
    try {
      return ok(await environmentManager.startMany(ids))
    } catch (err) {
      return fail(err)
    }
  })

  ipcMain.handle('environment:stop', async (_e, id: string, force?: boolean) => {
    try {
      await environmentManager.stop(id, force)
      return ok(true)
    } catch (err) {
      return fail(err)
    }
  })

  ipcMain.handle('environment:focus', async (_e, id: string) => {
    try {
      return ok(await environmentManager.focus(id))
    } catch (err) {
      return fail(err)
    }
  })

  ipcMain.handle('environment:listRunning', async () => {
    try {
      return ok(environmentManager.listRunning())
    } catch (err) {
      return fail(err)
    }
  })

  ipcMain.handle('environment:getFingerprint', async (_e, id: string) => {
    try {
      return ok(await environmentManager.getFingerprint(id))
    } catch (err) {
      return fail(err)
    }
  })

  ipcMain.handle('environment:regenerateFingerprint', async (_e, id: string) => {
    try {
      return ok(environmentManager.regenerateFingerprint(id))
    } catch (err) {
      return fail(err)
    }
  })

  ipcMain.handle('environment:stopMany', async (_e, ids: string[], force?: boolean) => {
    try {
      return ok(await environmentManager.stopMany(ids, force))
    } catch (err) {
      return fail(err)
    }
  })

  // Proxies
  ipcMain.handle('proxy:list', async () => {
    try {
      return ok(proxyManager.list())
    } catch (err) {
      return fail(err)
    }
  })

  ipcMain.handle('proxy:listDetailed', async () => {
    try {
      return ok(proxyManager.listDetailed())
    } catch (err) {
      return fail(err)
    }
  })

  ipcMain.handle('proxy:export', async () => {
    try {
      const win = BrowserWindow.getFocusedWindow()
      const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')
      const saveOpts = {
        title: '导出代理',
        defaultPath: `proxies-${stamp}.txt`,
        filters: [
          { name: '文本文件', extensions: ['txt'] },
          { name: '全部文件', extensions: ['*'] }
        ]
      }
      const result = win
        ? await dialog.showSaveDialog(win, saveOpts)
        : await dialog.showSaveDialog(saveOpts)
      if (result.canceled || !result.filePath) {
        return fail({ code: 'CANCELLED', message: '已取消' })
      }
      writeFileSync(result.filePath, proxyManager.exportTxt(), 'utf8')
      return ok({ path: result.filePath })
    } catch (err) {
      return fail(err)
    }
  })

  ipcMain.handle('proxy:create', async (_e, input) => {
    try {
      return ok(proxyManager.create(input))
    } catch (err) {
      return fail(err)
    }
  })

  ipcMain.handle('proxy:update', async (_e, id: string, patch) => {
    try {
      return ok(proxyManager.update(id, patch))
    } catch (err) {
      return fail(err)
    }
  })

  ipcMain.handle('proxy:delete', async (_e, id: string, force?: boolean) => {
    try {
      proxyManager.delete(id, force)
      return ok(true)
    } catch (err) {
      return fail(err)
    }
  })

  ipcMain.handle('proxy:deleteMany', async (_e, ids: string[], force?: boolean) => {
    try {
      return ok(proxyManager.deleteMany(ids, !!force))
    } catch (err) {
      return fail(err)
    }
  })

  ipcMain.handle('proxy:import', async (_e, text: string) => {
    try {
      return ok(proxyManager.importLines(text))
    } catch (err) {
      return fail(err)
    }
  })

  ipcMain.handle('proxy:test', async (_e, id: string) => {
    try {
      return ok(await proxyTester.test(id))
    } catch (err) {
      return fail(err)
    }
  })

  /** Shadowrocket 风格：TCP 入口延迟 */
  ipcMain.handle('proxy:ping', async (_e, id: string) => {
    try {
      return ok(await proxyTester.ping(id))
    } catch (err) {
      return fail(err)
    }
  })

  ipcMain.handle('proxy:pingMany', async (_e, ids: string[]) => {
    try {
      const unique = [...new Set(ids || [])]
      const results = await Promise.all(
        unique.map(async (id) => ({ id, ...(await proxyTester.ping(id)) }))
      )
      return ok(results)
    } catch (err) {
      return fail(err)
    }
  })

  // Browser
  ipcMain.handle('browser:list', async () => {
    try {
      return ok(browserManager.listInstalled())
    } catch (err) {
      return fail(err)
    }
  })

  ipcMain.handle('browser:detectSystem', async () => {
    try {
      return ok(browserManager.detectSystemChrome())
    } catch (err) {
      return fail(err)
    }
  })

  ipcMain.handle('browser:listMilestones', async () => {
    try {
      return ok(await browserManager.listMilestones())
    } catch (err) {
      return fail(err)
    }
  })

  ipcMain.handle('browser:checkLatest', async () => {
    try {
      return ok(await browserManager.fetchLatestStable())
    } catch (err) {
      return fail(err)
    }
  })

  ipcMain.handle('browser:installLatest', async (event) => {
    try {
      const result = await browserManager.installLatestStable((msg) => {
        event.sender.send('browser:installProgress', msg)
      })
      return ok(result)
    } catch (err) {
      return fail(err)
    }
  })

  ipcMain.handle('browser:installVersion', async (event, target: string) => {
    try {
      const result = await browserManager.installVersion(target, (msg) => {
        event.sender.send('browser:installProgress', msg)
      })
      return ok(result)
    } catch (err) {
      return fail(err)
    }
  })

  ipcMain.handle('browser:setDefault', async (_e, version: string) => {
    try {
      return ok(configManager.updateSettings({ defaultBrowserVersion: version }))
    } catch (err) {
      return fail(err)
    }
  })

  ipcMain.handle('browser:uninstall', async (_e, id: string) => {
    try {
      const key = String(id || '').trim()
      const busy = environmentManager
        .list()
        .filter(
          (e) =>
            (e.status === 'running' || e.status === 'starting' || e.status === 'stopping') &&
            (e.browserVersion === key ||
              e.browserVersion === `${key}` ||
              e.browserVersion.startsWith(`${key}.`))
        )
      if (busy.length) {
        const names = busy
          .slice(0, 5)
          .map((e) => `${e.displayId}`)
          .join('、')
        throw {
          code: ErrorCodes.ENV_ALREADY_RUNNING,
          message: `有 ${busy.length} 个环境正在使用该浏览器（如 ${names}），请先关闭后再删除`
        }
      }
      browserManager.uninstall(key)
      return ok(true)
    } catch (err) {
      return fail(err)
    }
  })

  ipcMain.handle('proxy:localList', async () => {
    return ok(localProxyManager.list())
  })
}
