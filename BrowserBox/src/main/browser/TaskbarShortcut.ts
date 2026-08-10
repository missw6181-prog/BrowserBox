import {
  existsSync,
  mkdirSync,
  writeFileSync,
  unlinkSync,
  readdirSync,
  copyFileSync,
  statSync
} from 'fs'
import { basename, dirname, join } from 'path'
import { execFile, spawn, type ChildProcess } from 'child_process'
import { promisify } from 'util'
import { app, nativeImage, shell } from 'electron'
import { logger } from '../logger/Logger'

const execFileAsync = promisify(execFile)

/** 环境默认配色（列表标识用，不再用于任务栏图标） */
export const ENV_ICON_COLORS = [
  '#2563eb',
  '#059669',
  '#d97706',
  '#dc2626',
  '#7c3aed',
  '#0891b2',
  '#db2777',
  '#4f46e5',
  '#0d9488',
  '#ea580c'
]

export function colorForDisplayId(displayId: string): string {
  const n = parseInt(displayId, 10)
  const idx = Number.isFinite(n) ? Math.max(0, n - 1) : 0
  return ENV_ICON_COLORS[idx % ENV_ICON_COLORS.length]
}

/** 应用图标源文件（优先透明 ICO）— 主程序纯黑 */
export function resolveAppIconFile(): string | null {
  const candidates = [
    process.resourcesPath ? join(process.resourcesPath, 'icon.ico') : '',
    process.resourcesPath ? join(process.resourcesPath, 'icon.png') : '',
    join(__dirname, '../../resources/icon.ico'),
    join(__dirname, '../../resources/icon.png'),
    join(process.cwd(), 'resources/icon.ico'),
    join(process.cwd(), 'resources/icon.png')
  ]
  try {
    candidates.unshift(join(app.getAppPath(), 'resources/icon.png'))
    candidates.unshift(join(app.getAppPath(), 'resources/icon.ico'))
  } catch {
    /* app 未 ready 时忽略 */
  }
  for (const p of candidates) {
    if (p && existsSync(p)) return p
  }
  return null
}

/** 环境浏览器任务栏底图：蓝色，与主程序黑色区分 */
export function resolveEnvIconFile(): string | null {
  const candidates = [
    process.resourcesPath ? join(process.resourcesPath, 'icon-env.ico') : '',
    process.resourcesPath ? join(process.resourcesPath, 'icon-env.png') : '',
    join(__dirname, '../../resources/icon-env.ico'),
    join(__dirname, '../../resources/icon-env.png'),
    join(process.cwd(), 'resources/icon-env.ico'),
    join(process.cwd(), 'resources/icon-env.png')
  ]
  try {
    candidates.unshift(join(app.getAppPath(), 'resources/icon-env.png'))
    candidates.unshift(join(app.getAppPath(), 'resources/icon-env.ico'))
  } catch {
    /* ignore */
  }
  for (const p of candidates) {
    if (p && existsSync(p)) return p
  }
  // 回退到主图标，避免启动失败
  return resolveAppIconFile()
}

/**
 * 写入环境任务栏图标：蓝色应用底图 + 顶部环境编号徽章。
 */
