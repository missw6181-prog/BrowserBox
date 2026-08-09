import { request as httpRequest } from 'http'
import { connect as tcpConnect } from 'net'
import { connect as tlsConnect } from 'tls'
import { URL } from 'url'
import * as ProxyChain from 'proxy-chain'
import type { ProxyConfig, ProxyStatus } from '../../shared/types'
import { proxyManager } from './ProxyManager'
import { logger } from '../logger/Logger'

export interface ProxyTestResult {
  status: ProxyStatus
  exitIp?: string
  country?: string
  city?: string
  isp?: string
  latencyMs?: number
  error?: string
}

/**
 * HTTP GET via local HTTP proxy (absolute-form request).
 * Prefer this for ip-api.com — avoids CONNECT/TLS complexity.
 */
function httpGetViaProxy(
  localProxyUrl: string,
  targetUrl: string,
  timeoutMs: number
): Promise<{ body: string; latencyMs: number; statusCode: number }> {
  const started = Date.now()
  const target = new URL(targetUrl)
  const proxy = new URL(localProxyUrl)

  return new Promise((resolve, reject) => {
    const req = httpRequest(
      {
        host: proxy.hostname,
        port: Number(proxy.port),
        method: 'GET',
        // absolute-form required when talking to an HTTP proxy
        path: target.href,
        headers: {
          Host: target.host,
          'User-Agent': 'BrowserBox/1.0',
          Connection: 'close',
          Accept: 'application/json'
        },
        timeout: timeoutMs
      },
      (resp) => {
        const chunks: Buffer[] = []
        resp.on('data', (c) => chunks.push(c))
        resp.on('end', () => {
          resolve({
            body: Buffer.concat(chunks).toString('utf8'),
            latencyMs: Date.now() - started,
            statusCode: resp.statusCode || 0
          })
        })
      }
    )
    req.on('error', reject)
    req.on('timeout', () => {
      req.destroy()
      reject(new Error('timeout'))
    })
    req.end()
  })
}

/**
 * HTTPS GET via local HTTP proxy using CONNECT + TLS (correct socket wrap).
 */
function httpsGetViaProxy(
  localProxyUrl: string,
  targetUrl: string,
  timeoutMs: number
): Promise<{ body: string; latencyMs: number; statusCode: number }> {
  const started = Date.now()
  const target = new URL(targetUrl)
  const proxy = new URL(localProxyUrl)
  const port = target.port ? Number(target.port) : 443

  return new Promise((resolve, reject) => {
    const connectReq = httpRequest({
      host: proxy.hostname,
      port: Number(proxy.port),
      method: 'CONNECT',
      path: `${target.hostname}:${port}`,
      headers: {
        Host: `${target.hostname}:${port}`,
        'User-Agent': 'BrowserBox/1.0'
      },
      timeout: timeoutMs
    })

    connectReq.on('connect', (res, socket, head) => {
      if (res.statusCode !== 200) {
        socket.destroy()
        reject(new Error(`CONNECT failed: ${res.statusCode}`))
        return
      }

      const tlsSocket = tlsConnect(
        {
          socket,
          host: target.hostname,
          servername: target.hostname,
          timeout: timeoutMs
        },
        () => {
          if (head && head.length) {
            // leftover data from CONNECT — rare; discard for GET
          }
          const path = target.pathname + target.search
          const payload =
            `GET ${path} HTTP/1.1\r\n` +
            `Host: ${target.host}\r\n` +
            `User-Agent: BrowserBox/1.0\r\n` +
            `Accept: application/json\r\n` +
            `Connection: close\r\n\r\n`
          tlsSocket.write(payload)
        }
      )

      const chunks: Buffer[] = []
      tlsSocket.on('data', (c) => chunks.push(c))
      tlsSocket.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8')
        const sep = raw.indexOf('\r\n\r\n')
        if (sep < 0) {
          reject(new Error('invalid HTTP response'))
          return
        }
        const header = raw.slice(0, sep)
        const body = raw.slice(sep + 4)
        const statusLine = header.split('\r\n')[0] || ''
        const m = statusLine.match(/HTTP\/\d\.\d\s+(\d+)/)
        resolve({
          body,
          latencyMs: Date.now() - started,
          statusCode: m ? Number(m[1]) : 0
        })
      })
      tlsSocket.on('error', reject)
      tlsSocket.on('timeout', () => {
        tlsSocket.destroy()
        reject(new Error('timeout'))
      })
    })

    connectReq.on('error', reject)
    connectReq.on('timeout', () => {
      connectReq.destroy()
      reject(new Error('timeout'))
    })
    // Some proxies respond without emitting 'connect' if not handled — ensure we listen before end
    connectReq.end()
  })
}

function classifyError(err: unknown): { status: ProxyStatus; message: string } {
  const msg = err instanceof Error ? err.message : String(err)
  if (/timeout/i.test(msg)) return { status: 'timeout', message: msg }
  if (/407|auth|authenticat|username|password|not allowed/i.test(msg)) {
    return { status: 'auth_failed', message: msg }
  }
  return { status: 'connection_failed', message: msg }
}

/**
 * Shadowrocket 列表延迟同类算法：TCP 连接到代理 host:port 的耗时。
 * 不测认证、不测出网，只测入口连通。
 */
