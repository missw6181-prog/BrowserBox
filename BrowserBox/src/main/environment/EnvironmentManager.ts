import { existsSync, mkdirSync, rmSync, cpSync } from 'fs'
import { randomUUID } from 'crypto'
import { BrowserWindow } from 'electron'
import type { Environment, EnvironmentStatus, FingerprintProfile, FingerprintSnapshot, WindowState } from '../../shared/types'
import { ErrorCodes } from '../../shared/types'
import { configManager } from '../config/ConfigManager'
import { proxyManager } from '../proxy/ProxyManager'
import { localProxyManager } from '../proxy/LocalProxyManager'
import { browserManager } from '../browser/BrowserManager'
import { logger } from '../logger/Logger'
import {
  colorForDisplayId,
  ensureEnvShortcut,
  killChromeByUserDataDir,
  launchViaShortcut,
  removeEnvShortcut,
  waitForChromePids,
  preparePatchedChromeExe,
  removePatchedChromeExe,
  applyWindowIcons,
  writeEnvAppIcon,
  startBriefIconBoost,
  waitForProcessExit,
  focusEnvWindows
} from '../browser/TaskbarShortcut'
import { findChromePidsByUserDataDirSync } from '../win32/native'
import { countryToLocale, type RegionLocale } from '../locale/regionLocale'
import { getLanguagePreset } from '../../shared/localePresets'
import { applyAcceptLanguages } from '../locale/profilePrefs'
import { collectFingerprint, findFreePort, applySessionOverrides } from '../cdp/CdpClient'
import {
  generateFingerprintProfile,
  isValidFingerprintProfile
} from '../fingerprint/generateProfile'
import { alignFingerprintToChromeVersion } from '../fingerprint/uaMeta'
import { FingerprintSession } from '../fingerprint/FingerprintSession'

export interface CreateEnvironmentInput {
  name: string
  proxyId?: string | null
  browserVersion?: string
  groupId?: string | null
  tags?: string[]
  remark?: string
  color?: string
  /** 空字符串 = 自动；否则为 LANGUAGE_PRESETS.id */
  browserLang?: string | null
  /** 是否创建时随机指纹，默认 true */
  randomFingerprint?: boolean
  window?: Partial<WindowState>
}

export interface BatchCreateInput {
  count: number
  namePrefix?: string
  /** 不传 / 空：全部直连；多个：按顺序轮询分配 */
  proxyIds?: string[]
  browserVersion?: string
  remark?: string
  browserLang?: string | null
  randomFingerprint?: boolean
}

export interface BatchResult {
  ok: string[]
  failed: Array<{ id: string; message: string }>
}

interface RuntimeState {
  status: EnvironmentStatus
  chromePid?: number
  localProxyPort?: number
  debugPort?: number
  startedAt?: string
  profileAbs?: string
  icoPath?: string
  appliedRegion?: RegionLocale | null
  /** 取消进程退出等待 */
  watchAbort?: AbortController
  /** 停止短暂图标注入 */
  stopIconBoost?: (() => void) | null
  /** 常驻 CDP：仅用于 addScript（Chrome 151 已无法可靠 --load-extension） */
  fingerprintSession?: FingerprintSession | null
}

function padDisplayId(n: number): string {
  return String(n).padStart(3, '0')
}

/** 分配最小可用编号（删除后可复用，全部删光后从 001 起） */
function allocateDisplayId(existing: Environment[]): string {
  const used = new Set<number>()
  for (const e of existing) {
    const n = parseInt(e.displayId, 10)
    if (Number.isFinite(n) && n > 0) used.add(n)
  }
  let n = 1
  while (used.has(n)) n += 1
  return padDisplayId(n)
}

export class EnvironmentManager {
  private runtime = new Map<string, RuntimeState>()
  private onRuntimeChange: (() => void) | null = null

  setRuntimeChangeListener(fn: (() => void) | null): void {
    this.onRuntimeChange = fn
  }

  private shortcutsDir(): string {
    return configManager.resolvePath('Shortcuts')
  }

