/**
 * 环境 .box 导入/导出：zip = manifest.json + profiles/<envId>/
 * 始终包含 Profile；勾选导出代理时写入完整代理信息（含明文密码）。
 */
import {
  createWriteStream,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  cpSync,
  writeFileSync
} from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { Open } from 'unzipper'
import type { Environment, ProxyConfig, ProxyType } from '../../shared/types'
import { ErrorCodes } from '../../shared/types'
import { decryptSecret } from '../config/crypto'
import { configManager } from '../config/ConfigManager'
import { proxyManager } from '../proxy/ProxyManager'
import { environmentManager } from './EnvironmentManager'
import { logger } from '../logger/Logger'

export interface BoxProxyMeta {
  id: string
  name: string
  type: ProxyType
  host: string
  port: number
  username: string
  /** 明文密码（仅写入用户主动勾选「导出代理」的 .box） */
  password: string
  country: string
  city: string
  isp: string
  remark: string
}

export interface BoxManifest {
  formatVersion: 1
  exportedAt: string
  includeProxies: boolean
  environments: Environment[]
  proxies?: BoxProxyMeta[]
}

export interface ExportBoxResult {
  path: string
  count: number
  missingProfiles: string[]
}

export interface ImportBoxResult {
  imported: Array<{ id: string; displayId: string; name: string }>
  proxiesCreated: number
  needPassword: string[]
  skipped: Array<{ name: string; reason: string }>
}

function proxyKey(p: { type: string; host: string; port: number; username?: string }): string {
  return `${p.type}|${p.host}|${p.port}|${p.username || ''}`
}

function assertStopped(ids: string[]): void {
  for (const id of ids) {
    const row = environmentManager.get(id)
    if (!row) throw { code: ErrorCodes.ENV_NOT_FOUND, message: `环境不存在: ${id}` }
    if (row.status === 'running' || row.status === 'starting' || row.status === 'stopping') {
      throw {
        code: ErrorCodes.ENV_ALREADY_RUNNING,
        message: `请先关闭环境再导出：${row.displayId} ${row.name}`
      }
    }
  }
}

function toProxyMeta(p: ProxyConfig): BoxProxyMeta {
  return {
    id: p.id,
    name: p.name,
    type: p.type,
    host: p.host,
    port: p.port,
    username: p.username || '',
    password: decryptSecret(p.passwordEncrypted) || '',
    country: p.country || '',
    city: p.city || '',
    isp: p.isp || '',
    remark: p.remark || ''
  }
}

async function zipDirectory(srcDir: string, destPath: string): Promise<void> {
  // archiver v8：ESM，使用 ZipArchive 类（不再是 archiver('zip')）
  const { ZipArchive } = await import('archiver')
  await new Promise<void>((resolve, reject) => {
    const output = createWriteStream(destPath)
    const archive = new ZipArchive({ zlib: { level: 6 } })
    output.on('close', () => resolve())
    output.on('error', reject)
    archive.on('error', reject)
    archive.pipe(output)
    archive.directory(srcDir, false)
    void archive.finalize()
  })
}

async function unzipTo(filePath: string, destDir: string): Promise<void> {
  const directory = await Open.file(filePath)
  await directory.extract({ path: destDir })
}

