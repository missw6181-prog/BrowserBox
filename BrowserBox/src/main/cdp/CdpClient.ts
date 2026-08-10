import { createServer } from 'net'
import CDP from 'chrome-remote-interface'
import type { FingerprintProfile, FingerprintSnapshot } from '../../shared/types'
import { logger } from '../logger/Logger'
import type { RegionLocale } from '../locale/regionLocale'
import { buildFingerprintInjectScript } from '../fingerprint/injectScript'
import { buildUserAgentMetadata } from '../fingerprint/uaMeta'

export function findFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer()
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address()
      if (!addr || typeof addr === 'string') {
        server.close()
        reject(new Error('无法分配调试端口'))
        return
      }
      const port = addr.port
      server.close((err) => {
        if (err) reject(err)
        else resolve(port)
      })
    })
    server.on('error', reject)
  })
}

async function sleep(ms: number): Promise<void> {
  await new Promise((r) => setTimeout(r, ms))
}

/** 带重试连接 CDP（Chrome 启动有竞态） */
export async function connectCdp(
  port: number,
  opts?: { retries?: number; delayMs?: number }
): Promise<ReturnType<typeof CDP> extends Promise<infer C> ? C : never> {
  const retries = opts?.retries ?? 20
  const delayMs = opts?.delayMs ?? 400
  let lastErr: unknown
  for (let i = 0; i < retries; i++) {
    try {
      return await CDP({ host: '127.0.0.1', port })
    } catch (err) {
      lastErr = err
      await sleep(delayMs)
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr))
}

export interface ApplySessionOverridesOpts {
  port: number
  region?: RegionLocale | null
  fingerprint?: FingerprintProfile | null
  /** 无代理地区同步时，用档案 languages 作为 Accept-Language */
  acceptLanguage?: string
  /** 注入脚本使用的 languages（地区同步时覆盖档案） */
  injectLanguages?: string[]
  /** 仅 UA/时区，不注入 JS、不 reload（由扩展负责注入时使用） */
  skipScriptInject?: boolean
}

/**
 * 一次 CDP 连接应用地区 + 轻量指纹伪装。
 * addScriptToEvaluateOnNewDocument / Emulation 覆盖在断开后仍对当前浏览器会话生效。
 */
export async function applySessionOverrides(opts: ApplySessionOverridesOpts): Promise<void> {
  const { port, region, fingerprint } = opts
  if (!region && !fingerprint) return

  const client = await connectCdp(port)
  try {
    const { Emulation, Page, Runtime, Target, Network } = client

    if (region) {
      await Emulation.setTimezoneOverride({ timezoneId: region.timezone })
      await Emulation.setLocaleOverride({ locale: region.locale })
      logger.info('environment', '已应用地区语言/时区覆盖', {
        port,
        timezone: region.timezone,
        locale: region.locale
      })
    }

    if (fingerprint) {
      const acceptLanguage =
        opts.acceptLanguage ||
        (region ? region.acceptLanguages : fingerprint.languages.join(','))

      const injectLanguages =
        opts.injectLanguages ||
        (region
          ? region.acceptLanguages
              .split(',')
              .map((s) => s.trim().split(';')[0])
              .filter(Boolean)
          : fingerprint.languages)

      const userAgentMetadata = buildUserAgentMetadata(fingerprint.userAgent)

      await Emulation.setUserAgentOverride({
        userAgent: fingerprint.userAgent,
        acceptLanguage,
        platform: fingerprint.platform,
        userAgentMetadata
      })

      try {
        await Network.enable()
        await Network.setUserAgentOverride({
          userAgent: fingerprint.userAgent,
          acceptLanguage,
          platform: fingerprint.platform,
          userAgentMetadata
        })
      } catch {
        /* 部分版本可无 metadata */
      }

      if (!opts.skipScriptInject) {
        const source = buildFingerprintInjectScript(fingerprint, { languages: injectLanguages })
        await Page.enable()
        await Page.addScriptToEvaluateOnNewDocument({ source })

        try {
          await Runtime.enable()
          const { targetInfos } = await Target.getTargets()
          for (const t of targetInfos) {
            if (t.type !== 'page' || t.url.startsWith('devtools://')) continue
            try {
              await Target.activateTarget({ targetId: t.targetId })
              await Runtime.evaluate({ expression: source, returnByValue: false })
              await Page.reload({ ignoreCache: true }).catch(() => undefined)
            } catch {
              /* ignore per-target */
            }
          }
        } catch (err) {
          logger.warn('environment', '对已有页面注入指纹失败（新文档仍会注入）', {
            err: String(err)
          })
        }
      }

      logger.info('environment', '已应用轻量指纹伪装', {
        port,
        seed: fingerprint.seed,
        ua: fingerprint.userAgent.slice(0, 80),
        platform: fingerprint.platform,
        hw: fingerprint.hardwareConcurrency,
        skipScriptInject: !!opts.skipScriptInject
      })
    }
  } finally {
    try {
      await client.close()
    } catch {
      /* ignore */
    }
  }
}

/** @deprecated 使用 applySessionOverrides */
export async function applyLocaleOverrides(port: number, region: RegionLocale): Promise<void> {
  await applySessionOverrides({ port, region })
}

export async function applyFingerprintOverrides(
  port: number,
  fingerprint: FingerprintProfile,
  opts?: { region?: RegionLocale | null; acceptLanguage?: string }
): Promise<void> {
  await applySessionOverrides({
    port,
    fingerprint,
    region: opts?.region,
    acceptLanguage: opts?.acceptLanguage
  })
}

const FINGERPRINT_EXPR = `(() => {
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

export async function collectFingerprint(
  port: number,
  applied?: RegionLocale
): Promise<FingerprintSnapshot> {
  const client = await connectCdp(port)
  try {
    const { Target, Runtime } = client
    const { targetInfos } = await Target.getTargets()
    const page =
      targetInfos.find((t) => t.type === 'page' && !t.url.startsWith('devtools://')) ||
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
      expression: FINGERPRINT_EXPR,
      returnByValue: true,
      awaitPromise: false
    })
    if (exceptionDetails) {
      throw new Error(exceptionDetails.text || '指纹采集脚本异常')
    }
    const v = (result?.value || {}) as Record<string, unknown>
    const screen = (v.screen || {}) as Record<string, number>
    const snap: FingerprintSnapshot = {
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
      applied: applied
        ? {
            country: applied.country,
            lang: applied.lang,
            acceptLanguages: applied.acceptLanguages,
            timezone: applied.timezone,
            locale: applied.locale
          }
        : undefined
    }
    return snap
  } finally {
    try {
      await client.close()
    } catch {
      /* ignore */
    }
  }
}
