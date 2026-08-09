import { randomUUID } from 'crypto'
import type { ProxyConfig, ProxyType, ProxyViewRow } from '../../shared/types'
import { ErrorCodes } from '../../shared/types'
import { configManager } from '../config/ConfigManager'
import { encryptSecret, decryptSecret } from '../config/crypto'

export interface CreateProxyInput {
  name: string
  type: ProxyType
  host: string
  port: number
  username?: string
  password?: string
  remark?: string
}

export interface ParsedProxyLine {
  type: ProxyType
  host: string
  port: number
  username: string
  password: string
}

/** Parse common proxy line formats */
export function parseProxyLine(line: string): ParsedProxyLine | null {
  const raw = line.trim()
  if (!raw || raw.startsWith('#')) return null

  // scheme://user:pass@host:port
  const urlMatch = raw.match(/^(https?|socks4|socks5):\/\/(?:([^:@/]+):([^@/]*)@)?([^:/]+):(\d+)$/i)
  if (urlMatch) {
    const type = urlMatch[1].toLowerCase() as ProxyType
    return {
      type: type === 'https' ? 'https' : type,
      host: urlMatch[4],
      port: Number(urlMatch[5]),
      username: decodeURIComponent(urlMatch[2] || ''),
      password: decodeURIComponent(urlMatch[3] || '')
    }
  }

  // host:port:user:pass
  const parts = raw.split(':')
  if (parts.length === 2) {
    return { type: 'http', host: parts[0], port: Number(parts[1]), username: '', password: '' }
  }
  if (parts.length === 4) {
    return {
      type: 'http',
      host: parts[0],
      port: Number(parts[1]),
      username: parts[2],
      password: parts[3]
    }
  }
  if (parts.length === 5) {
    // type:host:port:user:pass
    const t = parts[0].toLowerCase()
    if (['http', 'https', 'socks4', 'socks5'].includes(t)) {
      return {
        type: t as ProxyType,
        host: parts[1],
        port: Number(parts[2]),
        username: parts[3],
        password: parts[4]
      }
    }
  }
  return null
}

const PROXY_TYPE_LABEL: Record<ProxyType, string> = {
  direct: '直连',
  http: 'HTTP',
  https: 'HTTPS',
  socks4: 'SOCKS4',
  socks5: 'SOCKS5'
}

export class ProxyManager {
  list(): ProxyConfig[] {
    return configManager.get('proxies')
  }

  /** 带明文密码的列表（仅供本机 UI / 导出） */
  listDetailed(): ProxyViewRow[] {
    return this.list().map((p) => {
      const { passwordEncrypted, ...rest } = p
      return {
        ...rest,
        password: decryptSecret(passwordEncrypted),
        address: `${p.host}:${p.port}`
      }
    })
  }

  /**
   * 导出为 TXT，每条格式：
   * 1
   * 代理类型：HTTP
   * IP：1.1.1.1
   * 端口：8080
   * 账号：user
   * 密码：pass
   * 国家：KR
   */
  exportTxt(): string {
    const blocks: string[] = []
    const list = this.listDetailed()
    list.forEach((p, index) => {
      blocks.push(
        [
          String(index + 1),
          `代理类型：${PROXY_TYPE_LABEL[p.type] || p.type.toUpperCase()}`,
          `IP：${p.host || ''}`,
          `端口：${p.port ?? ''}`,
          `账号：${p.username || ''}`,
          `密码：${p.password || ''}`,
          `国家：${p.country || ''}`
        ].join('\r\n')
      )
    })
    // Notepad 友好 UTF-8 BOM
    return `\uFEFF${blocks.join('\r\n\r\n')}${blocks.length ? '\r\n' : ''}`
  }

  get(id: string): ProxyConfig | undefined {
    return this.list().find((p) => p.id === id)
  }

  create(input: CreateProxyInput): ProxyConfig {
    const now = new Date().toISOString()
    const proxy: ProxyConfig = {
      id: `proxy_${randomUUID()}`,
      name: input.name || `${input.host}:${input.port}`,
      type: input.type,
      host: input.host,
      port: input.port,
      username: input.username || '',
      passwordEncrypted: encryptSecret(input.password || ''),
      country: '',
      city: '',
      isp: '',
      remark: input.remark || '',
      status: 'untested',
      createdAt: now,
      updatedAt: now
    }
    const all = this.list()
    all.push(proxy)
    configManager.set('proxies', all)
    return proxy
  }

