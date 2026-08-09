import * as ProxyChain from 'proxy-chain'
import type { ProxyConfig, ProxyType } from '../../shared/types'
import { decryptSecret } from '../config/crypto'

export interface LocalProxyHandle {
  envId: string
  localUrl: string
  port: number
  anonymizedUrl: string
}

function buildUpstreamUrl(proxy: ProxyConfig, passwordPlain: string): string | null {
  if (proxy.type === 'direct') return null

  const scheme: Record<Exclude<ProxyType, 'direct'>, string> = {
    http: 'http',
    https: 'http',
    socks4: 'socks4',
    socks5: 'socks5'
  }

  const protocol = scheme[proxy.type]
  const auth =
    proxy.username && passwordPlain
      ? `${encodeURIComponent(proxy.username)}:${encodeURIComponent(passwordPlain)}@`
      : proxy.username
        ? `${encodeURIComponent(proxy.username)}@`
        : ''

  return `${protocol}://${auth}${proxy.host}:${proxy.port}`
}

/**
 * Per-environment local proxy bridge using proxy-chain.
 * Chrome always connects to http://127.0.0.1:<port> without credentials.
 */
export class LocalProxyManager {
  private running = new Map<string, LocalProxyHandle>()

  get(envId: string): LocalProxyHandle | undefined {
    return this.running.get(envId)
  }

  list(): LocalProxyHandle[] {
    return [...this.running.values()]
  }

  async start(envId: string, proxy: ProxyConfig | null): Promise<LocalProxyHandle | null> {
    await this.stop(envId)

    if (!proxy || proxy.type === 'direct') {
      return null
    }

    const password = decryptSecret(proxy.passwordEncrypted)
    const upstream = buildUpstreamUrl(proxy, password)
    if (!upstream) return null

    const anonymizedUrl = await ProxyChain.anonymizeProxy(upstream)
    const port = Number(new URL(anonymizedUrl).port)
    const handle: LocalProxyHandle = {
      envId,
      localUrl: `http://127.0.0.1:${port}`,
      port,
      anonymizedUrl
    }
    this.running.set(envId, handle)
    return handle
  }

  async stop(envId: string): Promise<void> {
    const handle = this.running.get(envId)
    if (!handle) return
    try {
      await ProxyChain.closeAnonymizedProxy(handle.anonymizedUrl, true)
    } catch {
      /* ignore */
    }
    this.running.delete(envId)
  }

  async stopAll(): Promise<void> {
    const ids = [...this.running.keys()]
    await Promise.all(ids.map((id) => this.stop(id)))
  }
}

export const localProxyManager = new LocalProxyManager()
