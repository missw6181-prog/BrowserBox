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
  createdAt: string
  updatedAt: string
  lastStartedAt?: string
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
    defaultBrowserVersion: 'system',
    launchIntervalMs: 1000,
    defaultWindow: { width: 1280, height: 900 },
    logLevel: 'INFO',
    autoCheckUpdate: true,
    autoDownloadBrowser: false,
    theme: 'system',
    language: 'zh-CN',
    nextDisplayId: 1,
    closeAction: 'ask'
  }
}
