/** Shared types for BrowserBox V1 */

export type ProxyType = 'direct' | 'http' | 'https' | 'socks4' | 'socks5'

export type ProxyStatus =
  | 'untested'
  | 'testing'
  | 'ok'
  | 'auth_failed'
  | 'connection_failed'
  | 'timeout'
  | 'unknown_error'

export type EnvironmentStatus =
  | 'stopped'
  | 'starting'
  | 'running'
  | 'stopping'
  | 'proxy_error'
  | 'browser_error'
  | 'crashed'

export type CloseAction = 'ask' | 'quit' | 'tray'

export interface AppSettings {
  configVersion: number
  dataDir: string
  defaultBrowserVersion: string
  launchIntervalMs: number
  defaultWindow: { width: number; height: number }
  logLevel: 'DEBUG' | 'INFO' | 'WARN' | 'ERROR'
  autoCheckUpdate: boolean
  autoDownloadBrowser: boolean
  theme: 'light' | 'dark' | 'system'
  language: 'zh-CN' | 'en-US'
  nextDisplayId: number
  /** 关闭主窗口默认动作：ask=每次询问，quit=退出并关环境，tray=最小化到托盘 */
  closeAction: CloseAction
  /** 用户主动删除过的 CfT 主版本：禁止再从安装包自动灌回 */
  removedBrowserMajors: string[]
  /** 启动环境时按代理国家同步语言 / Accept-Language / 时区（CDP） */
  syncLocaleWithProxy: boolean
  /**
   * 指纹伪装模式：
   * - ua：仅启动参数 UA + 短暂时区（BrowserScan 友好，默认）
   * - cdp：常驻 CDP 注入硬件字段（易被标自动化）
   * - off：关闭
   */
  fingerprintMode: 'off' | 'ua' | 'cdp'
}

/** 创建环境时持久化的轻量伪装档案（CDP 注入） */
export interface FingerprintProfile {
  seed: string
  generatedAt: string
  userAgent: string
  platform: string
  languages: string[]
  hardwareConcurrency: number
  deviceMemory: number
  screen: { width: number; height: number; colorDepth: number; pixelRatio: number }
  /** Canvas 确定性噪声强度（0–1 量级小数） */
  canvasNoise: number
  webglVendor: string
  webglRenderer: string
  /** AudioBuffer 确定性噪声强度 */
  audioNoise: number
}

/** 环境浏览器只读指纹快照（采集结果，含伪装后观测值） */
export interface FingerprintSnapshot {
  collectedAt: string
  userAgent: string
  language: string
  languages: string[]
  timezone: string
  locale?: string
  platform: string
  hardwareConcurrency: number | null
  deviceMemory: number | null
  screen: { width: number; height: number; colorDepth: number; pixelRatio: number }
  canvasHash: string
  webglVendor: string
  webglRenderer: string
  /** 启动时按代理地区意图应用的配置（便于对照） */
  applied?: {
    country: string
    lang: string
    acceptLanguages: string
    timezone: string
    locale: string
  }
}

export interface WindowState {
  width: number
  height: number
  x?: number
  y?: number
  maximized: boolean
}

export interface Environment {
  id: string
  displayId: string
  name: string
  profilePath: string
  browserVersion: string
  proxyId: string | null
  groupId: string | null
  tags: string[]
  remark: string
  color?: string
  window: WindowState
  /**
   * 浏览器语言预设 id（见 LANGUAGE_PRESETS）；空/未设 = 自动
   * （优先于「设置 → 地区语言同步」的代理国家语言，时区仍可跟代理）
   */
  browserLang?: string
  /** 创建时是否生成随机指纹档案；false 表示不生成且启动时不自动补档 */
  randomFingerprint?: boolean
  /**
   * 创建时采用的伪装模式快照（来自当时设置）：
   * ua=简单伪装，cdp=深度伪装；未开启随机指纹时不写入
   */
  fingerprintMode?: 'ua' | 'cdp'
  createdAt: string
  updatedAt: string
  lastStartedAt?: string
  /** 轻量硬件指纹伪装档案（创建时随机，启动时按设置注入） */
  fingerprint?: FingerprintProfile
  /** 最近一次采集的只读指纹 */
  lastFingerprint?: FingerprintSnapshot
}

export interface ProxyConfig {
  id: string
  name: string
  type: ProxyType
  host: string
  port: number
  username: string
  /** DPAPI encrypted blob (base64) or empty */
  passwordEncrypted: string
  country: string
  city: string
  isp: string
  remark: string
  status: ProxyStatus
  exitIp?: string
  latencyMs?: number
  lastTestedAt?: string
  createdAt: string
  updatedAt: string
}

/** UI / 导出用（含明文密码） */
export interface ProxyViewRow extends Omit<ProxyConfig, 'passwordEncrypted'> {
  password: string
  address: string
}

export interface Group {
  id: string
  name: string
  createdAt: string
}

export interface Tag {
  id: string
  name: string
  createdAt: string
}

export interface AppError {
  code: string
  message: string
  details?: Record<string, unknown>
}

export const ErrorCodes = {
  ENV_NOT_FOUND: 'ENV_NOT_FOUND',
  ENV_ALREADY_RUNNING: 'ENV_ALREADY_RUNNING',
  ENV_PROFILE_MISSING: 'ENV_PROFILE_MISSING',
  BROWSER_NOT_FOUND: 'BROWSER_NOT_FOUND',
  BROWSER_VERSION_NOT_FOUND: 'BROWSER_VERSION_NOT_FOUND',
  PROXY_NOT_FOUND: 'PROXY_NOT_FOUND',
  PROXY_AUTH_FAILED: 'PROXY_AUTH_FAILED',
  PROXY_CONNECTION_FAILED: 'PROXY_CONNECTION_FAILED',
  PROXY_TIMEOUT: 'PROXY_TIMEOUT',
  PORT_UNAVAILABLE: 'PORT_UNAVAILABLE',
  CONFIG_INVALID: 'CONFIG_INVALID',
  CONFIG_WRITE_FAILED: 'CONFIG_WRITE_FAILED',
  DATA_DIR_NOT_SET: 'DATA_DIR_NOT_SET',
  IMPORT_INVALID: 'IMPORT_INVALID',
  EXPORT_FAILED: 'EXPORT_FAILED'
} as const

export function createDefaultSettings(dataDir = ''): AppSettings {
  return {
    configVersion: 1,
    dataDir,
    defaultBrowserVersion: '',
    launchIntervalMs: 1000,
    defaultWindow: { width: 1280, height: 900 },
    logLevel: 'INFO',
    autoCheckUpdate: true,
    autoDownloadBrowser: true,
    theme: 'system',
    language: 'zh-CN',
    nextDisplayId: 1,
    closeAction: 'ask',
    removedBrowserMajors: [],
    syncLocaleWithProxy: true,
    fingerprintMode: 'ua'
  }
}
