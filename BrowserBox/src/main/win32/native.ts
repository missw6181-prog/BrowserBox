/**
 * Windows 原生能力（koffi）：进程枚举/命令行、等待退出、定位窗口、注入图标、结束进程。
 * 避免周期性拉起 PowerShell / conhost。
 */
import { existsSync } from 'fs'
import koffi from 'koffi'
import { logger } from '../logger/Logger'

const TH32CS_SNAPPROCESS = 0x00000002
const PROCESS_QUERY_INFORMATION = 0x0400
const PROCESS_VM_READ = 0x0010
const PROCESS_QUERY_LIMITED_INFORMATION = 0x1000
const PROCESS_TERMINATE = 0x0001
const STILL_ACTIVE = 259
const WM_SETICON = 0x0080
const IMAGE_ICON = 1
const LR_LOADFROMFILE = 0x0010
const GCLP_HICON = -14
const GCLP_HICONSM = -34
const SW_RESTORE = 9
const HWND_TOPMOST = -1
const HWND_NOTOPMOST = -2
const SWP_NOMOVE = 0x0002
const SWP_NOSIZE = 0x0001
const SWP_SHOWWINDOW = 0x0040

const kernel32 = koffi.load('kernel32.dll')
const ntdll = koffi.load('ntdll.dll')
const user32 = koffi.load('user32.dll')

const PROCESSENTRY32W = koffi.struct('BbPROCESSENTRY32W', {
  dwSize: 'uint32',
  cntUsage: 'uint32',
  th32ProcessID: 'uint32',
  th32DefaultHeapID: 'uintptr',
  th32ModuleID: 'uint32',
  cntThreads: 'uint32',
  th32ParentProcessID: 'uint32',
  pcPriClassBase: 'int32',
  dwFlags: 'uint32',
  szExeFile: koffi.array('char16', 260)
})

const PROCESS_BASIC_INFORMATION = koffi.struct('BbPBI', {
  ExitStatus: 'uintptr',
  PebBaseAddress: 'uintptr',
  AffinityMask: 'uintptr',
  BasePriority: 'uintptr',
  UniqueProcessId: 'uintptr',
  InheritedFromUniqueProcessId: 'uintptr'
})

const EnumWindowsProc = koffi.proto('bool __stdcall BbEnumWindowsProc(void *hwnd, intptr lParam)')

const CreateToolhelp32Snapshot = kernel32.func(
  'void* __stdcall CreateToolhelp32Snapshot(uint32 flags, uint32 pid)'
)
const Process32FirstW = kernel32.func(
  'int __stdcall Process32FirstW(void* h, _Inout_ BbPROCESSENTRY32W* pe)'
)
const Process32NextW = kernel32.func(
  'int __stdcall Process32NextW(void* h, _Inout_ BbPROCESSENTRY32W* pe)'
)
const OpenProcess = kernel32.func(
  'void* __stdcall OpenProcess(uint32 access, int inherit, uint32 pid)'
)
const CloseHandle = kernel32.func('int __stdcall CloseHandle(void* h)')
const ReadProcessMemory = kernel32.func(
  'int __stdcall ReadProcessMemory(void* h, uintptr addr, void* buf, size_t size, size_t* read)'
)
const GetExitCodeProcess = kernel32.func(
  'int __stdcall GetExitCodeProcess(void* h, _Out_ uint32* code)'
)
const TerminateProcess = kernel32.func('int __stdcall TerminateProcess(void* h, uint32 code)')
const NtQueryInformationProcess = ntdll.func(
  'int __stdcall NtQueryInformationProcess(void* h, int cls, _Out_ BbPBI* info, uint32 len, uint32* ret)'
)

