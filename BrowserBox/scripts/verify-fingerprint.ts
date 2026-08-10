/**
 * 本地验证：随机指纹档案 vs CDP 注入后页面采集是否一致
 * 用法：npx --yes tsx scripts/verify-fingerprint.ts
 */
import { spawn } from 'child_process'
import { mkdtempSync, rmSync, existsSync, readdirSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { generateFingerprintProfile } from '../src/main/fingerprint/generateProfile'
import { alignFingerprintToChromeVersion } from '../src/main/fingerprint/uaMeta'
import { applySessionOverrides, collectFingerprint, findFreePort } from '../src/main/cdp/CdpClient'

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

async function main(): Promise<void> {
  if (!existsSync(CHROME)) {
    console.error('未找到 Chrome:', CHROME)
    process.exit(1)
  }

  let profile = generateFingerprintProfile()
  const ver = readChromeVersion(CHROME)
  if (ver) profile = alignFingerprintToChromeVersion(profile, ver)

  const port = await findFreePort()
  const userData = mkdtempSync(join(tmpdir(), 'bb-fp-'))
  const args = [
    `--user-data-dir=${userData}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-extensions',
    '--disable-popup-blocking',
    `--remote-debugging-port=${port}`,
    '--remote-allow-origins=*',
    `--user-agent=${profile.userAgent}`,
    `--window-size=${Math.min(1280, profile.screen.width)},${Math.min(800, profile.screen.height)}`,
    'about:blank'
  ]

  console.log('Chrome version:', ver || '(unknown)')
  console.log('Debug port:', port)
  console.log('Profile UA:', profile.userAgent)
  console.log('Profile HW:', profile.hardwareConcurrency, 'mem', profile.deviceMemory)
  console.log('Profile screen:', profile.screen)
  console.log('Profile WebGL:', profile.webglVendor, '/', profile.webglRenderer)

  const child = spawn(CHROME, args, { stdio: 'ignore', detached: false })

  try {
    await sleep(1500)
    await applySessionOverrides({
      port,
      fingerprint: profile,
      acceptLanguage: profile.languages.join(','),
      injectLanguages: profile.languages
    })
    // reload 后稍等再采
    await sleep(1200)
    const snap = await collectFingerprint(port)

    type Row = { field: string; expected: string; actual: string; ok: boolean }
    const rows: Row[] = []
    const add = (field: string, expected: string | number | null | undefined, actual: string | number | null | undefined) => {
      const e = expected == null ? '' : String(expected)
      const a = actual == null ? '' : String(actual)
      rows.push({ field, expected: e, actual: a, ok: e === a })
    }

    add('userAgent', profile.userAgent, snap.userAgent)
    add('platform', profile.platform, snap.platform)
    add('hardwareConcurrency', profile.hardwareConcurrency, snap.hardwareConcurrency)
    add('deviceMemory', profile.deviceMemory, snap.deviceMemory)
    add('screen.width', profile.screen.width, snap.screen.width)
    add('screen.height', profile.screen.height, snap.screen.height)
    add('screen.colorDepth', profile.screen.colorDepth, snap.screen.colorDepth)
    add('screen.pixelRatio', profile.screen.pixelRatio, snap.screen.pixelRatio)
    add('webglVendor', profile.webglVendor, snap.webglVendor)
    add('webglRenderer', profile.webglRenderer, snap.webglRenderer)
    add('language', profile.languages[0], snap.language)
    add('languages', profile.languages.join(','), (snap.languages || []).join(','))

    console.log('\n=== 档案 vs 采集 ===')
    for (const r of rows) {
      console.log(`${r.ok ? 'OK ' : 'DIFF'} ${r.field}`)
      if (!r.ok) {
        console.log(`     expected: ${r.expected}`)
        console.log(`     actual:   ${r.actual}`)
      }
    }
    console.log('canvasHash (采集, 仅观察):', snap.canvasHash)

    const failed = rows.filter((r) => !r.ok)
    console.log(`\n结果: ${rows.length - failed.length}/${rows.length} 一致`)
    if (failed.length) {
      console.error('不一致字段:', failed.map((f) => f.field).join(', '))
      process.exitCode = 2
    } else {
      console.log('全部关键字段一致')
    }
  } finally {
    try {
      child.kill()
    } catch {
      /* ignore */
    }
    // 再杀一次残留
    try {
      spawn('taskkill', ['/F', '/T', '/PID', String(child.pid)], { stdio: 'ignore' })
    } catch {
      /* ignore */
    }
    await sleep(500)
    try {
      rmSync(userData, { recursive: true, force: true })
    } catch {
      /* ignore */
    }
  }
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