export async function writeEnvAppIcon(filePath: string, displayId: string): Promise<void> {
  const src = resolveEnvIconFile()
  if (!src) throw new Error('未找到环境图标 resources/icon-env.ico')

  mkdirSync(dirname(filePath), { recursive: true })

  const baseImg = nativeImage.createFromPath(src)
  if (baseImg.isEmpty()) throw new Error('应用图标无法读取')
  const basePng = baseImg.toPNG()
  const baseDataUrl = `data:image/png;base64,${basePng.toString('base64')}`
  const label = String(displayId || '').trim() || '0'

  const { BrowserWindow } = await import('electron')
  const win = new BrowserWindow({
    width: 64,
    height: 64,
    show: false,
    webPreferences: { offscreen: true, contextIsolation: false }
  })
  try {
    await win.loadURL('data:text/html,<html><body></body></html>')
    const sizes = [16, 24, 32, 48, 64, 128, 256]
    const pngs: Array<{ size: number; png: Buffer }> = []

    for (const size of sizes) {
      const dataUrl = await win.webContents.executeJavaScript(
        `new Promise((resolve, reject) => {
          const size = ${size}
          const label = ${JSON.stringify(label)}
          const canvas = document.createElement('canvas')
          canvas.width = size
          canvas.height = size
          const ctx = canvas.getContext('2d')
          ctx.clearRect(0, 0, size, size)
          const img = new Image()
          img.onload = () => {
            try {
              ctx.drawImage(img, 0, 0, size, size)

              // 顶部编号条（略压住图标上沿）
              const badgeH = Math.max(Math.round(size * 0.34), size <= 16 ? 7 : 9)
              const padX = Math.max(1, Math.round(size * 0.06))
              const radius = Math.max(1, Math.round(badgeH * 0.35))

              // 半透明底，保证编号可读
              ctx.fillStyle = 'rgba(15, 23, 42, 0.88)'
              roundRect(ctx, padX, 1, size - padX * 2, badgeH, radius)
              ctx.fill()

              // 细蓝边
              ctx.strokeStyle = 'rgba(37, 99, 235, 0.95)'
              ctx.lineWidth = Math.max(1, size >= 48 ? 2 : 1)
              roundRect(ctx, padX, 1, size - padX * 2, badgeH, radius)
              ctx.stroke()

              // 编号文字：小尺寸去前导零，大尺寸保留原编号
              let text = label
              if (size <= 24) {
                const n = parseInt(label, 10)
                text = Number.isFinite(n) ? String(n) : label
              }
              const fontSize = Math.max(
                size <= 16 ? 8 : 9,
                Math.round(badgeH * (text.length > 2 ? 0.72 : 0.82))
              )
              ctx.font = 'bold ' + fontSize + 'px Segoe UI, Arial, sans-serif'
              ctx.textAlign = 'center'
              ctx.textBaseline = 'middle'
              ctx.fillStyle = '#ffffff'
              ctx.fillText(text, size / 2, 1 + badgeH / 2 + (size <= 16 ? 0.5 : 0), size - padX * 2 - 2)

              resolve(canvas.toDataURL('image/png'))
            } catch (e) {
              reject(String(e))
            }
          }
          img.onerror = () => reject('icon load failed')
          img.src = ${JSON.stringify(baseDataUrl)}

          function roundRect(ctx, x, y, w, h, r) {
            const rr = Math.min(r, w / 2, h / 2)
            ctx.beginPath()
            ctx.moveTo(x + rr, y)
            ctx.arcTo(x + w, y, x + w, y + h, rr)
            ctx.arcTo(x + w, y + h, x, y + h, rr)
            ctx.arcTo(x, y + h, x, y, rr)
            ctx.arcTo(x, y, x + w, y, rr)
            ctx.closePath()
          }
        })`
      )
      pngs.push({ size, png: nativeImage.createFromDataURL(dataUrl).toPNG() })
    }

    writeFileSync(filePath, packPngsToIco(pngs))
  } finally {
    win.destroy()
  }
}

/** @deprecated */
export async function writeSolidColorIco(filePath: string, _color?: string): Promise<void> {
  await writeEnvAppIcon(filePath, '0')
}

