import type { FingerprintProfile, FingerprintSnapshot } from '../../shared/types'
import { logger } from '../logger/Logger'
import type { RegionLocale } from '../locale/regionLocale'
import { buildFingerprintInjectScript } from './injectScript'
import { buildUserAgentMetadata } from './uaMeta'
import { connectCdp } from '../cdp/CdpClient'

type CdpClient = Awaited<ReturnType<typeof connectCdp>>

const COLLECT_EXPR = `(() => {
  const languages = Array.from(navigator.languages || []);
  let canvasHash = '';
  try {
    const c = document.createElement('canvas');
    c.width = 240; c.height = 60;
    const ctx = c.getContext('2d');
    if (ctx) {
      ctx.textBaseline = 'top';
      ctx.font = '14px Arial';
      ctx.fillStyle = '#f60';
      ctx.fillRect(0, 0, 240, 60);
      ctx.fillStyle = '#069';
      ctx.fillText('BrowserBox FP', 4, 20);
      const raw = c.toDataURL();
      let h = 0;
      for (let i = 0; i < raw.length; i++) h = ((h << 5) - h + raw.charCodeAt(i)) | 0;
      canvasHash = (h >>> 0).toString(16);
    }
  } catch (e) { canvasHash = 'err'; }
  let webglVendor = '';
  let webglRenderer = '';
  try {
    const c = document.createElement('canvas');
    const gl = c.getContext('webgl') || c.getContext('experimental-webgl');
    if (gl) {
      const dbg = gl.getExtension('WEBGL_debug_renderer_info');
      if (dbg) {
        webglVendor = String(gl.getParameter(dbg.UNMASKED_VENDOR_WEBGL) || '');
        webglRenderer = String(gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) || '');
      }
    }
  } catch (e) {}
  let locale = '';
  try { locale = Intl.DateTimeFormat().resolvedOptions().locale || ''; } catch (e) {}
  let timezone = '';
  try { timezone = Intl.DateTimeFormat().resolvedOptions().timeZone || ''; } catch (e) {}
  return {
    userAgent: navigator.userAgent || '',
    language: navigator.language || '',
    languages,
    timezone,
    locale,
    platform: navigator.platform || '',
    hardwareConcurrency: typeof navigator.hardwareConcurrency === 'number' ? navigator.hardwareConcurrency : null,
    deviceMemory: typeof navigator.deviceMemory === 'number' ? navigator.deviceMemory : null,
    screen: {
      width: screen.width || 0,
      height: screen.height || 0,
      colorDepth: screen.colorDepth || 0,
      pixelRatio: window.devicePixelRatio || 1
    },
    canvasHash,
    webglVendor,
    webglRenderer
  };
})()`

/** 环境运行期间保持 CDP，避免注入在断开后失效 */
export class FingerprintSession {
  private client: CdpClient | null = null
  private closed = false
  private scriptSource = ''
  private acceptLanguage = ''
  private userAgentMetadata: ReturnType<typeof buildUserAgentMetadata> | null = null

  constructor(
    private readonly port: number,
    private readonly fingerprint: FingerprintProfile,
    private readonly opts: {
      region?: RegionLocale | null
      acceptLanguage?: string
      injectLanguages?: string[]
    } = {}
  ) {}

  async start(): Promise<void> {
    const client = await connectCdp(this.port)
    if (this.closed) {
      await client.close().catch(() => undefined)
      return
    }
    this.client = client

    const region = this.opts.region
    const fingerprint = this.fingerprint
    this.acceptLanguage =
      this.opts.acceptLanguage ||
      (region ? region.acceptLanguages : fingerprint.languages.join(','))
    const injectLanguages =
      this.opts.injectLanguages ||
      (region
        ? region.acceptLanguages
            .split(',')
            .map((s) => s.trim().split(';')[0])
            .filter(Boolean)
        : fingerprint.languages)

    this.scriptSource = buildFingerprintInjectScript(fingerprint, {
      languages: injectLanguages,
      stealth: true
    })
    this.userAgentMetadata = buildUserAgentMetadata(fingerprint.userAgent)

    const { Emulation, Page, Target } = client

    if (region) {
      await Emulation.setTimezoneOverride({ timezoneId: region.timezone })
      await Emulation.setLocaleOverride({ locale: region.locale })
    }

    await this.applyUa(client)
    await Page.enable()
    // 不在此启用 Runtime（减少自动化特征）；靠 addScript + reload 生效
    await Page.addScriptToEvaluateOnNewDocument({ source: this.scriptSource })

    try {
      await Target.setDiscoverTargets({ discover: true })
      await Target.setAutoAttach({
        autoAttach: true,
        waitForDebuggerOnStart: false,
        flatten: true
      })
    } catch (err) {
      logger.warn('environment', 'Target.setAutoAttach 失败', { err: String(err) })
    }

    client.on(
      'Target.attachedToTarget',
      (event: { sessionId?: string; targetInfo?: { type?: string } }) => {
        if (this.closed) return
        if (event?.targetInfo?.type !== 'page' && event?.targetInfo?.type !== 'iframe') return
        void this.injectOnSession(event.sessionId)
      }
    )

    try {
      const { targetInfos } = await Target.getTargets()
      for (const t of targetInfos) {
        if (t.type !== 'page' || (t.url || '').startsWith('devtools://')) continue
        try {
          await Target.activateTarget({ targetId: t.targetId })
          await Page.reload({ ignoreCache: true }).catch(() => undefined)
        } catch {
          /* ignore */
        }
      }
    } catch (err) {
      logger.warn('environment', '初始页面指纹注入失败', { err: String(err) })
    }

    client.on('disconnect', () => {
      if (!this.closed) {
        logger.warn('environment', '指纹 CDP 会话意外断开', { port: this.port })
      }
      this.client = null
    })

    logger.info('environment', '指纹 CDP 会话已保持连接', {
      port: this.port,
      seed: fingerprint.seed,
      ua: fingerprint.userAgent.slice(0, 72)
    })
  }

