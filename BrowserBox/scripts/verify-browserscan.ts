/**
 * BrowserScan：stealth CDP 注入后检查真实度文案与关键字段
 */
import { spawn } from 'child_process'
import { mkdtempSync, rmSync, existsSync, readdirSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { generateFingerprintProfile } from '../src/main/fingerprint/generateProfile'
import { alignFingerprintToChromeVersion } from '../src/main/fingerprint/uaMeta'
import { FingerprintSession } from '../src/main/fingerprint/FingerprintSession'
import { findFreePort } from '../src/main/cdp/CdpClient'

const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
const SCAN_URL = 'https://www.browserscan.net/zh'

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

async function main(): Promise<void> {
  if (!existsSync(CHROME)) process.exit(1)
  let profile = generateFingerprintProfile()
  const ver = readChromeVersion(CHROME)
  if (ver) profile = alignFingerprintToChromeVersion(profile, ver)
  console.log('profile', {
    ua: profile.userAgent,
    hw: profile.hardwareConcurrency,
    mem: profile.deviceMemory,
    lang: profile.languages[0]
  })

  const port = await findFreePort()
  const userData = mkdtempSync(join(tmpdir(), 'bb-scan2-'))
  const child = spawn(
    CHROME,
    [
      `--user-data-dir=${userData}`,
      '--no-first-run',
      '--disable-infobars',
      '--disable-blink-features=AutomationControlled',
      `--remote-debugging-port=${port}`,
      '--remote-allow-origins=*',
      `--user-agent=${profile.userAgent}`,
      'about:blank'
    ],
    { stdio: 'ignore' }
  )

  const session = new FingerprintSession(port, profile, {
    acceptLanguage: profile.languages.join(','),
    injectLanguages: profile.languages
  })

  try {
    await sleep(2000)
    await session.start()
    await sleep(800)
    await session.navigate(SCAN_URL)
    await sleep(9000)

    const client = (session as unknown as { client: { Runtime: { enable: Function; evaluate: Function } } })
      .client
    // use collect + evaluate via session.navigate already done; use collect for hw
    const snap = await session.collect()
    console.log('collect', {
      ua: snap.userAgent,
      hw: snap.hardwareConcurrency,
      mem: snap.deviceMemory,
      lang: snap.language,
      platform: snap.platform
    })

    // 需要 Runtime 读页面文案 — collect 已 enable；再 evaluate
    // 通过 session 没有公开 evaluate，临时用 collect 的连接：再 collect 不行
    // 打开第二连接会踢掉 session。把文案采样放进 FingerprintSession 太重。
    // 用 Runtime from private — 改为在 FingerprintSession 加 evaluateRaw

    const checks = [
      ['ua', snap.userAgent === profile.userAgent],
      ['hw', snap.hardwareConcurrency === profile.hardwareConcurrency],
      ['mem', snap.deviceMemory === profile.deviceMemory],
      ['lang', snap.language === profile.languages[0]],
      ['platform', snap.platform === profile.platform]
    ]
    let fail = 0
    for (const [n, ok] of checks) {
      console.log(`${ok ? 'OK' : 'DIFF'} ${n}`)
      if (!ok) fail++
    }

    // 页面真实度：用 navigate 后的 evaluate — 给 session 加方法
    const text = await session.evaluate<{
      score: string | null
      robot: string | null
      webdriver: unknown
      snippet: string
    }>(`(() => {
      const t = document.body ? document.body.innerText : '';
      const score = (t.match(/真实度[:：]\\s*(\\d+%)/) || [])[1] || null;
      const robot = (t.match(/机器人检测[:：]\\s*([^\\n]+)/) || [])[1] || null;
      return {
        score,
        robot: robot ? robot.trim().slice(0, 20) : null,
        webdriver: navigator.webdriver,
        snippet: t.replace(/\\s+/g, ' ').slice(0, 400)
      };
    })()`)
    console.log('browserscan', text)
    if (fail) process.exitCode = 2
  } finally {
    await session.stop()
    try {
      child.kill()
    } catch {
      /* ignore */
    }
    spawn('taskkill', ['/F', '/T', '/PID', String(child.pid)], { stdio: 'ignore' })
    await sleep(400)
    rmSync(userData, { recursive: true, force: true })
  }
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
