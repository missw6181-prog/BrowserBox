import { spawn } from 'child_process'
import { mkdtempSync, rmSync, existsSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { generateFingerprintProfile } from '../src/main/fingerprint/generateProfile'
import {
  writeFingerprintExtension,
  seedExtensionPreferences
} from '../src/main/fingerprint/buildExtension'
import { applySessionOverrides, connectCdp, findFreePort } from '../src/main/cdp/CdpClient'

const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

async function main(): Promise<void> {
  const profile = generateFingerprintProfile()
  const port = await findFreePort()
  const userData = mkdtempSync(join(tmpdir(), 'bb-pref-'))
  const extDir = join(userData, 'ext')
  const { extensionId } = writeFingerprintExtension(extDir, profile)
  seedExtensionPreferences(userData, extDir, extensionId)
  console.log('extensionId', extensionId, 'hw', profile.hardwareConcurrency)

  // 不带 --load-extension，也不常驻 CDP 注入
  const child = spawn(
    CHROME,
    [
      `--user-data-dir=${userData}`,
      '--no-first-run',
      '--disable-blink-features=AutomationControlled',
      '--disable-features=DisableLoadExtensionCommandLineSwitch',
      `--load-extension=${extDir}`,
      `--remote-debugging-port=${port}`,
      '--remote-allow-origins=*',
      `--user-agent=${profile.userAgent}`,
      'about:blank'
    ],
    { stdio: 'ignore' }
  )

  try {
    await sleep(3500)
    await applySessionOverrides({
      port,
      fingerprint: profile,
      skipScriptInject: true
    })
    // disconnect already in applySessionOverrides

    const client = await connectCdp(port)
    try {
      await client.Page.navigate({ url: 'https://example.com/' })
      await sleep(2000)
      const r = await client.Runtime.evaluate({
        expression: `({hw: navigator.hardwareConcurrency, expect: ${profile.hardwareConcurrency}, wd: navigator.webdriver})`,
        returnByValue: true
      })
      console.log('result', r.result?.value)

      await client.Page.navigate({ url: 'https://www.browserscan.net/zh' })
      await sleep(9000)
      const r2 = await client.Runtime.evaluate({
        expression: `(() => {
          const t = document.body ? document.body.innerText : '';
          return {
            hw: navigator.hardwareConcurrency,
            score: (t.match(/真实度[:：]\\s*(\\d+%)/)||[])[1],
            robot: (t.match(/机器人检测[:：]\\s*([^\\n]+)/)||[])[1],
            snippet: t.replace(/\\s+/g,' ').slice(0,350)
          };
        })()`,
        returnByValue: true
      })
      console.log('browserscan', r2.result?.value)
    } finally {
      await client.close().catch(() => undefined)
    }
  } finally {
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