const EnumWindows = user32.func('bool __stdcall EnumWindows(BbEnumWindowsProc *cb, intptr lp)')
const GetWindowThreadProcessId = user32.func(
  'uint32 __stdcall GetWindowThreadProcessId(void *hwnd, _Out_ uint32 *pid)'
)
const IsWindowVisible = user32.func('int __stdcall IsWindowVisible(void *hwnd)')
const IsIconic = user32.func('int __stdcall IsIconic(void *hwnd)')
const ShowWindow = user32.func('int __stdcall ShowWindow(void *hwnd, int cmd)')
const SetForegroundWindow = user32.func('int __stdcall SetForegroundWindow(void *hwnd)')
const BringWindowToTop = user32.func('int __stdcall BringWindowToTop(void *hwnd)')
const GetForegroundWindow = user32.func('void* __stdcall GetForegroundWindow()')
const AttachThreadInput = user32.func(
  'int __stdcall AttachThreadInput(uint32 idAttach, uint32 idAttachTo, int fAttach)'
)
const GetCurrentThreadId = kernel32.func('uint32 __stdcall GetCurrentThreadId()')
const SetWindowPos = user32.func(
  'int __stdcall SetWindowPos(void *hwnd, intptr insertAfter, int x, int y, int cx, int cy, uint32 flags)'
)
const GetClassNameW = user32.func('int __stdcall GetClassNameW(void *hwnd, void *buf, int max)')
const GetWindowTextLengthW = user32.func('int __stdcall GetWindowTextLengthW(void *hwnd)')
const SendMessageW = user32.func(
  'intptr __stdcall SendMessageW(void *hwnd, uint32 msg, intptr wParam, intptr lParam)'
)
const LoadImageW = user32.func(
  'void* __stdcall LoadImageW(void *hInst, str16 name, uint32 type, int cx, int cy, uint32 fuLoad)'
)
const SetClassLongPtrW = user32.func(
  'intptr __stdcall SetClassLongPtrW(void *hwnd, int nIndex, intptr dwNewLong)'
)

