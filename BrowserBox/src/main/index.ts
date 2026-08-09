import { app, shell, BrowserWindow, nativeImage } from 'electron'
import { join } from 'path'
import { electronApp, optimizer, is } from '@electron-toolkit/utils'
import { existsSync } from 'fs'
import { registerIpc } from './ipc/registerIpc'
import { localProxyManager } from './proxy/LocalProxyManager'
import { logger } from './logger/Logger'
import { ensureDataDirReady } from './app/dataDir'

function resolveAppIconPath(): string | undefined {
  const candidates = [
    // 安装包 extraResources
    process.resourcesPath ? join(process.resourcesPath, 'icon.ico') : '',
    process.resourcesPath ? join(process.resourcesPath, 'icon.png') : '',
    join(__dirname, '../../resources/icon.ico'),
    join(__dirname, '../../resources/icon.png'),
    join(app.getAppPath(), 'resources/icon.ico'),
    join(app.getAppPath(), 'resources/icon.png'),
    join(process.cwd(), 'resources/icon.ico'),
    join(process.cwd(), 'resources/icon.png')
  ]
  for (const p of candidates) {
    if (p && existsSync(p)) return p
  }
  return undefined
}

function resolveAppIcon(): Electron.NativeImage | undefined {
  const p = resolveAppIconPath()
  if (!p) return undefined
  const img = nativeImage.createFromPath(p)
  return img.isEmpty() ? undefined : img
}

function createWindow(): void {
  const icon = resolveAppIcon()
  const mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 960,
    minHeight: 640,
    show: false,
    autoHideMenuBar: true,
    title: '浏览器多开工具',
    ...(icon ? { icon } : {}),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false
    }
  })

  mainWindow.on('ready-to-show', () => {
    mainWindow.show()
  })

  mainWindow.webContents.setWindowOpenHandler((details) => {
    shell.openExternal(details.url)
    return { action: 'deny' }
  })

  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

app.whenReady().then(async () => {
  electronApp.setAppUserModelId('com.browserbox.app')

  app.on('browser-window-created', (_, window) => {
    optimizer.watchWindowShortcuts(window)
  })

  registerIpc()

  try {
    const state = await ensureDataDirReady()
    if (state.ready) {
      logger.info('app', `数据目录就绪 ${state.dataDir}`, { auto: state.auto })
    } else {
      logger.warn('app', '未能自动初始化数据目录，将进入手动设置页', { dataDir: state.dataDir })
    }
  } catch (err) {
    logger.warn('app', '自动初始化数据目录失败', err)
  }

  createWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

app.on('before-quit', () => {
  void localProxyManager.stopAll()
})
