import { spawn } from 'child_process'
import { mkdtempSync, rmSync, existsSync, readdirSync, readFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { generateFingerprintProfile } from '../src/main/fingerprint/generateProfile'
import { writeFingerprintExtension } from '../src/main/fingerprint/buildExtension'
import { connectCdp, findFreePort } from '../src/main/cdp/CdpClient'

const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

async function main(): Promise<void> {
  const profile = generateFingerprintProfile()
  const port = await findFreePort()
  const userData = mkdtempSync(join(tmpdir(), 'bb-ext2-'))
  const extDir = join(userData, 'ext')
  writeFingerprintExtension(extDir, profile)
  console.log('extDir', extDir)
  console.log('manifest', readFileSync(join(extDir, 'manifest.json'), 'utf8'))

  const child = spawn(
    CHROME,
    [
      `--user-data-dir=${userData}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--enable-extensions',
      '--disable-blink-features=AutomationControlled',
      '--disable-features=DisableLoadExtensionCommandLineSwitch',
      `--remote-debugging-port=${port}`,
      '--remote-allow-origins=*',
      `--load-extension=${extDir}`,
      'about:blank'
    ],
    { stdio: 'ignore' }
  )

  try {
    await sleep(4000)
    const client = await connectCdp(port)
    try {
      await client.Page.enable()
      await client.Page.navigate({ url: 'https://example.com/' })
      await sleep(2000)
      const r1 = await client.Runtime.evaluate({
        expression: `({
          hw: navigator.hardwareConcurrency,
          expected: ${profile.hardwareConcurrency},
          webdriver: navigator.webdriver,
          extMarker: !!document.documentElement?.dataset?.bbFp
        })`,
        returnByValue: true
      })
      console.log('example.com', r1.result?.value)

      await client.Page.navigate({ url: 'chrome://extensions-internals/' })
      await sleep(1500)
      const r2 = await client.Runtime.evaluate({
        expression: `document.body ? document.body.innerText.slice(0, 2000) : 'no body'`,
        returnByValue: true
      })
      console.log('extensions-internals snippet:\n', r2.result?.value)
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