export async function exportBox(
  ids: string[],
  opts: { includeProxies: boolean; destPath: string }
): Promise<ExportBoxResult> {
  const unique = [...new Set(ids.filter(Boolean))]
  if (!unique.length) {
    throw { code: ErrorCodes.CONFIG_INVALID, message: '没有可导出的环境' }
  }
  assertStopped(unique)

  const allEnvs = configManager.get('environments')
  const envs = unique.map((id) => {
    const e = allEnvs.find((x) => x.id === id)
    if (!e) throw { code: ErrorCodes.ENV_NOT_FOUND, message: `环境不存在: ${id}` }
    return e
  })

  const includeProxies = !!opts.includeProxies
  let proxies: BoxProxyMeta[] | undefined
  if (includeProxies) {
    const proxyIds = new Set(envs.map((e) => e.proxyId).filter(Boolean) as string[])
    proxies = []
    for (const pid of proxyIds) {
      const p = proxyManager.get(pid)
      if (p) proxies.push(toProxyMeta(p))
    }
  } else {
    // 导出快照里清掉绑定，避免导入端误用旧 id
    // （manifest 仍保留原始字段副本时：单独 clone 一份）
  }

  const snapshotEnvs: Environment[] = envs.map((e) => {
    const copy: Environment = { ...e, window: { ...e.window }, tags: [...(e.tags || [])] }
    if (!includeProxies) copy.proxyId = null
    return copy
  })

  const manifest: BoxManifest = {
    formatVersion: 1,
    exportedAt: new Date().toISOString(),
    includeProxies,
    environments: snapshotEnvs,
    ...(includeProxies ? { proxies } : {})
  }

  const tmpRoot = mkdtempSync(join(tmpdir(), 'bb-box-export-'))
  const missingProfiles: string[] = []
  try {
    writeFileSync(join(tmpRoot, 'manifest.json'), JSON.stringify(manifest, null, 2), 'utf8')
    const profilesRoot = join(tmpRoot, 'profiles')
    mkdirSync(profilesRoot, { recursive: true })

    for (const e of envs) {
      const src = configManager.resolvePath(e.profilePath)
      const dst = join(profilesRoot, e.id)
      if (existsSync(src)) {
        cpSync(src, dst, { recursive: true })
      } else {
        mkdirSync(dst, { recursive: true })
        missingProfiles.push(`${e.displayId} ${e.name}`)
      }
    }

    await zipDirectory(tmpRoot, opts.destPath)
    logger.info('environment', `已导出 ${envs.length} 个环境`, {
      path: opts.destPath,
      includeProxies,
      missingProfiles
    })
    return { path: opts.destPath, count: envs.length, missingProfiles }
  } finally {
    try {
      rmSync(tmpRoot, { recursive: true, force: true })
    } catch {
      /* ignore */
    }
  }
}

function resolveProxyId(
  oldProxyId: string | null | undefined,
  includeProxies: boolean,
  proxies: BoxProxyMeta[] | undefined,
  idMap: Map<string, string>,
  needPassword: string[]
): string | null {
  if (!includeProxies || !oldProxyId) return null
  if (idMap.has(oldProxyId)) {
    const mapped = idMap.get(oldProxyId)!
    return mapped || null
  }

  const meta = (proxies || []).find((p) => p.id === oldProxyId)
  if (!meta) {
    idMap.set(oldProxyId, '')
    return null
  }

  const key = proxyKey(meta)
  const existing = proxyManager.list().find((p) => proxyKey(p) === key)
  if (existing) {
    idMap.set(oldProxyId, existing.id)
    return existing.id
  }

  const created = proxyManager.create({
    name: meta.name || `${meta.host}:${meta.port}`,
    type: meta.type,
    host: meta.host,
    port: meta.port,
    username: meta.username || '',
    password: meta.password || '',
    remark: meta.remark || ''
  })
  // 补地区元数据（create 不接收 country）
  proxyManager.update(created.id, {
    country: meta.country || '',
    city: meta.city || '',
    isp: meta.isp || ''
  })
  idMap.set(oldProxyId, created.id)
  if ((meta.username || '').trim() && !(meta.password || '').trim()) {
    needPassword.push(`${created.name || created.host}:${created.port}`)
  }
  return created.id
}

