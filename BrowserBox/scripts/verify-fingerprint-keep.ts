/**
 * 验证保持 CDP 连接时：导航后页面采集 vs 档案
 */
import { spawn } from 'child_process'
import { mkdtempSync, rmSync, existsSync, readdirSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { generateFingerprintProfile } from '../src/main/fingerprint/generateProfile'
import { alignFingerprintToChromeVersion } from '../src/main/fingerprint/uaMeta'
import { FingerprintSession } from '../src/main/fingerprint/FingerprintSession'
import { findFreePort } from '../src/main/cdp/CdpClient'
import type { FingerprintProfile, FingerprintSnapshot } from '../src/shared/types'

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

function compare(profile: FingerprintProfile, snap: FingerprintSnapshot, label: string): number {
  console.log(`\n=== ${label} ===`)
  const checks: Array<[string, unknown, unknown]> = [
    ['userAgent', profile.userAgent, snap.userAgent],
    ['platform', profile.platform, snap.platform],
    ['hardwareConcurrency', profile.hardwareConcurrency, snap.hardwareConcurrency],
    ['deviceMemory', profile.deviceMemory, snap.deviceMemory],
    ['screen.width', profile.screen.width, snap.screen.width],
    ['screen.height', profile.screen.height, snap.screen.height],
    ['webglVendor', profile.webglVendor, snap.webglVendor],
    ['webglRenderer', profile.webglRenderer, snap.webglRenderer],
    ['language', profile.languages[0], snap.language]
  ]
  let fail = 0
  for (const [k, e, a] of checks) {
    const ok = String(e) === String(a)
    if (!ok) fail++
    console.log(`${ok ? 'OK ' : 'DIFF'} ${k}`)
    if (!ok) {
      console.log(`  expected: ${e}`)
      console.log(`  actual:   ${a}`)
    }
  }
  console.log(fail ? `FAIL ${fail}` : 'PASS')
  return fail
}

async function main(): Promise<void> {
  if (!existsSync(CHROME)) {
    console.error('未找到 Chrome')
    process.exit(1)
  }

  let profile = generateFingerprintProfile()
  const ver = readChromeVersion(CHROME)
  if (ver) profile = alignFingerprintToChromeVersion(profile, ver)
  console.log('profile', {
    ua: profile.userAgent,
    hw: profile.hardwareConcurrency,
    mem: profile.deviceMemory,
    screen: profile.screen,
    webgl: profile.webglRenderer,
    lang: profile.languages[0]
  })

  const port = await findFreePort()
  const userData = mkdtempSync(join(tmpdir(), 'bb-fp-keep-'))
  const htmlPath = join(userData, 'detect.html')
  writeFileSync(htmlPath, '<!doctype html><title>fp</title><h1>detect</h1>', 'utf8')
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
      'about:blank'
    ],
    { stdio: 'ignore' }
  )

  const session = new FingerprintSession(port, profile, {
    acceptLanguage: profile.languages.join(','),
    injectLanguages: profile.languages
  })

  try {
    await sleep(1800)
    await session.start()
    await sleep(1000)

    const snap1 = await session.collect()
    let fail = compare(profile, snap1, '保持连接 · 当前页')

    await session.navigate(fileUrl)
    await sleep(800)
    const snap2 = await session.collect()
    fail += compare(profile, snap2, '保持连接 · 导航后（模拟网站）')

    if (fail) {
      console.error(`\n总计 ${fail} 项不一致`)
      process.exitCode = 2
    } else {
      console.log('\n全部一致：保持 CDP 后导航采集与档案匹配')
    }
  } finally {
    await session.stop()
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
