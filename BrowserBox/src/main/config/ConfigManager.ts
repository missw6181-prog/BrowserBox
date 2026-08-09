import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
  copyFileSync,
  readdirSync,
  statSync
} from 'fs'
import { dirname, join } from 'path'
import {
  AppSettings,
  Environment,
  Group,
  ProxyConfig,
  Tag,
  createDefaultSettings,
  ErrorCodes
} from '../../shared/types'

export type ConfigKey = 'settings' | 'environments' | 'proxies' | 'groups' | 'tags'

interface ConfigStore {
  settings: AppSettings
  environments: Environment[]
  proxies: ProxyConfig[]
  groups: Group[]
  tags: Tag[]
}

const FILE_MAP: Record<ConfigKey, string> = {
  settings: 'settings.json',
  environments: 'environments.json',
  proxies: 'proxies.json',
  groups: 'groups.json',
  tags: 'tags.json'
}

function ensureDir(dir: string): void {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
}

function atomicWriteJson(filePath: string, data: unknown): void {
  ensureDir(dirname(filePath))
  const tmp = `${filePath}.tmp`
  const json = JSON.stringify(data, null, 2)
  writeFileSync(tmp, json, 'utf8')
  // validate
  JSON.parse(readFileSync(tmp, 'utf8'))
  const bak = `${filePath}.bak`
  if (existsSync(filePath)) {
    try {
      copyFileSync(filePath, bak)
    } catch {
      /* ignore */
    }
  }
  renameSync(tmp, filePath)
}

function readJsonFile<T>(filePath: string, fallback: T): T {
  if (!existsSync(filePath)) return fallback
  try {
    const raw = readFileSync(filePath, 'utf8')
    return JSON.parse(raw) as T
  } catch {
    const bak = `${filePath}.bak`
    if (existsSync(bak)) {
      try {
        return JSON.parse(readFileSync(bak, 'utf8')) as T
      } catch {
        /* fallthrough */
      }
    }
    return fallback
  }
}

/**
 * Unified config access. All modules MUST go through ConfigManager.
 */
export class ConfigManager {
  private dataDir = ''
  private store: ConfigStore = {
    settings: createDefaultSettings(),
    environments: [],
    proxies: [],
    groups: [],
    tags: []
  }
  private ready = false

  isReady(): boolean {
    return this.ready && !!this.dataDir
  }

  getDataDir(): string {
    return this.dataDir
  }

  /** First-run or reopen: bind to user-chosen data directory */
  async initialize(dataDir: string): Promise<void> {
    if (!dataDir) {
      throw { code: ErrorCodes.DATA_DIR_NOT_SET, message: '数据目录未设置' }
    }
    this.dataDir = dataDir
    this.ensureLayout()
    this.reload()
    this.ready = true
  }

  private ensureLayout(): void {
    const root = this.dataDir
    for (const sub of ['Browser', 'Profiles', 'Config', 'Downloads', 'Logs', 'Temp', 'Backup', 'Extensions', 'Config/Backup']) {
      ensureDir(join(root, sub))
    }
  }

  private configPath(key: ConfigKey): string {
    return join(this.dataDir, 'Config', FILE_MAP[key])
  }

  reload(): void {
    const settings = readJsonFile(this.configPath('settings'), createDefaultSettings(this.dataDir))
    settings.dataDir = this.dataDir
    if (!settings.configVersion) settings.configVersion = 1
    if (!settings.nextDisplayId) settings.nextDisplayId = 1

    this.store = {
      settings,
      environments: readJsonFile(this.configPath('environments'), []),
      proxies: readJsonFile(this.configPath('proxies'), []),
      groups: readJsonFile(this.configPath('groups'), []),
      tags: readJsonFile(this.configPath('tags'), [])
    }

    // persist defaults if missing
    if (!existsSync(this.configPath('settings'))) this.save('settings')
    if (!existsSync(this.configPath('environments'))) this.save('environments')
    if (!existsSync(this.configPath('proxies'))) this.save('proxies')
    if (!existsSync(this.configPath('groups'))) this.save('groups')
    if (!existsSync(this.configPath('tags'))) this.save('tags')
  }

  get<K extends ConfigKey>(key: K): ConfigStore[K] {
    this.assertReady()
    // return deep-ish copy to avoid accidental mutation
    return structuredClone(this.store[key])
  }

  set<K extends ConfigKey>(key: K, value: ConfigStore[K]): void {
    this.assertReady()
    this.backupBeforeWrite(key)
    this.store[key] = structuredClone(value)
    this.save(key)
  }

  updateSettings(patch: Partial<AppSettings>): AppSettings {
    const next = { ...this.get('settings'), ...patch, dataDir: this.dataDir }
    this.set('settings', next)
    return this.get('settings')
  }

  private save(key: ConfigKey): void {
    try {
      atomicWriteJson(this.configPath(key), this.store[key])
    } catch (err) {
      throw {
        code: ErrorCodes.CONFIG_WRITE_FAILED,
        message: `写入配置失败: ${FILE_MAP[key]}`,
        details: { error: String(err) }
      }
    }
  }

  private backupBeforeWrite(key: ConfigKey): void {
    const src = this.configPath(key)
    if (!existsSync(src)) return
    const stamp = new Date().toISOString().replace(/[:.]/g, '-')
    const dest = join(this.dataDir, 'Config', 'Backup', `${key}_${stamp}.json`)
    try {
      ensureDir(dirname(dest))
      copyFileSync(src, dest)
      this.pruneBackups(key, 20)
    } catch {
      /* non-fatal */
    }
  }

  private pruneBackups(key: ConfigKey, keep: number): void {
    const dir = join(this.dataDir, 'Config', 'Backup')
    if (!existsSync(dir)) return
    const files = readdirSync(dir)
      .filter((f) => f.startsWith(`${key}_`) && f.endsWith('.json'))
      .map((f) => ({ f, m: statSync(join(dir, f)).mtimeMs }))
      .sort((a, b) => b.m - a.m)
    for (const item of files.slice(keep)) {
      try {
        unlinkSync(join(dir, item.f))
      } catch {
        /* ignore */
      }
    }
  }

  private assertReady(): void {
    if (!this.ready || !this.dataDir) {
      throw { code: ErrorCodes.DATA_DIR_NOT_SET, message: '请先选择数据目录' }
    }
  }

  resolvePath(...parts: string[]): string {
    this.assertReady()
    return join(this.dataDir, ...parts)
  }
}

export const configManager = new ConfigManager()