  private broadcastStatus(id: string, status: EnvironmentStatus, chromePid?: number): void {
    const payload = { id, status, chromePid }
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.isDestroyed()) win.webContents.send('environment:status', payload)
    }
  }

  private setRuntime(id: string, state: RuntimeState): void {
    const prev = this.runtime.get(id)
    this.runtime.set(id, state)
    this.broadcastStatus(id, state.status, state.chromePid)
    if (!prev || prev.status !== state.status) {
      try {
        this.onRuntimeChange?.()
      } catch {
        /* ignore */
      }
    }
  }

  /** 切换数据目录前清空运行态 */
  clearRuntime(): void {
    for (const id of [...this.runtime.keys()]) {
      this.clearWatch(id)
    }
    this.runtime.clear()
  }

  /** 停止全部运行中的环境（切换数据目录前调用） */
  async stopAll(force = true): Promise<void> {
    const ids = [...this.runtime.entries()]
      .filter(([, rt]) => rt.status !== 'stopped')
      .map(([id]) => id)
    for (const id of ids) {
      try {
        await this.stop(id, force)
      } catch {
        /* ignore */
      }
    }
    this.clearRuntime()
  }

  list(): Array<Environment & { status: EnvironmentStatus; chromePid?: number }> {
    return configManager.get('environments').map((e) => {
      const rt = this.runtime.get(e.id)
      return {
        ...e,
        status: rt?.status || 'stopped',
        chromePid: rt?.chromePid
      }
    })
  }

  get(id: string): (Environment & { status: EnvironmentStatus }) | undefined {
    return this.list().find((e) => e.id === id)
  }

  create(input: CreateEnvironmentInput): Environment {
    const settings = configManager.get('settings')
    const id = `env_${randomUUID()}`
    const all = configManager.get('environments')
    const displayId = allocateDisplayId(all)
    const profilePath = `Profiles/${id}`
    const absProfile = configManager.resolvePath(profilePath)
    mkdirSync(absProfile, { recursive: true })

    const randomFingerprint = input.randomFingerprint !== false
    const settingsMode = settings.fingerprintMode || 'ua'
    const fingerprintMode: Environment['fingerprintMode'] =
      randomFingerprint && (settingsMode === 'ua' || settingsMode === 'cdp') ? settingsMode : undefined
    const now = new Date().toISOString()
    const env: Environment = {
      id,
      displayId,
      name: input.name || `环境${displayId}`,
      profilePath,
      browserVersion: input.browserVersion || settings.defaultBrowserVersion || '',
      proxyId: input.proxyId ?? null,
      groupId: input.groupId ?? null,
      tags: input.tags || [],
      remark: input.remark || '',
      color: input.color || colorForDisplayId(displayId),
      browserLang: input.browserLang?.trim() || '',
      randomFingerprint,
      fingerprintMode,
      window: {
        width: input.window?.width ?? settings.defaultWindow.width,
        height: input.window?.height ?? settings.defaultWindow.height,
        x: input.window?.x,
        y: input.window?.y,
        maximized: input.window?.maximized ?? false
      },
      fingerprint: randomFingerprint ? generateFingerprintProfile() : undefined,
      createdAt: now,
      updatedAt: now
    }

    all.push(env)
    configManager.set('environments', all)
    // 保持 nextDisplayId 为「当前最大编号 + 1」，兼容旧逻辑/外部读取
    const maxId = Math.max(
      0,
      ...all.map((e) => parseInt(e.displayId, 10)).filter((n) => Number.isFinite(n))
    )
    configManager.updateSettings({ nextDisplayId: maxId + 1 })
    this.setRuntime(id, { status: 'stopped' })
    logger.info('environment', `创建环境 ${displayId} ${env.name}`)
    return env
  }

  createMany(input: BatchCreateInput): Environment[] {
    const count = Math.floor(Number(input.count) || 0)
    if (count < 1 || count > 200) {
      throw { code: ErrorCodes.CONFIG_INVALID, message: '批量数量需在 1–200 之间' }
    }
    const prefix = (input.namePrefix || '环境').trim() || '环境'
    const proxyIds = (input.proxyIds || []).filter(Boolean)
    for (const pid of proxyIds) {
      if (!proxyManager.get(pid)) {
        throw { code: ErrorCodes.PROXY_NOT_FOUND, message: `代理不存在: ${pid}` }
      }
    }

    const created: Environment[] = []
    for (let i = 0; i < count; i++) {
      const proxyId = proxyIds.length ? proxyIds[i % proxyIds.length] : null
      // 先占位创建拿 displayId，再用「前缀+编号」命名
      const env = this.create({
        name: prefix,
        proxyId,
        browserVersion: input.browserVersion,
        remark: input.remark,
        browserLang: input.browserLang,
        randomFingerprint: input.randomFingerprint
      })
      const named = this.update(env.id, { name: `${prefix}${env.displayId}` })
      created.push(named)
    }
    logger.info('environment', `批量创建 ${created.length} 个环境`, { prefix })
    return created
  }

  async startMany(ids: string[]): Promise<BatchResult> {
    const unique = [...new Set(ids.filter(Boolean))]
    const result: BatchResult = { ok: [], failed: [] }
    const interval = Math.max(0, configManager.get('settings').launchIntervalMs || 1000)

    // 队列中的环境先标为启动中，便于 UI 立即反馈
    for (const id of unique) {
      const rt = this.runtime.get(id)
      if (!rt || !['running', 'starting', 'stopping'].includes(rt.status)) {
        this.setRuntime(id, { ...(rt || {}), status: 'starting' })
      }
    }

    for (let i = 0; i < unique.length; i++) {
      const id = unique[i]
      try {
        await this.start(id)
        result.ok.push(id)
      } catch (err) {
        const message =
          err && typeof err === 'object' && 'message' in err
            ? String((err as { message: string }).message)
            : String(err)
        result.failed.push({ id, message })
      }
      if (i < unique.length - 1 && interval > 0) {
        await new Promise((r) => setTimeout(r, interval))
      }
    }
    return result
  }

  async stopMany(ids: string[], force = false): Promise<BatchResult> {
    const unique = [...new Set(ids.filter(Boolean))]
    const result: BatchResult = { ok: [], failed: [] }
    for (const id of unique) {
      try {
        await this.stop(id, force)
        result.ok.push(id)
      } catch (err) {
        const message =
          err && typeof err === 'object' && 'message' in err
            ? String((err as { message: string }).message)
            : String(err)
        result.failed.push({ id, message })
      }
    }
    return result
  }

  deleteMany(ids: string[], mode: 'config' | 'config+profile' = 'config+profile'): BatchResult {
    const unique = [...new Set(ids.filter(Boolean))]
    const result: BatchResult = { ok: [], failed: [] }
    for (const id of unique) {
      try {
        this.delete(id, mode)
        result.ok.push(id)
      } catch (err) {
        const message =
          err && typeof err === 'object' && 'message' in err
            ? String((err as { message: string }).message)
            : String(err)
        result.failed.push({ id, message })
      }
    }
    return result
  }

  update(id: string, patch: Partial<CreateEnvironmentInput>): Environment {
    const all = configManager.get('environments')
    const idx = all.findIndex((e) => e.id === id)
    if (idx < 0) throw { code: ErrorCodes.ENV_NOT_FOUND, message: '环境不存在' }
    const cur = all[idx]
    const next: Environment = {
      ...cur,
      name: patch.name ?? cur.name,
      proxyId: patch.proxyId !== undefined ? patch.proxyId : cur.proxyId,
      browserVersion: patch.browserVersion ?? cur.browserVersion,
      groupId: patch.groupId !== undefined ? patch.groupId : cur.groupId,
      tags: patch.tags ?? cur.tags,
      remark: patch.remark ?? cur.remark,
      color: patch.color !== undefined ? patch.color : cur.color,
      browserLang:
        patch.browserLang !== undefined ? String(patch.browserLang || '').trim() : cur.browserLang || '',
      window: patch.window ? { ...cur.window, ...patch.window } : cur.window,
      updatedAt: new Date().toISOString()
    }
    all[idx] = next
    configManager.set('environments', all)
    return next
  }

  delete(id: string, mode: 'config' | 'config+profile' = 'config+profile'): void {
    const rt = this.runtime.get(id)
    if (rt && (rt.status === 'running' || rt.status === 'starting')) {
      throw { code: ErrorCodes.ENV_ALREADY_RUNNING, message: '请先关闭环境再删除' }
    }
    const env = configManager.get('environments').find((e) => e.id === id)
    if (!env) throw { code: ErrorCodes.ENV_NOT_FOUND, message: '环境不存在' }

    configManager.set(
      'environments',
      configManager.get('environments').filter((e) => e.id !== id)
    )
    this.clearWatch(id)
    this.runtime.delete(id)
    removeEnvShortcut(this.shortcutsDir(), id)
    try {
      const chromePath = browserManager.resolveExecutable(env.browserVersion)
      removePatchedChromeExe(chromePath || undefined, id)
    } catch {
      /* ignore */
    }

    if (mode === 'config+profile') {
      const abs = configManager.resolvePath(env.profilePath)
      if (existsSync(abs)) {
        rmSync(abs, { recursive: true, force: true })
      }
    }
    logger.info('environment', `删除环境 ${env.displayId}`)
  }

  clone(id: string): Environment {
    const src = configManager.get('environments').find((e) => e.id === id)
    if (!src) throw { code: ErrorCodes.ENV_NOT_FOUND, message: '环境不存在' }
    const rt = this.runtime.get(id)
    if (rt && rt.status === 'running') {
      throw { code: ErrorCodes.ENV_ALREADY_RUNNING, message: '请先关闭环境再克隆' }
    }

    const created = this.create({
      name: `${src.name}-副本`,
      proxyId: src.proxyId,
      browserVersion: src.browserVersion,
      groupId: src.groupId,
      tags: [...src.tags],
      remark: src.remark,
      color: src.color,
      window: { ...src.window }
    })

    const srcAbs = configManager.resolvePath(src.profilePath)
    const dstAbs = configManager.resolvePath(created.profilePath)
    if (existsSync(srcAbs)) {
      rmSync(dstAbs, { recursive: true, force: true })
      cpSync(srcAbs, dstAbs, { recursive: true })
    }
    return created
  }

  private clearWatch(id: string): void {
    const rt = this.runtime.get(id)
    if (rt?.watchAbort) {
      try {
        rt.watchAbort.abort()
      } catch {
        /* ignore */
      }
      rt.watchAbort = undefined
    }
    if (rt?.stopIconBoost) {
      try {
        rt.stopIconBoost()
      } catch {
        /* ignore */
      }
      rt.stopIconBoost = null
    }
    if (rt?.fingerprintSession) {
      const sess = rt.fingerprintSession
      rt.fingerprintSession = null
      void sess.stop().catch(() => undefined)
    }
  }

  /** 等待 Chrome 主进程退出（句柄/轻量探测，不轮询 WMI） */
  private watchUntilExit(id: string, chromePid: number): void {
    const rt = this.runtime.get(id)
    if (rt?.watchAbort) {
      try {
        rt.watchAbort.abort()
      } catch {
        /* ignore */
      }
    }
    const ac = new AbortController()
    if (rt) rt.watchAbort = ac

    void (async () => {
      const result = await waitForProcessExit(chromePid, ac.signal)
      if (result === 'aborted') return
      const cur = this.runtime.get(id)
      if (!cur || cur.status === 'stopping' || cur.status === 'stopped') return
      this.clearWatch(id)
      await localProxyManager.stop(id)
      this.setRuntime(id, { status: 'stopped' })
      logger.info('environment', `Chrome 已退出 ${id}`, { chromePid })
    })()
  }

  /** 将运行中的环境窗口置顶显示 */
  async focus(id: string): Promise<{ focused: number }> {
    const env = configManager.get('environments').find((e) => e.id === id)
    if (!env) throw { code: ErrorCodes.ENV_NOT_FOUND, message: '环境不存在' }
    const rt = this.runtime.get(id)
    if (!rt || (rt.status !== 'running' && rt.status !== 'starting')) {
      throw { code: ErrorCodes.ENV_NOT_FOUND, message: `环境${env.displayId}未在运行` }
    }
    const profileAbs = rt.profileAbs || configManager.resolvePath(env.profilePath)
    const focused = await focusEnvWindows({
      displayId: env.displayId,
      name: env.name,
      userDataDir: profileAbs
    })
    if (!focused) {
      throw { code: ErrorCodes.ENV_NOT_FOUND, message: `未找到环境${env.displayId}的窗口，可能已关闭` }
    }
    return { focused }
  }

  listRunning(): Array<{ id: string; displayId: string; name: string; status: EnvironmentStatus }> {
    return configManager
      .get('environments')
      .map((e) => {
        const rt = this.runtime.get(e.id)
        return {
          id: e.id,
          displayId: e.displayId,
          name: e.name,
          status: rt?.status || ('stopped' as EnvironmentStatus)
        }
      })
      .filter((e) => e.status === 'running' || e.status === 'starting')
  }

  async start(id: string): Promise<void> {
    let env = configManager.get('environments').find((e) => e.id === id)
    if (!env) throw { code: ErrorCodes.ENV_NOT_FOUND, message: '环境不存在' }

    // 旧环境补档：开启随机指纹且无档案时生成
    env = this.ensureFingerprintProfile(env)
    let fingerprint = isValidFingerprintProfile(env.fingerprint) ? env.fingerprint : null

    const rt = this.runtime.get(id) || { status: 'stopped' as EnvironmentStatus }
    if (rt.status === 'running') {
      throw { code: ErrorCodes.ENV_ALREADY_RUNNING, message: `环境${env.displayId}已经运行` }
    }
    if (rt.status === 'stopping') {
      throw { code: ErrorCodes.ENV_ALREADY_RUNNING, message: `环境${env.displayId}正在停止` }
    }

    this.setRuntime(id, { status: 'starting' })
    let profileAbs = ''
    try {
      const chromePath = browserManager.resolveExecutable(env.browserVersion)
      if (!chromePath || !existsSync(chromePath)) {
        throw {
          code: ErrorCodes.BROWSER_NOT_FOUND,
          message:
            '未找到可用浏览器。请在「浏览器管理」下载指定版本的 Chrome for Testing，或确认本机已安装 Google Chrome 并将环境浏览器设为「本机 Chrome」'
        }
      }

      // UA 与真实 Chrome 版本对齐，避免 Client Hints / 检测站版本矛盾
      const chromeVer = browserManager.getChromeVersion(chromePath)
      if (fingerprint && chromeVer) {
        fingerprint = alignFingerprintToChromeVersion(fingerprint, chromeVer)
        // 写回档案中的 UA（保持其它字段），避免抽屉展示与网站不一致
        if (fingerprint.userAgent !== env.fingerprint?.userAgent) {
          const all = configManager.get('environments')
          const idx = all.findIndex((e) => e.id === id)
          if (idx >= 0) {
            all[idx] = {
              ...all[idx],
              fingerprint: {
                ...fingerprint,
                generatedAt: all[idx].fingerprint?.generatedAt || fingerprint.generatedAt
              },
              updatedAt: new Date().toISOString()
            }
            configManager.set('environments', all)
            env = all[idx]
          }
        }
      }

      profileAbs = configManager.resolvePath(env.profilePath)
      mkdirSync(profileAbs, { recursive: true })

      let proxyArg: string | undefined
      let localProxyPort: number | undefined
      let boundProxy = env.proxyId ? proxyManager.get(env.proxyId) : null
      if (env.proxyId) {
        if (!boundProxy) throw { code: ErrorCodes.PROXY_NOT_FOUND, message: '绑定的代理不存在' }
        const handle = await localProxyManager.start(id, boundProxy)
        if (handle) {
          proxyArg = handle.localUrl.replace(/^https?:\/\//, '')
          localProxyPort = handle.port
        }
      } else {
        await localProxyManager.stop(id)
      }

      const settings = configManager.get('settings')
      const syncLocale = settings.syncLocaleWithProxy !== false
      const fingerprintMode = settings.fingerprintMode || 'ua'
      const proxyRegion =
        syncLocale && boundProxy?.country ? countryToLocale(boundProxy.country) : null
      const langPreset = getLanguagePreset(env.browserLang)
      // 环境单独指定语言优先；时区仍优先跟代理国家（避免 IP 时区与语言冲突时可人工再调）
      const appliedRegion: RegionLocale | null = langPreset
        ? {
            country: proxyRegion?.country || '',
            lang: langPreset.lang,
            acceptLanguages: langPreset.acceptLanguages,
            locale: langPreset.locale,
            timezone: proxyRegion?.timezone || langPreset.timezone
          }
        : proxyRegion
      if (appliedRegion) {
        applyAcceptLanguages(profileAbs, appliedRegion.acceptLanguages)
      }

      const debugPort = await findFreePort()

      const injectLanguages = appliedRegion
        ? appliedRegion.acceptLanguages
            .split(',')
            .map((s) => s.trim().split(';')[0])
            .filter(Boolean)
        : fingerprint?.languages || []

      const title = `【${env.displayId}】${env.name}`
      const winW = env.window.width || 1280
      const winH = env.window.height || 900
      const args = [
        `--user-data-dir=${profileAbs}`,
        '--no-first-run',
        '--no-default-browser-check',
        '--disable-infobars',
        `--window-size=${winW},${winH}`,
        `--remote-debugging-port=${debugPort}`,
        '--remote-allow-origins=*'
      ]
      if (fingerprint && fingerprintMode !== 'off') {
        args.push(`--user-agent=${fingerprint.userAgent}`)
      }
      if (appliedRegion) {
        args.push(`--lang=${appliedRegion.lang}`)
      } else if (fingerprint && fingerprintMode !== 'off' && fingerprint.languages[0]) {
        args.push(`--lang=${fingerprint.languages[0]}`)
      }
      if (proxyArg) {
        args.push(`--proxy-server=${proxyArg}`)
        args.push('--proxy-bypass-list=<-loopback>')
      }
      if (typeof env.window.x === 'number' && typeof env.window.y === 'number') {
        args.push(`--window-position=${env.window.x},${env.window.y}`)
      }

      const icoPath = configManager.resolvePath(`Shortcuts/${env.id}.ico`)
      await writeEnvAppIcon(icoPath, env.displayId)

      const { exePath: launchExePath, patched } = await preparePatchedChromeExe(
        chromePath,
        env.id,
        icoPath
      )

      const { lnkPath } = ensureEnvShortcut({
        envId: env.id,
        displayId: env.displayId,
        name: env.name,
        launchExePath,
        chromePathForAumid: chromePath,
        userDataDir: profileAbs,
        args,
        shortcutsDir: this.shortcutsDir()
      })

      logger.info('environment', `启动 ${title}`, {
        chromePath,
        launchExePath,
        patched,
        args,
        lnkPath,
        debugPort,
        appliedRegion
      })

      await launchViaShortcut(lnkPath)

      const pids = await waitForChromePids(profileAbs)
      if (!pids.length) {
        throw { code: ErrorCodes.BROWSER_NOT_FOUND, message: '浏览器进程未能在时限内启动' }
      }

      // ua：短时 CDP 只打时区/UA metadata 后断开（BrowserScan 友好）
      // cdp：常驻会话注入硬件字段（易标机器人）
      let fingerprintSession: FingerprintSession | null = null
      if (fingerprint && fingerprintMode === 'cdp') {
        try {
          fingerprintSession = new FingerprintSession(debugPort, fingerprint, {
            region: appliedRegion,
            acceptLanguage: appliedRegion?.acceptLanguages || fingerprint.languages.join(','),
            injectLanguages
          })
          await fingerprintSession.start()
        } catch (err) {
          logger.warn('environment', 'CDP 深度伪装失败（浏览器仍会启动）', {
            err: String(err),
            debugPort
          })
          fingerprintSession = null
        }
      } else if (appliedRegion || (fingerprint && fingerprintMode === 'ua')) {
        try {
          await applySessionOverrides({
            port: debugPort,
            region: appliedRegion,
            fingerprint: fingerprint && fingerprintMode === 'ua' ? fingerprint : null,
            acceptLanguage:
              appliedRegion?.acceptLanguages || fingerprint?.languages.join(',') || undefined,
            injectLanguages,
            skipScriptInject: true
          })
        } catch (err) {
          logger.warn('environment', '短时 UA/时区覆盖失败', { err: String(err), debugPort })
        }
      }

      // 立即注入 + 短暂多次覆盖（替代常驻 PowerShell 监视）
      const applied = await applyWindowIcons(icoPath, pids)
      logger.info('environment', `窗口图标注入 ${applied} 个窗口`)
      const iconBoost = startBriefIconBoost(icoPath, () =>
        findChromePidsByUserDataDirSync(profileAbs)
      )

      this.setRuntime(id, {
        status: 'running',
        chromePid: pids[0],
        localProxyPort,
        debugPort,
        startedAt: new Date().toISOString(),
        profileAbs,
        icoPath,
        appliedRegion,
        stopIconBoost: iconBoost.stop,
        fingerprintSession
      })
      this.watchUntilExit(id, pids[0])

      void (async () => {
        await new Promise((r) => setTimeout(r, 1500))
        await this.refreshFingerprintCache(id)
      })().catch((err) => {
        logger.warn('environment', '启动后指纹缓存失败', { id, err: String(err) })
      })

      const all = configManager.get('environments')
      const idx = all.findIndex((e) => e.id === id)
      if (idx >= 0) {
        all[idx] = {
          ...all[idx],
          lastStartedAt: new Date().toISOString(),
          updatedAt: new Date().toISOString()
        }
        configManager.set('environments', all)
      }
    } catch (err) {
      if (profileAbs) {
        await killChromeByUserDataDir(profileAbs, true)
      }
      await localProxyManager.stop(id)
      this.clearWatch(id)
      this.setRuntime(id, { status: 'browser_error' })
      throw err
    }
  }

  async stop(id: string, force = false): Promise<void> {
    const env = configManager.get('environments').find((e) => e.id === id)
    const rt = this.runtime.get(id)
    if (!rt || rt.status === 'stopped') return
    this.setRuntime(id, { ...rt, status: 'stopping' })
    this.clearWatch(id)

    try {
      const profileAbs = rt.profileAbs || (env ? configManager.resolvePath(env.profilePath) : '')
      if (profileAbs) {
        await killChromeByUserDataDir(profileAbs, force)
      } else if (rt.chromePid) {
        try {
          process.kill(rt.chromePid)
        } catch {
          /* already dead */
        }
      }
    } finally {
      await localProxyManager.stop(id)
      this.setRuntime(id, { status: 'stopped' })
    }
  }

  getRuntimeSummary(): Array<{ id: string; status: EnvironmentStatus; chromePid?: number }> {
    return [...this.runtime.entries()].map(([id, rt]) => ({
      id,
      status: rt.status,
      chromePid: rt.chromePid
    }))
  }

  private saveFingerprint(id: string, snap: FingerprintSnapshot): void {
    const all = configManager.get('environments')
    const idx = all.findIndex((e) => e.id === id)
    if (idx < 0) return
    all[idx] = {
      ...all[idx],
      lastFingerprint: snap,
      updatedAt: new Date().toISOString()
    }
    configManager.set('environments', all)
  }

  /** 确保环境有有效伪装档案；缺失则生成并写回（显式关闭随机指纹的环境不补档） */
  private ensureFingerprintProfile(env: Environment): Environment {
    if (env.randomFingerprint === false) return env
    if (isValidFingerprintProfile(env.fingerprint)) return env
    const fingerprint = generateFingerprintProfile()
    const settingsMode = configManager.get('settings').fingerprintMode || 'ua'
    const fingerprintMode: Environment['fingerprintMode'] =
      settingsMode === 'ua' || settingsMode === 'cdp' ? settingsMode : undefined
    const all = configManager.get('environments')
    const idx = all.findIndex((e) => e.id === env.id)
    if (idx < 0) return { ...env, fingerprint, randomFingerprint: true, fingerprintMode }
    const next: Environment = {
      ...all[idx],
      fingerprint,
      randomFingerprint: true,
      fingerprintMode: all[idx].fingerprintMode || fingerprintMode,
      updatedAt: new Date().toISOString()
    }
    all[idx] = next
    configManager.set('environments', all)
    logger.info('environment', `已为环境补生成指纹档案 ${env.displayId}`, { seed: fingerprint.seed })
    return next
  }

  /**
   * 重新随机指纹档案（仅已停止的环境）。
   */
  regenerateFingerprint(id: string): Environment {
    const env = configManager.get('environments').find((e) => e.id === id)
    if (!env) throw { code: ErrorCodes.ENV_NOT_FOUND, message: '环境不存在' }
    const rt = this.runtime.get(id)
    if (rt && (rt.status === 'running' || rt.status === 'starting' || rt.status === 'stopping')) {
      throw { code: ErrorCodes.ENV_ALREADY_RUNNING, message: '请先关闭环境再重新随机指纹' }
    }
    const fingerprint = generateFingerprintProfile()
    const settingsMode = configManager.get('settings').fingerprintMode || 'ua'
    const fingerprintMode: Environment['fingerprintMode'] =
      settingsMode === 'ua' || settingsMode === 'cdp' ? settingsMode : undefined
    const all = configManager.get('environments')
    const idx = all.findIndex((e) => e.id === id)
    const next: Environment = {
      ...all[idx],
      fingerprint,
      randomFingerprint: true,
      fingerprintMode,
      lastFingerprint: undefined,
      updatedAt: new Date().toISOString()
    }
    all[idx] = next
    configManager.set('environments', all)
    logger.info('environment', `已重新随机指纹 ${env.displayId}`, { seed: fingerprint.seed })
    return next
  }

  private async refreshFingerprintCache(id: string): Promise<FingerprintSnapshot | null> {
    const rt = this.runtime.get(id)
    if (!rt || rt.status !== 'running') return null
    let snap: FingerprintSnapshot
    if (rt.fingerprintSession) {
      snap = await rt.fingerprintSession.collect(rt.appliedRegion || undefined)
    } else if (rt.debugPort) {
      snap = await collectFingerprint(rt.debugPort, rt.appliedRegion || undefined)
    } else {
      return null
    }
    this.saveFingerprint(id, snap)
    return snap
  }

  /**
   * 获取指纹：返回伪装档案；运行中实时采集；已停止则返回上次缓存。
   */
  async getFingerprint(id: string): Promise<{
    live: boolean
    snapshot: FingerprintSnapshot | null
    profile: FingerprintProfile | null
    proxyCountry: string
    appliedRegion: RegionLocale | null
  }> {
    let env = configManager.get('environments').find((e) => e.id === id)
    if (!env) throw { code: ErrorCodes.ENV_NOT_FOUND, message: '环境不存在' }
    env = this.ensureFingerprintProfile(env)

    const proxy = env.proxyId ? proxyManager.get(env.proxyId) : null
    const proxyCountry = proxy?.country || ''
    const rt = this.runtime.get(id)
    const appliedRegion = rt?.appliedRegion ?? null
    const profile = env.fingerprint || null

    if (rt?.status === 'running') {
      try {
        const snap = rt.fingerprintSession
          ? await rt.fingerprintSession.collect(appliedRegion || undefined)
          : rt.debugPort
            ? await collectFingerprint(rt.debugPort, appliedRegion || undefined)
            : null
        if (snap) {
          this.saveFingerprint(id, snap)
          return { live: true, snapshot: snap, profile, proxyCountry, appliedRegion }
        }
      } catch (err) {
        logger.warn('environment', '实时指纹采集失败，回退缓存', { id, err: String(err) })
        return {
          live: false,
          snapshot: env.lastFingerprint || null,
          profile,
          proxyCountry,
          appliedRegion
        }
      }
    }

    return {
      live: false,
      snapshot: env.lastFingerprint || null,
      profile,
      proxyCountry,
      appliedRegion
    }
  }
}

export const environmentManager = new EnvironmentManager()