/** 将多张 PNG 打成 Vista+ PNG-in-ICO（完整 Alpha 透明） */
function packPngsToIco(pngs: Array<{ size: number; png: Buffer }>): Buffer {
  const count = pngs.length
  const headerSize = 6 + 16 * count
  let offset = headerSize
  const offsets: number[] = []
  let total = headerSize
  for (const item of pngs) {
    offsets.push(offset)
    offset += item.png.length
    total += item.png.length
  }

  const buf = Buffer.alloc(total)
  let o = 0
  buf.writeUInt16LE(0, o)
  o += 2
  buf.writeUInt16LE(1, o)
  o += 2
  buf.writeUInt16LE(count, o)
  o += 2

  for (let i = 0; i < count; i++) {
    const { size, png } = pngs[i]
    buf[o++] = size >= 256 ? 0 : size
    buf[o++] = size >= 256 ? 0 : size
    buf[o++] = 0
    buf[o++] = 0
    buf.writeUInt16LE(1, o)
    o += 2
    buf.writeUInt16LE(32, o)
    o += 2
    buf.writeUInt32LE(png.length, o)
    o += 4
    buf.writeUInt32LE(offsets[i], o)
    o += 4
  }

  for (let i = 0; i < count; i++) {
    pngs[i].png.copy(buf, offsets[i])
  }
  return buf
}

/**
 * 按 Chromium 规则推算 AUMID。
 * 注意：用「原始」chrome 路径判断渠道，不要用 patched bb_*.exe 路径。
 */
