/**
 * 模拟网站页面脚本采集（含 userAgentData），与档案对比
 */
import { spawn } from 'child_process'
import { mkdtempSync, rmSync, existsSync, readdirSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { generateFingerprintProfile } from '../src/main/fingerprint/generateProfile'
import { alignFingerprintToChromeVersion } from '../src/main/fingerprint/uaMeta'
import { applySessionOverrides, findFreePort, connectCdp } from '../src/main/cdp/CdpClient'

const CHROME =
  process.env.CHROME_PATH ||
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'

function readChromeVersion(chromeExe: string): string {
  try {
    const dir = join(chromeExe, '..')
    const entries = readdirSync(dir, { withFileTypes: true })
    const verDir = entries.find((e) => e.isDirectory() && /^\d+\.\d+\.\d+\.\d+$/.test(e.name))
    return verDir?.name || ''
  } catch {
    return ''
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

const PAGE_COLLECT = `(() => {
  async function run() {
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
    let webglVendor = '', webglRenderer = '';
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
    let uaData = null;
    try {
      if (navigator.userAgentData) {
        const hi = await navigator.userAgentData.getHighEntropyValues([
          'architecture','bitness','model','platformVersion','fullVersionList','uaFullVersion','wow64'
        ]);
        uaData = {
          brands: navigator.userAgentData.brands,
          platform: navigator.userAgentData.platform,
          mobile: navigator.userAgentData.mobile,
          highEntropy: hi
        };
      }
    } catch (e) { uaData = { error: String(e) }; }
    return {
      userAgent: navigator.userAgent || '',
      platform: navigator.platform || '',
      language: navigator.language || '',
      languages,
      hardwareConcurrency: navigator.hardwareConcurrency,
      deviceMemory: navigator.deviceMemory,
      screen: {
        width: screen.width,
        height: screen.height,
        colorDepth: screen.colorDepth,
        pixelRatio: window.devicePixelRatio
      },
      webglVendor,
      webglRenderer,
      canvasHash,
      uaData
    };
  }
  return run();
})()`

async function main(): Promise<void> {
  if (!existsSync(CHROME)) {
    console.error('未找到 Chrome')
    process.exit(1)
  }

  let profile = generateFingerprintProfile()
  const ver = readChromeVersion(CHROME)
  if (ver) profile = alignFingerprintToChromeVersion(profile, ver)

  const port = await findFreePort()
  const userData = mkdtempSync(join(tmpdir(), 'bb-fp2-'))
  const htmlPath = join(userData, 'detect.html')
  writeFileSync(
    htmlPath,
    '<!doctype html><title>fp detect</title><h1>detect</h1><script>window.__ready=1</script>',
    'utf8'
  )
  const fileUrl = 'file:///' + htmlPath.replace(/\\/g, '/')

  const child = spawn(
    CHROME,
    [
      `--user-data-dir=${userData}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-extensions',
      `--remote-debugging-port=${port}`,
      '--remote-allow-origins=*',
      `--user-agent=${profile.userAgent}`,
      `--window-size=${Math.min(1280, profile.screen.width)},${Math.min(800, profile.screen.height)}`,
      fileUrl
    ],
    { stdio: 'ignore' }
  )

  try {
    await sleep(1800)
    await applySessionOverrides({
      port,
      fingerprint: profile,
      acceptLanguage: profile.languages.join(','),
      injectLanguages: profile.languages
    })
    await sleep(1500)

    const client = await connectCdp(port)
    try {
      const { Page, Runtime, Target } = client
      await Page.enable()
      await Runtime.enable()
      // 导航到检测页，确保走 addScriptToEvaluateOnNewDocument
      await Page.navigate({ url: fileUrl })
      await sleep(1000)
      const { result, exceptionDetails } = await Runtime.evaluate({
        expression: PAGE_COLLECT,
        returnByValue: true,
        awaitPromise: true
      })
      if (exceptionDetails) throw new Error(exceptionDetails.text || 'evaluate failed')
      const snap = result.value as Record<string, unknown>

      console.log('=== 档案 ===')
      console.log({
        ua: profile.userAgent,
        platform: profile.platform,
        hw: profile.hardwareConcurrency,
        mem: profile.deviceMemory,
        screen: profile.screen,
        webgl: [profile.webglVendor, profile.webglRenderer],
        languages: profile.languages
      })
      console.log('\n=== 模拟网站采集 ===')
      console.log(JSON.stringify(snap, null, 2))

      const screen = snap.screen as Record<string, number>
      const checks: Array<[string, unknown, unknown]> = [
        ['userAgent', profile.userAgent, snap.userAgent],
        ['platform', profile.platform, snap.platform],
        ['hardwareConcurrency', profile.hardwareConcurrency, snap.hardwareConcurrency],
        ['deviceMemory', profile.deviceMemory, snap.deviceMemory],
        ['screen.width', profile.screen.width, screen.width],
        ['screen.height', profile.screen.height, screen.height],
        ['webglVendor', profile.webglVendor, snap.webglVendor],
        ['webglRenderer', profile.webglRenderer, snap.webglRenderer],
        ['language', profile.languages[0], snap.language]
      ]

      const uaData = snap.uaData as {
        brands?: Array<{ brand: string; version: string }>
        highEntropy?: { uaFullVersion?: string; fullVersionList?: Array<{ brand: string; version: string }> }
      } | null

      const major = ver.split('.')[0]
      if (uaData?.brands) {
        const chromeBrand = uaData.brands.find((b) => /Chrome|Chromium/i.test(b.brand))
        checks.push(['uaData.chromeMajor', major, chromeBrand?.version])
      }
      if (uaData?.highEntropy?.uaFullVersion) {
        checks.push(['uaData.uaFullVersion', ver || profile.userAgent.match(/Chrome\/([\d.]+)/)?.[1], uaData.highEntropy.uaFullVersion])
      }

      console.log('\n=== 对比 ===')
      let fail = 0
      for (const [k, e, a] of checks) {
        const ok = String(e) === String(a)
        if (!ok) fail++
        console.log(`${ok ? 'OK ' : 'DIFF'} ${k}: expected=${e} actual=${a}`)
      }
      console.log(fail ? `\n有 ${fail} 项不一致` : '\n模拟网站采集与档案一致')
      process.exitCode = fail ? 2 : 0
    } finally {
      await client.close().catch(() => undefined)
    }
  } finally {
    try {
      child.kill()
    } catch {
      /* ignore */
    }
    try {
      spawn('taskkill', ['/F', '/T', '/PID', String(child.pid)], { stdio: 'ignore' })
    } catch {
      /* ignore */
    }
    await sleep(400)
    try {
      rmSync(userData, { recursive: true, force: true })
    } catch {
      /* ignore */
    }
  }
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