  async collect(applied?: RegionLocale | null): Promise<FingerprintSnapshot> {
    const client = this.client
    if (!client) throw new Error('指纹 CDP 会话未连接')
    const { Target, Runtime } = client
    const { targetInfos } = await Target.getTargets()
    const page =
      targetInfos.find((t) => t.type === 'page' && !(t.url || '').startsWith('devtools://')) ||
      targetInfos.find((t) => t.type === 'page')
    if (page?.targetId) {
      try {
        await Target.activateTarget({ targetId: page.targetId })
      } catch {
        /* ignore */
      }
    }
    await Runtime.enable()
    const { result, exceptionDetails } = await Runtime.evaluate({
      expression: COLLECT_EXPR,
      returnByValue: true,
      awaitPromise: false
    })
    if (exceptionDetails) throw new Error(exceptionDetails.text || '指纹采集脚本异常')
    const v = (result?.value || {}) as Record<string, unknown>
    const screen = (v.screen || {}) as Record<string, number>
    const region = applied || this.opts.region || null
    return {
      collectedAt: new Date().toISOString(),
      userAgent: String(v.userAgent || ''),
      language: String(v.language || ''),
      languages: Array.isArray(v.languages) ? v.languages.map(String) : [],
      timezone: String(v.timezone || ''),
      locale: v.locale ? String(v.locale) : undefined,
      platform: String(v.platform || ''),
      hardwareConcurrency:
        typeof v.hardwareConcurrency === 'number' ? v.hardwareConcurrency : null,
      deviceMemory: typeof v.deviceMemory === 'number' ? v.deviceMemory : null,
      screen: {
        width: Number(screen.width) || 0,
        height: Number(screen.height) || 0,
        colorDepth: Number(screen.colorDepth) || 0,
        pixelRatio: Number(screen.pixelRatio) || 1
      },
      canvasHash: String(v.canvasHash || ''),
      webglVendor: String(v.webglVendor || ''),
      webglRenderer: String(v.webglRenderer || ''),
      applied: region
        ? {
            country: region.country,
            lang: region.lang,
            acceptLanguages: region.acceptLanguages,
            timezone: region.timezone,
            locale: region.locale
          }
        : undefined
    }
  }

  /** 在同一 CDP 会话内导航（用于验证：断开前导航仍应命中注入） */
  async navigate(url: string): Promise<void> {
    const client = this.client
    if (!client) throw new Error('指纹 CDP 会话未连接')
    await client.Page.enable()
    await client.Page.navigate({ url })
    await new Promise((r) => setTimeout(r, 800))
  }

  async evaluate<T = unknown>(expression: string): Promise<T> {
    const client = this.client
    if (!client) throw new Error('指纹 CDP 会话未连接')
    await client.Runtime.enable()
    const { result, exceptionDetails } = await client.Runtime.evaluate({
      expression,
      returnByValue: true,
      awaitPromise: true
    })
    if (exceptionDetails) throw new Error(exceptionDetails.text || 'evaluate failed')
    return result?.value as T
  }

  private async applyUa(client: CdpClient): Promise<void> {
    const fingerprint = this.fingerprint
    const meta = this.userAgentMetadata!
    await client.Emulation.setUserAgentOverride({
      userAgent: fingerprint.userAgent,
      acceptLanguage: this.acceptLanguage,
      platform: fingerprint.platform,
      userAgentMetadata: meta
    })
    try {
      await client.Network.enable()
      await client.Network.setUserAgentOverride({
        userAgent: fingerprint.userAgent,
        acceptLanguage: this.acceptLanguage,
        platform: fingerprint.platform,
        userAgentMetadata: meta
      })
    } catch {
      /* ignore */
    }
  }

  private async injectOnSession(sessionId?: string): Promise<void> {
    if (!this.client || this.closed || !this.scriptSource) return
    try {
      const page = this.client.Page as {
        enable: (p?: object, sid?: string) => Promise<unknown>
        addScriptToEvaluateOnNewDocument: (p: { source: string }, sid?: string) => Promise<unknown>
      }
      const runtime = this.client.Runtime as {
        enable: (p?: object, sid?: string) => Promise<unknown>
        evaluate: (p: { expression: string; returnByValue?: boolean }, sid?: string) => Promise<unknown>
      }
      await page.enable({}, sessionId)
      await page.addScriptToEvaluateOnNewDocument({ source: this.scriptSource }, sessionId)
      await runtime.enable({}, sessionId)
      await runtime.evaluate({ expression: this.scriptSource, returnByValue: false }, sessionId)
    } catch {
      /* ignore */
    }
  }

  async stop(): Promise<void> {
    this.closed = true
    const c = this.client
    this.client = null
    if (!c) return
    try {
      await c.close()
    } catch {
      /* ignore */
    }
  }
}