export function tcpConnectLatency(host: string, port: number, timeoutMs = 5000): Promise<number> {
  return new Promise((resolve, reject) => {
    const started = Date.now()
    const socket = tcpConnect({ host, port }, () => {
      const ms = Date.now() - started
      socket.destroy()
      resolve(ms)
    })
    socket.setTimeout(timeoutMs)
    socket.on('timeout', () => {
      socket.destroy()
      reject(new Error('timeout'))
    })
    socket.on('error', (err) => {
      socket.destroy()
      reject(err)
    })
  })
}

export class ProxyTester {
  /**
   * 列表延迟（对齐 Shadowrocket）：仅 TCP 探测代理入口。
   */
  async ping(proxyId: string): Promise<ProxyTestResult> {
    const proxy = proxyManager.get(proxyId)
    if (!proxy) {
      return { status: 'unknown_error', error: '代理不存在' }
    }
    if (proxy.type === 'direct') {
      proxyManager.update(proxyId, { status: 'ok', latencyMs: 0 })
      return { status: 'ok', latencyMs: 0 }
    }

    try {
      const latencyMs = await tcpConnectLatency(proxy.host, proxy.port, 5000)
      proxyManager.update(proxyId, { status: 'ok', latencyMs })
      return { status: 'ok', latencyMs }
    } catch (err) {
      const { status, message } = classifyError(err)
      proxyManager.update(proxyId, { status, latencyMs: undefined })
      return { status, error: message }
    }
  }

  /**
   * 完整出网测试：经代理查出口 IP；延迟字段仍用 TCP 入口延迟（与列表一致）。
   */
  async test(proxyId: string): Promise<ProxyTestResult> {
    const proxy = proxyManager.get(proxyId)
    if (!proxy) {
      return { status: 'unknown_error', error: '代理不存在' }
    }
    if (proxy.type === 'direct') {
      return { status: 'ok', exitIp: '', latencyMs: 0 }
    }

    proxyManager.update(proxyId, { status: 'testing' })

    let anonymized: string | null = null
    let connectMs = 0
    try {
      try {
        connectMs = await tcpConnectLatency(proxy.host, proxy.port, 5000)
      } catch (e) {
        const { status, message } = classifyError(e)
        proxyManager.update(proxyId, { status })
        return { status, error: message }
      }

      const upstream = proxyManager.toUpstreamUrl(proxyId)
      if (!upstream) {
        return { status: 'unknown_error', error: '无效上游' }
      }

      const safeUpstream = upstream.replace(/\/\/([^@/]+)@/, '//***@')
      logger.info('proxy-test', `开始测试 ${proxy.name}`, { type: proxy.type, upstream: safeUpstream })

      anonymized = await ProxyChain.anonymizeProxy(upstream)

      let body = ''
      let statusCode = 0
      let lastError: unknown

      try {
        const r = await httpGetViaProxy(
          anonymized,
          'http://ip-api.com/json/?fields=status,country,countryCode,city,isp,query',
          15000
        )
        body = r.body
        statusCode = r.statusCode
      } catch (e1) {
        lastError = e1
        logger.warn('proxy-test', `HTTP 探测失败，改用 HTTPS CONNECT: ${String(e1)}`)
        try {
          const r = await httpsGetViaProxy(anonymized, 'https://ipwho.is/', 15000)
          body = r.body
          statusCode = r.statusCode
          lastError = undefined
        } catch (e2) {
          lastError = e2
        }
      }

      if (lastError) throw lastError
      if (statusCode >= 400) {
        throw new Error(`上游返回 HTTP ${statusCode}`)
      }

      const data = JSON.parse(body)
      const latencyMs = connectMs

      if (data.status === 'success' || data.status === 'fail') {
        if (data.status !== 'success') {
          const result: ProxyTestResult = {
            status: 'unknown_error',
            error: data.message || 'IP 查询失败',
            latencyMs
          }
          proxyManager.update(proxyId, { status: result.status, latencyMs })
          return result
        }
        const result: ProxyTestResult = {
          status: 'ok',
          exitIp: data.query,
          country: data.countryCode || data.country,
          city: data.city,
          isp: data.isp,
          latencyMs
        }
        proxyManager.update(proxyId, {
          status: 'ok',
          exitIp: result.exitIp,
          country: result.country,
          city: result.city,
          isp: result.isp,
          latencyMs
        })
        return result
      }

      if (data.success === true || data.ip) {
        const result: ProxyTestResult = {
          status: 'ok',
          exitIp: data.ip,
          country: data.country_code || data.country,
          city: data.city,
          isp: data.connection?.isp || data.org,
          latencyMs
        }
        proxyManager.update(proxyId, {
          status: 'ok',
          exitIp: result.exitIp,
          country: result.country,
          city: result.city,
          isp: result.isp,
          latencyMs
        })
        return result
      }

      throw new Error('无法解析 IP 查询响应')
    } catch (err) {
      const { status, message } = classifyError(err)
      logger.error('proxy-test', `测试失败: ${message}`)
      proxyManager.update(proxyId, { status, latencyMs: connectMs || undefined })
      return { status, error: message, latencyMs: connectMs || undefined }
    } finally {
      if (anonymized) {
        try {
          await ProxyChain.closeAnonymizedProxy(anonymized, true)
        } catch {
          /* ignore */
        }
      }
    }
  }
}

export const proxyTester = new ProxyTester()

export type { ProxyConfig }