export function computeChromeAppUserModelId(chromePath: string, userDataDir: string): string {
  const lower = chromePath.replace(/\//g, '\\').toLowerCase()
  let baseId = 'Chrome'
  if (
    lower.includes('chrome for testing') ||
    lower.includes('chrome-for-testing') ||
    /[\\/]browser[\\/]\d+[\\/]/.test(lower)
  ) {
    baseId = 'ChromeForTesting'
  } else if (lower.includes('chromium')) {
    baseId = 'Chromium'
  } else if (lower.includes('chrome beta')) {
    baseId = 'ChromeBeta'
  } else if (lower.includes('chrome sxs') || lower.includes('\\canary\\')) {
    baseId = 'ChromeCanary'
  }

  const userDataBase = basename(userDataDir)
  const raw = `${userDataBase}.Default`
  const profileId = raw.replace(/[^A-Za-z0-9.]/g, '')
  return profileId ? `${baseId}.${profileId}` : baseId
}

function quoteArg(a: string): string {
  if (!/[ \t"]/g.test(a)) return a
  return `"${a.replace(/"/g, '\\"')}"`
}

function envExeShortId(envId: string): string {
  return envId.replace(/^env_/, '').replace(/-/g, '').slice(0, 16)
}

export function patchedChromeExePath(chromePath: string, envId: string): string {
  return join(dirname(chromePath), `bb_${envExeShortId(envId)}.exe`)
}

function canWriteDir(dir: string): boolean {
  const probe = join(dir, `.bb_write_${process.pid}.tmp`)
  try {
    writeFileSync(probe, '1')
    unlinkSync(probe)
    return true
  } catch {
    return false
  }
}

function resolveRceditBinary(): string | null {
  const exeName = process.arch === 'ia32' ? 'rcedit.exe' : 'rcedit-x64.exe'
  const candidates = [
    join(__dirname, '../../node_modules/rcedit/bin', exeName),
    join(process.cwd(), 'node_modules/rcedit/bin', exeName),
    join(__dirname, '../../../node_modules/rcedit/bin', exeName)
  ]
  for (const p of candidates) {
    if (existsSync(p)) return p
  }
  return null
}

/**
 * 在可写目录下复制 chrome.exe 并写入自定义图标。
 * 本机 Program Files 不可写时返回原路径（改走窗口图标注入）。
 */
export async function preparePatchedChromeExe(
  chromePath: string,
  envId: string,
  icoPath: string
): Promise<{ exePath: string; patched: boolean }> {
  const dir = dirname(chromePath)
  if (!canWriteDir(dir)) {
    logger.info('environment', '浏览器目录不可写，跳过 exe 图标补丁', { dir })
    return { exePath: chromePath, patched: false }
  }

  const rceditBin = resolveRceditBinary()
  if (!rceditBin) {
    logger.warn('environment', '未找到 rcedit 二进制，跳过 exe 图标补丁')
    return { exePath: chromePath, patched: false }
  }

  const dest = patchedChromeExePath(chromePath, envId)
  try {
    const srcStat = statSync(chromePath)
    const needCopy =
      !existsSync(dest) ||
      statSync(dest).size !== srcStat.size ||
      statSync(dest).mtimeMs < srcStat.mtimeMs
    if (needCopy) {
      copyFileSync(chromePath, dest)
    }

    await execFileAsync(rceditBin, [dest, '--set-icon', icoPath], {
      windowsHide: true,
      timeout: 60000
    })
    logger.info('environment', '已生成带自定义图标的浏览器副本', { dest })
    return { exePath: dest, patched: true }
  } catch (err) {
    logger.warn('environment', 'exe 图标补丁失败，回退原 chrome.exe', { err: String(err) })
    try {
      if (existsSync(dest)) unlinkSync(dest)
    } catch {
      /* ignore */
    }
    return { exePath: chromePath, patched: false }
  }
}

export function removePatchedChromeExe(chromePath: string | undefined, envId: string): void {
  if (!chromePath) return
  const dest = patchedChromeExePath(chromePath, envId)
  if (existsSync(dest)) {
    try {
      unlinkSync(dest)
    } catch {
      /* ignore */
    }
  }
}

export interface ShortcutLaunchOptions {
  envId: string
  displayId: string
  name: string
  /** 实际启动的 exe（可能是 bb_*.exe） */
  launchExePath: string
  /** 原始 chrome 路径，用于推算 AUMID */
  chromePathForAumid: string
  userDataDir: string
  args: string[]
  shortcutsDir: string
}

export function ensureEnvShortcut(opts: ShortcutLaunchOptions): { lnkPath: string; icoPath: string } {
  mkdirSync(opts.shortcutsDir, { recursive: true })
  const icoPath = join(opts.shortcutsDir, `${opts.envId}.ico`)
  const lnkPath = join(opts.shortcutsDir, `${opts.envId}.lnk`)
  const aumid = computeChromeAppUserModelId(opts.chromePathForAumid, opts.userDataDir)

  // 图标须已由调用方 writeEnvAppIcon(icoPath, displayId) 写好
  if (!existsSync(icoPath)) {
    throw new Error('环境图标尚未生成')
  }

  const argsStr = opts.args.map(quoteArg).join(' ')
  const title = `【${opts.displayId}】${opts.name}`
  const op = existsSync(lnkPath) ? 'update' : 'create'
  const ok = shell.writeShortcutLink(lnkPath, op, {
    target: opts.launchExePath,
    cwd: dirname(opts.launchExePath),
    args: argsStr,
    description: title,
    icon: icoPath,
    iconIndex: 0,
    appUserModelId: aumid
  })
  if (!ok) {
    throw new Error('写入任务栏快捷方式失败')
  }
  logger.info('environment', `快捷方式已更新 ${opts.displayId}`, { aumid, lnkPath })
  return { lnkPath, icoPath }
}

export function removeEnvShortcut(shortcutsDir: string, envId: string): void {
  for (const ext of ['.lnk', '.ico']) {
    const p = join(shortcutsDir, `${envId}${ext}`)
    if (existsSync(p)) {
      try {
        unlinkSync(p)
      } catch {
        /* ignore */
      }
    }
  }
}

function normalizeCmdPath(p: string): string {
  return p.replace(/\//g, '\\').toLowerCase()
}

/**
 * 查找绑定指定 user-data-dir 的浏览器进程。
 * mainOnly=true 时只返回主进程（命令行不含 --type=），用于判断用户是否已关掉浏览器。
 * 子进程（gpu/renderer 等）即使残留也不再把环境当成「仍在运行」。
 */
export async function findChromePidsByUserDataDir(
  userDataDir: string,
  opts?: { mainOnly?: boolean }
): Promise<number[]> {
  const needle = normalizeCmdPath(userDataDir)
  const mainOnly = opts?.mainOnly ? '1' : '0'
  const ps = `
$ErrorActionPreference = 'SilentlyContinue'
$needle = $env:BB_UD_NEEDLE
$mainOnly = $env:BB_MAIN_ONLY -eq '1'
Get-CimInstance Win32_Process | ForEach-Object {
  $name = $_.Name
  if (-not $name) { return }
  $n = $name.ToLower()
  if ($n -ne 'chrome.exe' -and -not $n.StartsWith('bb_')) { return }
  if (-not $_.CommandLine) { return }
  $cl = $_.CommandLine.ToLower().Replace('/','\\')
  if (-not $cl.Contains($needle)) { return }
  if ($mainOnly -and $cl.Contains('--type=')) { return }
  $_.ProcessId
}
`
  try {
    const { stdout } = await execFileAsync(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', ps],
      {
        windowsHide: true,
        timeout: 12000,
        encoding: 'utf8',
        env: { ...process.env, BB_UD_NEEDLE: needle, BB_MAIN_ONLY: mainOnly }
      }
    )
    return String(stdout)
      .split(/\r?\n/)
      .map((s) => parseInt(s.trim(), 10))
      .filter((n) => Number.isFinite(n) && n > 0)
  } catch {
    return []
  }
}

export async function waitForChromePids(
  userDataDir: string,
  timeoutMs = 12000
): Promise<number[]> {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    // 启动阶段子进程可能先出现，主进程稍后就绪：先取全部，优先返回无 --type= 的
    const mains = await findChromePidsByUserDataDir(userDataDir, { mainOnly: true })
    if (mains.length) return mains
    const any = await findChromePidsByUserDataDir(userDataDir)
    if (any.length) return any
    await new Promise((r) => setTimeout(r, 300))
  }
  return []
}

/** 将指定环境的 Chrome 窗口恢复并置顶（按 user-data-dir 对应进程，不依赖窗口标题） */
export async function focusEnvWindows(opts: {
  displayId: string
  name: string
  userDataDir?: string
}): Promise<number> {
  if (!opts.userDataDir) return 0

  // 窗口可能挂在主进程或其它 chrome 进程上，取该 profile 下全部相关 PID
  let pids = await findChromePidsByUserDataDir(opts.userDataDir)
  if (!pids.length) {
    pids = await findChromePidsByUserDataDir(opts.userDataDir, { mainOnly: true })
  }
  if (!pids.length) {
    logger.warn('environment', '定位失败：未找到进程', { displayId: opts.displayId, dir: opts.userDataDir })
    return 0
  }

  const script = `
$ErrorActionPreference = 'SilentlyContinue'
Add-Type -TypeDefinition @"
using System;
using System.Text;
using System.Collections.Generic;
using System.Runtime.InteropServices;
public class BbFocus {
  public delegate bool EnumProc(IntPtr hWnd, IntPtr lParam);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr lp);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool BringWindowToTop(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr hWnd, IntPtr hWndInsertAfter, int X, int Y, int cx, int cy, uint uFlags);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)]
  public static extern int GetWindowText(IntPtr hWnd, StringBuilder sb, int max);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)]
  public static extern int GetClassName(IntPtr hWnd, StringBuilder sb, int max);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid);
  [DllImport("user32.dll")] public static extern bool AttachThreadInput(uint idAttach, uint idAttachTo, bool fAttach);
  [DllImport("kernel32.dll")] public static extern uint GetCurrentThreadId();
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern int GetWindowTextLength(IntPtr hWnd);
  static readonly IntPtr HWND_TOPMOST = new IntPtr(-1);
  static readonly IntPtr HWND_NOTOPMOST = new IntPtr(-2);
  public static int FocusByPids(int[] pids) {
    var set = new HashSet<uint>();
    foreach (var p in pids) set.Add((uint)p);
    var targets = new List<IntPtr>();
    EnumWindows((hWnd, lp) => {
      if (!IsWindowVisible(hWnd)) return true;
      uint pid;
      GetWindowThreadProcessId(hWnd, out pid);
      if (!set.Contains(pid)) return true;
      var cls = new StringBuilder(256);
      GetClassName(hWnd, cls, 256);
      var c = cls.ToString();
      if (c.IndexOf("Chrome_WidgetWin_") != 0) return true;
      // 只要有标题的顶层窗口（过滤掉无标题工具窗）
      if (GetWindowTextLength(hWnd) <= 0) return true;
      targets.Add(hWnd);
      return true;
    }, IntPtr.Zero);
    int n = 0;
    foreach (var hWnd in targets) {
      if (IsIconic(hWnd)) ShowWindow(hWnd, 9); // SW_RESTORE
      else ShowWindow(hWnd, 5); // SW_SHOW
      uint fgProc;
      var fg = GetForegroundWindow();
      uint fgTid = GetWindowThreadProcessId(fg, out fgProc);
      uint tgtProc;
      uint tgtTid = GetWindowThreadProcessId(hWnd, out tgtProc);
      uint cur = GetCurrentThreadId();
      AttachThreadInput(cur, tgtTid, true);
      if (fgTid != 0) AttachThreadInput(cur, fgTid, true);
      BringWindowToTop(hWnd);
      SetForegroundWindow(hWnd);
      // 短暂 TOPMOST 再取消，提高置顶成功率
      SetWindowPos(hWnd, HWND_TOPMOST, 0, 0, 0, 0, 0x0002 | 0x0001 | 0x0040);
      SetWindowPos(hWnd, HWND_NOTOPMOST, 0, 0, 0, 0, 0x0002 | 0x0001 | 0x0040);
      if (fgTid != 0) AttachThreadInput(cur, fgTid, false);
      AttachThreadInput(cur, tgtTid, false);
      n++;
    }
    return n;
  }
}
"@
$pids = @(${pids.join(',')})
[BbFocus]::FocusByPids($pids)
`
  try {
    const { stdout } = await execFileAsync(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', script],
      {
        windowsHide: true,
        timeout: 12000,
        encoding: 'utf8'
      }
    )
    const n = parseInt(String(stdout).trim().split(/\r?\n/).pop() || '', 10)
    logger.info('environment', `定位环境窗口 ${opts.displayId}`, { focused: n, pids })
    return Number.isFinite(n) ? n : 0
  } catch (err) {
    logger.warn('environment', '定位环境窗口失败', { err: String(err), displayId: opts.displayId, pids })
    return 0
  }
}

export async function killChromeByUserDataDir(userDataDir: string, force = false): Promise<void> {
  const pids = await findChromePidsByUserDataDir(userDataDir)
  if (!pids.length) return
  const list = pids.join(',')
  const forceFlag = force ? '-Force' : ''
  const ps = `
$ErrorActionPreference = 'SilentlyContinue'
@(${list}) | ForEach-Object { Stop-Process -Id $_ ${forceFlag} -ErrorAction SilentlyContinue }
`
  try {
    await execFileAsync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], {
      windowsHide: true,
      timeout: 15000
    })
  } catch (err) {
    logger.warn('environment', '结束 Chrome 进程失败', { err: String(err) })
  }
}

/**
 * 强制把指定进程的 Chrome 窗口图标换成自定义 ICO（单次）。
 */
export async function applyWindowIcons(icoPath: string, pids: number[]): Promise<number> {
  if (!pids.length || !existsSync(icoPath)) return 0

  const scriptPath = join(dirname(icoPath), `_apply_icon_${process.pid}_${Date.now()}.ps1`)
  const script = `
$ErrorActionPreference = 'Stop'
$ico = $env:BB_ICO
$pids = @(${pids.join(',')})
if (-not (Get-Variable -Name BbWinIconReady -Scope Global -ErrorAction SilentlyContinue)) {
  Add-Type -TypeDefinition @"
using System;
using System.Text;
using System.Collections.Generic;
using System.Runtime.InteropServices;
public class BbWinIcon {
  public delegate bool EnumProc(IntPtr hWnd, IntPtr lParam);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr lp);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)]
  public static extern int GetClassName(IntPtr hWnd, StringBuilder sb, int max);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)]
  public static extern IntPtr SendMessage(IntPtr hWnd, uint msg, IntPtr wParam, IntPtr lParam);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)]
  public static extern IntPtr LoadImage(IntPtr hInst, string name, uint type, int cx, int cy, uint fuLoad);
  [DllImport("user32.dll", EntryPoint="SetClassLongPtrW")]
  public static extern IntPtr SetClassLongPtr(IntPtr hWnd, int nIndex, IntPtr dwNewLong);
  public static int Apply(string icoPath, int[] pids) {
    var set = new HashSet<uint>();
    foreach (var p in pids) set.Add((uint)p);
    IntPtr big = LoadImage(IntPtr.Zero, icoPath, 1, 32, 32, 0x0010);
    IntPtr small = LoadImage(IntPtr.Zero, icoPath, 1, 16, 16, 0x0010);
    if (big == IntPtr.Zero) return -1;
    if (small == IntPtr.Zero) small = big;
    int n = 0;
    EnumWindows((hWnd, lp) => {
      uint pid; GetWindowThreadProcessId(hWnd, out pid);
      if (!set.Contains(pid) || !IsWindowVisible(hWnd)) return true;
      var sb = new StringBuilder(256);
      GetClassName(hWnd, sb, 256);
      string cls = sb.ToString();
      if (cls.IndexOf("Chrome_WidgetWin_") != 0) return true;
      SendMessage(hWnd, 0x0080, (IntPtr)1, big);
      SendMessage(hWnd, 0x0080, (IntPtr)0, small);
      try {
        SetClassLongPtr(hWnd, -14, big);
        SetClassLongPtr(hWnd, -34, small);
      } catch {}
      n++;
      return true;
    }, IntPtr.Zero);
    return n;
  }
}
"@
  $global:BbWinIconReady = $true
}
[BbWinIcon]::Apply($ico, $pids)
`
  try {
    writeFileSync(scriptPath, script, 'utf8')
    const { stdout } = await execFileAsync(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', scriptPath],
      {
        windowsHide: true,
        timeout: 20000,
        encoding: 'utf8',
        env: { ...process.env, BB_ICO: icoPath }
      }
    )
    const n = parseInt(String(stdout).trim(), 10)
    return Number.isFinite(n) ? n : 0
  } catch (err) {
    logger.warn('environment', '注入窗口图标失败', { err: String(err) })
    return 0
  } finally {
    try {
      if (existsSync(scriptPath)) unlinkSync(scriptPath)
    } catch {
      /* ignore */
    }
  }
}

/**
 * 常驻监视：Chrome 会反复把窗口图标改回 TEST，需持续覆盖。
 * 按 user-data-dir 匹配进程；无进程连续多次后自动退出。
 */
export function startIconWatcher(
  icoPath: string,
  userDataDir: string,
  shortcutsDir: string
): ChildProcess {
  const needle = normalizeCmdPath(userDataDir)
  const scriptPath = join(shortcutsDir, `_watch_icon_${Date.now()}.ps1`)
  const script = `
$ErrorActionPreference = 'SilentlyContinue'
$ico = $env:BB_ICO
$needle = $env:BB_UD_NEEDLE
Add-Type -TypeDefinition @"
using System;
using System.Text;
using System.Collections.Generic;
using System.Runtime.InteropServices;
public class BbWinIconWatch {
  public delegate bool EnumProc(IntPtr hWnd, IntPtr lParam);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr lp);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)]
  public static extern int GetClassName(IntPtr hWnd, StringBuilder sb, int max);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)]
  public static extern IntPtr SendMessage(IntPtr hWnd, uint msg, IntPtr wParam, IntPtr lParam);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)]
  public static extern IntPtr LoadImage(IntPtr hInst, string name, uint type, int cx, int cy, uint fuLoad);
  [DllImport("user32.dll", EntryPoint="SetClassLongPtrW")]
  public static extern IntPtr SetClassLongPtr(IntPtr hWnd, int nIndex, IntPtr dwNewLong);
  static IntPtr big = IntPtr.Zero;
  static IntPtr small = IntPtr.Zero;
  public static void Init(string icoPath) {
    big = LoadImage(IntPtr.Zero, icoPath, 1, 32, 32, 0x0010);
    small = LoadImage(IntPtr.Zero, icoPath, 1, 16, 16, 0x0010);
    if (small == IntPtr.Zero) small = big;
  }
  public static int Apply(int[] pids) {
    if (big == IntPtr.Zero) return -1;
    var set = new HashSet<uint>();
    foreach (var p in pids) set.Add((uint)p);
    int n = 0;
    EnumWindows((hWnd, lp) => {
      uint pid; GetWindowThreadProcessId(hWnd, out pid);
      if (!set.Contains(pid) || !IsWindowVisible(hWnd)) return true;
      var sb = new StringBuilder(256);
      GetClassName(hWnd, sb, 256);
      if (sb.ToString().IndexOf("Chrome_WidgetWin_") != 0) return true;
      SendMessage(hWnd, 0x0080, (IntPtr)1, big);
      SendMessage(hWnd, 0x0080, (IntPtr)0, small);
      try {
        SetClassLongPtr(hWnd, -14, big);
        SetClassLongPtr(hWnd, -34, small);
      } catch {}
      n++;
      return true;
    }, IntPtr.Zero);
    return n;
  }
}
"@
[BbWinIconWatch]::Init($ico)
$miss = 0
while ($true) {
  $pids = @()
  Get-CimInstance Win32_Process | ForEach-Object {
    $name = $_.Name
    if (-not $name) { return }
    $n = $name.ToLower()
    if ($n -ne 'chrome.exe' -and -not $n.StartsWith('bb_')) { return }
    if ($_.CommandLine) {
      $cl = $_.CommandLine.ToLower().Replace('/','\\')
      if ($cl.Contains($needle)) { $pids += $_.ProcessId }
    }
  }
  if ($pids.Count -eq 0) {
    $miss++
    if ($miss -ge 5) { break }
  } else {
    $miss = 0
    [void][BbWinIconWatch]::Apply($pids)
  }
  Start-Sleep -Milliseconds 1500
}
`
  writeFileSync(scriptPath, script, 'utf8')
  const child = spawn(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', scriptPath],
    {
      windowsHide: true,
      stdio: 'ignore',
      env: { ...process.env, BB_ICO: icoPath, BB_UD_NEEDLE: needle },
      detached: false
    }
  )
  const cleanup = (): void => {
    try {
      if (existsSync(scriptPath)) unlinkSync(scriptPath)
    } catch {
      /* ignore */
    }
  }
  child.on('exit', cleanup)
  child.on('error', cleanup)
  logger.info('environment', '已启动任务栏图标监视', { icoPath })
  return child
}

export function stopIconWatcher(child?: ChildProcess | null): void {
  if (!child || child.killed) return
  try {
    child.kill()
  } catch {
    /* ignore */
  }
}

export async function launchViaShortcut(lnkPath: string): Promise<void> {
  const errMsg = await shell.openPath(lnkPath)
  if (errMsg) {
    throw new Error(`通过快捷方式启动失败: ${errMsg}`)
  }
}

export function listShortcutFiles(shortcutsDir: string): string[] {
  if (!existsSync(shortcutsDir)) return []
  return readdirSync(shortcutsDir).filter((f) => f.endsWith('.lnk'))
}