  update(
    id: string,
    patch: Partial<CreateProxyInput> & {
      country?: string
      city?: string
      isp?: string
      status?: ProxyConfig['status']
      exitIp?: string
      latencyMs?: number | undefined
    }
  ): ProxyConfig {
    const all = this.list()
    const idx = all.findIndex((p) => p.id === id)
    if (idx < 0) throw { code: ErrorCodes.PROXY_NOT_FOUND, message: '代理不存在' }
    const cur = all[idx]
    const next: ProxyConfig = {
      ...cur,
      name: patch.name ?? cur.name,
      type: patch.type ?? cur.type,
      host: patch.host ?? cur.host,
      port: patch.port ?? cur.port,
      username: patch.username ?? cur.username,
      remark: patch.remark ?? cur.remark,
      country: patch.country ?? cur.country,
      city: patch.city ?? cur.city,
      isp: patch.isp ?? cur.isp,
      status: patch.status ?? cur.status,
      exitIp: patch.exitIp ?? cur.exitIp,
      latencyMs: Object.prototype.hasOwnProperty.call(patch, 'latencyMs') ? patch.latencyMs : cur.latencyMs,
      lastTestedAt: patch.status ? new Date().toISOString() : cur.lastTestedAt,
      updatedAt: new Date().toISOString()
    }
    if (patch.password !== undefined) {
      next.passwordEncrypted = encryptSecret(patch.password)
    }
    all[idx] = next
    configManager.set('proxies', all)
    return next
  }

  delete(id: string, force = false): void {
    const envs = configManager.get('environments').filter((e) => e.proxyId === id)
    if (envs.length > 0 && !force) {
      throw {
        code: ErrorCodes.PROXY_NOT_FOUND,
        message: `该代理正在被 ${envs.length} 个环境使用`,
        details: { envIds: envs.map((e) => e.id) }
      }
    }
    if (force && envs.length > 0) {
      const allEnvs = configManager.get('environments').map((e) =>
        e.proxyId === id ? { ...e, proxyId: null, updatedAt: new Date().toISOString() } : e
      )
      configManager.set('environments', allEnvs)
    }
    configManager.set(
      'proxies',
      this.list().filter((p) => p.id !== id)
    )
  }

  deleteMany(
    ids: string[],
    force = false
  ): { ok: string[]; failed: Array<{ id: string; message: string }> } {
    const unique = [...new Set(ids.filter(Boolean))]
    const result = { ok: [] as string[], failed: [] as Array<{ id: string; message: string }> }
    for (const id of unique) {
      try {
        this.delete(id, force)
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

  importLines(text: string): { created: number; failed: number; errors: string[] } {
    const lines = text.split(/\r?\n/)
    let created = 0
    let failed = 0
    const errors: string[] = []
    for (const line of lines) {
      const parsed = parseProxyLine(line)
      if (!parsed) {
        if (line.trim()) {
          failed++
          errors.push(`无法解析: ${line.trim()}`)
        }
        continue
      }
      this.create({
        name: `${parsed.host}:${parsed.port}`,
        type: parsed.type,
        host: parsed.host,
        port: parsed.port,
        username: parsed.username,
        password: parsed.password
      })
      created++
    }
    return { created, failed, errors }
  }

  /** Plain password for local proxy / testing only — never send to renderer by default */
  getPasswordPlain(id: string): string {
    const p = this.get(id)
    if (!p) throw { code: ErrorCodes.PROXY_NOT_FOUND, message: '代理不存在' }
    return decryptSecret(p.passwordEncrypted)
  }

  toUpstreamUrl(id: string): string | null {
    const p = this.get(id)
    if (!p || p.type === 'direct') return null
    const pass = decryptSecret(p.passwordEncrypted)
    const scheme = p.type === 'https' ? 'http' : p.type
    const auth =
      p.username && pass
        ? `${encodeURIComponent(p.username)}:${encodeURIComponent(pass)}@`
        : p.username
          ? `${encodeURIComponent(p.username)}@`
          : ''
    return `${scheme}://${auth}${p.host}:${p.port}`
  }
}

export const proxyManager = new ProxyManager()