function normalizeCmdPath(p: string): string {
  return p.replace(/\//g, '\\').toLowerCase()
}

function readProcessCommandLine(pid: number): string | null {
  const h = OpenProcess(PROCESS_QUERY_INFORMATION | PROCESS_VM_READ, 0, pid)
  if (!h) return null
  try {
    const pbi: { PebBaseAddress?: number | bigint } = {}
    const st = NtQueryInformationProcess(h, 0, pbi, koffi.sizeof(PROCESS_BASIC_INFORMATION), null)
    if (st !== 0 || pbi.PebBaseAddress == null) return null
    const peb = BigInt(pbi.PebBaseAddress)
    const paramsPtrBuf = Buffer.alloc(8)
    if (!ReadProcessMemory(h, peb + 0x20n, paramsPtrBuf, 8, null)) return null
    const params = paramsPtrBuf.readBigUInt64LE(0)
    if (!params) return null
    const usBuf = Buffer.alloc(16)
    if (!ReadProcessMemory(h, params + 0x70n, usBuf, 16, null)) return null
    const len = usBuf.readUInt16LE(0)
    const bufPtr = usBuf.readBigUInt64LE(8)
    if (!len || !bufPtr) return ''
    const strBuf = Buffer.alloc(len)
    if (!ReadProcessMemory(h, bufPtr, strBuf, len, null)) return null
    return strBuf.toString('utf16le')
  } catch {
    return null
  } finally {
    CloseHandle(h)
  }
}

function isBrowserProcessName(name: string): boolean {
  const n = name.toLowerCase()
  return n === 'chrome.exe' || n.startsWith('bb_')
}

/** 查找命令行包含 user-data-dir 的浏览器进程 */
export function findChromePidsByUserDataDirSync(
  userDataDir: string,
  opts?: { mainOnly?: boolean }
): number[] {
  const needle = normalizeCmdPath(userDataDir)
  const snap = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0)
  if (!snap) return []
  const out: number[] = []
  try {
    const pe: { dwSize: number; th32ProcessID?: number; szExeFile?: string } = {
      dwSize: koffi.sizeof(PROCESSENTRY32W)
    }
    if (!Process32FirstW(snap, pe)) return []
    do {
      const name = String(pe.szExeFile || '')
      if (!isBrowserProcessName(name)) continue
      const pid = pe.th32ProcessID
      if (!pid) continue
      const cmd = readProcessCommandLine(pid)
      if (!cmd) continue
      const cl = cmd.toLowerCase().replace(/\//g, '\\')
      if (!cl.includes(needle)) continue
      if (opts?.mainOnly && cl.includes('--type=')) continue
      out.push(pid)
    } while (Process32NextW(snap, pe))
  } finally {
    CloseHandle(snap)
  }
  return out
}

export function isPidAlive(pid: number): boolean {
  if (!pid || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

/**
 * 等待进程退出（OpenProcess + 短超时 WaitForSingleObject，不阻塞事件循环过久）。
 * 失败时回退到 process.kill(pid, 0) 轻量探测。
 */
export function waitForProcessExit(
  pid: number,
  signal?: AbortSignal
): Promise<'exited' | 'aborted'> {
  return new Promise((resolve) => {
    if (signal?.aborted) {
      resolve('aborted')
      return
    }

    const finish = (result: 'exited' | 'aborted'): void => {
      cleanup()
      resolve(result)
    }

    let timer: ReturnType<typeof setTimeout> | null = null
    let handle: unknown = null

    const cleanup = (): void => {
      if (timer) {
        clearTimeout(timer)
        timer = null
      }
      if (handle) {
        try {
          CloseHandle(handle)
        } catch {
          /* ignore */
        }
        handle = null
      }
      signal?.removeEventListener('abort', onAbort)
    }

    const onAbort = (): void => finish('aborted')
    signal?.addEventListener('abort', onAbort, { once: true })

    handle = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid)
    if (!handle) {
      // 已退出，或权限不足：轻量轮询存在性
      const tick = (): void => {
        if (signal?.aborted) {
          finish('aborted')
          return
        }
        if (!isPidAlive(pid)) {
          finish('exited')
          return
        }
        timer = setTimeout(tick, 1000)
      }
      tick()
      return
    }

    // 仅用 GetExitCodeProcess（瞬时），避免 WaitForSingleObject 阻塞主线程
    const tickExit = (): void => {
      if (signal?.aborted) {
        finish('aborted')
        return
      }
      const code = [0]
      if (GetExitCodeProcess(handle, code) && code[0] !== STILL_ACTIVE) {
        finish('exited')
        return
      }
      if (!isPidAlive(pid)) {
        finish('exited')
        return
      }
      timer = setTimeout(tickExit, 1000)
    }
    tickExit()
  })
}

export function terminatePids(pids: number[], force = false): void {
  const unique = [...new Set(pids.filter((p) => p > 0))]
  for (const pid of unique) {
    const access = force
      ? PROCESS_TERMINATE | PROCESS_QUERY_LIMITED_INFORMATION
      : PROCESS_TERMINATE
    const h = OpenProcess(access, 0, pid)
    if (!h) continue
    try {
      TerminateProcess(h, 1)
    } finally {
      CloseHandle(h)
    }
  }
}

function getClassName(hwnd: unknown): string {
  const buf = Buffer.alloc(512)
  const n = GetClassNameW(hwnd, buf, 256)
  if (!n) return ''
  return buf.toString('utf16le', 0, n * 2)
}

/** 将指定 PID 的 Chrome 窗口恢复并置顶 */
export function focusWindowsByPids(pids: number[]): number {
  if (!pids.length) return 0
  const set = new Set(pids)
  const hwnds: unknown[] = []

  const cb = koffi.register((hwnd: unknown) => {
    if (!IsWindowVisible(hwnd)) return true
    const pidOut = [0]
    GetWindowThreadProcessId(hwnd, pidOut)
    if (!set.has(pidOut[0])) return true
    const cls = getClassName(hwnd)
    if (!cls.startsWith('Chrome_WidgetWin_')) return true
    if (GetWindowTextLengthW(hwnd) <= 0) return true
    hwnds.push(hwnd)
    return true
  }, koffi.pointer(EnumWindowsProc))

  try {
    EnumWindows(cb, 0)
  } finally {
    koffi.unregister(cb)
  }

  let n = 0
  const curTid = GetCurrentThreadId()
  for (const hWnd of hwnds) {
    try {
      if (IsIconic(hWnd)) ShowWindow(hWnd, SW_RESTORE)
      const fg = GetForegroundWindow()
      const fgPid = [0]
      const fgTid = fg ? GetWindowThreadProcessId(fg, fgPid) : 0
      const tgtPid = [0]
      const tgtTid = GetWindowThreadProcessId(hWnd, tgtPid)
      AttachThreadInput(curTid, tgtTid, 1)
      if (fgTid) AttachThreadInput(curTid, fgTid, 1)
      BringWindowToTop(hWnd)
      SetForegroundWindow(hWnd)
      SetWindowPos(hWnd, HWND_TOPMOST, 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE | SWP_SHOWWINDOW)
      SetWindowPos(hWnd, HWND_NOTOPMOST, 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE | SWP_SHOWWINDOW)
      if (fgTid) AttachThreadInput(curTid, fgTid, 0)
      AttachThreadInput(curTid, tgtTid, 0)
      n++
    } catch (err) {
      logger.warn('environment', '置顶窗口失败', { err: String(err) })
    }
  }
  return n
}

/** 单次：把自定义 ICO 注入到指定 PID 的 Chrome 窗口 */
export function applyWindowIconsSync(icoPath: string, pids: number[]): number {
  if (!pids.length || !existsSync(icoPath)) return 0
  const set = new Set(pids)
  const big = LoadImageW(null, icoPath, IMAGE_ICON, 32, 32, LR_LOADFROMFILE)
  if (!big) return -1
  let small = LoadImageW(null, icoPath, IMAGE_ICON, 16, 16, LR_LOADFROMFILE)
  if (!small) small = big

  let n = 0
  const bigAddr = koffi.address(big)
  const smallAddr = koffi.address(small)

  const cb = koffi.register((hwnd: unknown) => {
    if (!IsWindowVisible(hwnd)) return true
    const pidOut = [0]
    GetWindowThreadProcessId(hwnd, pidOut)
    if (!set.has(pidOut[0])) return true
    const cls = getClassName(hwnd)
    if (!cls.startsWith('Chrome_WidgetWin_')) return true
    SendMessageW(hwnd, WM_SETICON, 1, bigAddr)
    SendMessageW(hwnd, WM_SETICON, 0, smallAddr)
    try {
      SetClassLongPtrW(hwnd, GCLP_HICON, bigAddr)
      SetClassLongPtrW(hwnd, GCLP_HICONSM, smallAddr)
    } catch {
      /* ignore */
    }
    n++
    return true
  }, koffi.pointer(EnumWindowsProc))

  try {
    EnumWindows(cb, 0)
  } finally {
    koffi.unregister(cb)
  }
  return n
}

/**
 * 短暂多次注入图标后自动停止（替代常驻 PowerShell 监视）。
 * Chrome 启动初期会把图标改回 TEST，前若干秒覆盖即可。
 */
export function startBriefIconBoost(
  icoPath: string,
  getPids: () => number[],
  opts?: { rounds?: number; intervalMs?: number }
): { stop: () => void } {
  const rounds = opts?.rounds ?? 12
  const intervalMs = opts?.intervalMs ?? 800
  let round = 0
  let timer: ReturnType<typeof setTimeout> | null = null
  let stopped = false

  const stop = (): void => {
    stopped = true
    if (timer) {
      clearTimeout(timer)
      timer = null
    }
  }

  const tick = (): void => {
    if (stopped) return
    try {
      const pids = getPids()
      if (pids.length) applyWindowIconsSync(icoPath, pids)
    } catch (err) {
      logger.warn('environment', '短暂图标注入失败', { err: String(err) })
    }
    round += 1
    if (round < rounds && !stopped) {
      timer = setTimeout(tick, intervalMs)
    }
  }

  timer = setTimeout(tick, 200)
  return { stop }
}
