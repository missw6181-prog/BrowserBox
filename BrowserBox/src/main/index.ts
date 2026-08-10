import { app, shell, BrowserWindow, nativeImage, dialog, Tray, Menu } from 'electron'
import { join } from 'path'
import { electronApp, optimizer, is } from '@electron-toolkit/utils'
import { existsSync } from 'fs'
import { registerIpc } from './ipc/registerIpc'
import { localProxyManager } from './proxy/LocalProxyManager'
import { environmentManager } from './environment/EnvironmentManager'
import { configManager } from './config/ConfigManager'
import { logger } from './logger/Logger'
import { ensureDataDirReady } from './app/dataDir'
import type { CloseAction } from '../shared/types'

let mainWindow: BrowserWindow | null = null
let tray: Tray | null = null
/** 用户确认退出后为 true，允许真正关闭窗口 / quit */
let isQuitting = false
let closePromptOpen = false

function resolveAppIconPath(): string | undefined {
  const candidates = [
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

function showMainWindow(): void {
  if (!mainWindow || mainWindow.isDestroyed()) {
    createWindow()
    return
  }
  if (mainWindow.isMinimized()) mainWindow.restore()
  mainWindow.show()
  mainWindow.focus()
}

function buildTrayMenu(): Menu {
  const running = (() => {
    try {
      return environmentManager.listRunning()
    } catch {
      return []
    }
  })()

  const envItems: Electron.MenuItemConstructorOptions[] =
    running.length === 0
      ? [{ label: '（暂无运行中的环境）', enabled: false }]
      : running.map((e) => ({
          label: `定位 ${e.displayId} ${e.name}`,
          click: () => {
            void environmentManager.focus(e.id).catch((err) => {
              logger.warn('app', '托盘定位环境失败', { id: e.id, err: String(err) })
            })
          }
        }))

  return Menu.buildFromTemplate([
    {
      label: '显示主窗口',
      click: () => showMainWindow()
    },
    { type: 'separator' },
    {
      label: `运行中的环境 (${running.length})`,
      enabled: false
    },
    ...envItems,
    { type: 'separator' },
    {
      label: '退出（关闭所有环境）',
      click: () => {
        void quitApp()
      }
    }
  ])
}

function refreshTrayMenu(): void {
  if (!tray) return
  try {
    tray.setContextMenu(buildTrayMenu())
    const n = environmentManager.listRunning().length
    tray.setToolTip(n > 0 ? `浏览器多开工具（运行中 ${n}）` : '浏览器多开工具')
  } catch {
    /* ignore */
  }
}

function createTray(): void {
  if (tray) return
  const icon = resolveAppIcon()
  if (!icon) {
    logger.warn('app', '无法创建托盘：未找到应用图标')
    return
  }
  const trayIcon = icon.resize({ width: 32, height: 32 })
  tray = new Tray(trayIcon.isEmpty() ? icon : trayIcon)
  tray.setToolTip('浏览器多开工具')
  tray.setContextMenu(buildTrayMenu())
  tray.on('double-click', () => showMainWindow())
  tray.on('right-click', () => refreshTrayMenu())
}

function minimizeToTray(win: BrowserWindow): void {
  createTray()
  win.hide()
  try {
    tray?.displayBalloon({
      title: '浏览器多开工具',
      content: '已放到系统托盘。双击图标可重新打开，右键可退出。'
    })
  } catch {
    /* 部分系统不支持 balloon */
  }
}

async function quitApp(): Promise<void> {
  if (isQuitting) return
  isQuitting = true
  try {
    logger.info('app', '正在退出：关闭所有环境…')
    await environmentManager.stopAll(true)
    await localProxyManager.stopAll()
  } catch (err) {
    logger.warn('app', '退出时关闭环境失败', err)
  } finally {
    if (tray) {
      tray.destroy()
      tray = null
    }
    // 先关掉主窗口，再 quit
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.destroy()
      mainWindow = null
    }
    app.quit()
  }
}

function getCloseAction(): CloseAction {
  try {
    if (!configManager.isReady()) return 'ask'
    const action = configManager.get('settings').closeAction
    if (action === 'quit' || action === 'tray' || action === 'ask') return action
  } catch {
    /* ignore */
  }
  return 'ask'
}

async function handleCloseAttempt(win: BrowserWindow): Promise<void> {
  if (isQuitting || closePromptOpen) return
  closePromptOpen = true
  try {
    const action = getCloseAction()
    if (action === 'quit') {
      await quitApp()
      return
    }
    if (action === 'tray') {
      minimizeToTray(win)
      return
    }

    // 未设置默认动作（ask）：弹出醒目确认
    const { response } = await dialog.showMessageBox(win, {
      type: 'warning',
      title: '退出确认',
      message: '确定要退出吗？所有浏览器环境将被关闭！',
      detail:
        '点击「退出」后，本程序会强制关闭当前已启动的全部浏览器窗口，并结束主程序。\n\n若只想隐藏主界面、继续使用已开环境，请选择「最小化到托盘」。\n\n可在「设置」中配置关闭窗口的默认动作，之后将不再每次询问。',
      buttons: ['退出并关闭全部环境', '最小化到托盘', '取消'],
      defaultId: 2,
      cancelId: 2,
      noLink: true
    })
    if (response === 0) {
      await quitApp()
      return
    }
    if (response === 1) {
      minimizeToTray(win)
    }
  } finally {
    closePromptOpen = false
  }
}

function createWindow(): void {
  const icon = resolveAppIcon()
  mainWindow = new BrowserWindow({
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

  const win = mainWindow

  win.on('ready-to-show', () => {
    win.show()
  })

  win.on('close', (e) => {
    if (isQuitting) return
    e.preventDefault()
    void handleCloseAttempt(win)
  })

  win.webContents.setWindowOpenHandler((details) => {
    shell.openExternal(details.url)
    return { action: 'deny' }
  })

  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    win.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    win.loadFile(join(__dirname, '../renderer/index.html'))
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
  createTray()
  environmentManager.setRuntimeChangeListener(() => refreshTrayMenu())

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
    else showMainWindow()
  })
})

// 隐藏到托盘时窗口仍在，不会走到这里；仅真正退出时结束进程
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin' && isQuitting) {
    app.quit()
  }
})