export async function importBox(filePath: string): Promise<ImportBoxResult> {
  if (!filePath || !existsSync(filePath)) {
    throw { code: ErrorCodes.IMPORT_INVALID, message: '导入文件不存在' }
  }

  const tmpRoot = mkdtempSync(join(tmpdir(), 'bb-box-import-'))
  const result: ImportBoxResult = {
    imported: [],
    proxiesCreated: 0,
    needPassword: [],
    skipped: []
  }

  try {
    await unzipTo(filePath, tmpRoot)
    const manifestPath = join(tmpRoot, 'manifest.json')
    if (!existsSync(manifestPath)) {
      throw { code: ErrorCodes.IMPORT_INVALID, message: '无效的 .box：缺少 manifest.json' }
    }

    let manifest: BoxManifest
    try {
      manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as BoxManifest
    } catch {
      throw { code: ErrorCodes.IMPORT_INVALID, message: '无效的 .box：manifest.json 无法解析' }
    }

    if (manifest.formatVersion !== 1 || !Array.isArray(manifest.environments)) {
      throw { code: ErrorCodes.IMPORT_INVALID, message: '不支持的 .box 格式版本或内容损坏' }
    }

    const includeProxies = !!manifest.includeProxies && Array.isArray(manifest.proxies)
    const proxyIdMap = new Map<string, string>()
    const needPassword: string[] = []
    let proxiesCreated = 0

    // 预创建包内代理映射（按需）
    if (includeProxies) {
      const before = new Set(proxyManager.list().map((p) => p.id))
      for (const meta of manifest.proxies || []) {
        resolveProxyId(meta.id, true, manifest.proxies, proxyIdMap, needPassword)
      }
      proxiesCreated = proxyManager.list().filter((p) => !before.has(p.id)).length
    }

    for (const src of manifest.environments) {
      if (!src || !src.name) {
        result.skipped.push({ name: '(未知)', reason: '缺少名称' })
        continue
      }

      try {
        const mappedProxy =
          includeProxies && src.proxyId
            ? resolveProxyId(src.proxyId, true, manifest.proxies, proxyIdMap, needPassword)
            : null

        const created = environmentManager.create({
          name: src.name,
          proxyId: mappedProxy,
          browserVersion: src.browserVersion || '',
          groupId: null,
          tags: Array.isArray(src.tags) ? [...src.tags] : [],
          remark: src.remark || '',
          color: src.color,
          browserLang: src.browserLang || '',
          randomFingerprint: false,
          window: src.window
            ? { ...src.window }
            : undefined
        })

        // 恢复指纹等字段（create 未覆盖）
        const all = configManager.get('environments')
        const idx = all.findIndex((e) => e.id === created.id)
        if (idx >= 0) {
          all[idx] = {
            ...all[idx],
            randomFingerprint: src.randomFingerprint,
            fingerprintMode: src.fingerprintMode,
            fingerprint: src.fingerprint,
            lastFingerprint: undefined,
            updatedAt: new Date().toISOString()
          }
          configManager.set('environments', all)
        }

        const dstAbs = configManager.resolvePath(created.profilePath)
        const srcProfile = join(tmpRoot, 'profiles', src.id)
        rmSync(dstAbs, { recursive: true, force: true })
        if (existsSync(srcProfile)) {
          cpSync(srcProfile, dstAbs, { recursive: true })
        } else {
          mkdirSync(dstAbs, { recursive: true })
        }

        const finalEnv = configManager.get('environments').find((e) => e.id === created.id)!
        result.imported.push({
          id: finalEnv.id,
          displayId: finalEnv.displayId,
          name: finalEnv.name
        })
      } catch (err) {
        const reason =
          err && typeof err === 'object' && 'message' in err
            ? String((err as { message: string }).message)
            : String(err)
        result.skipped.push({ name: src.name, reason })
      }
    }

    result.proxiesCreated = proxiesCreated
    result.needPassword = [...new Set(needPassword)]
    logger.info('environment', `已导入 ${result.imported.length} 个环境`, {
      proxiesCreated,
      needPassword: result.needPassword.length,
      skipped: result.skipped.length
    })
    return result
  } finally {
    try {
      rmSync(tmpRoot, { recursive: true, force: true })
    } catch {
      /* ignore */
    }
  }
}
