import { createHash, generateKeyPairSync } from 'crypto'
import { existsSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'fs'
import { join } from 'path'
import type { FingerprintProfile } from '../../shared/types'
import { buildFingerprintInjectScript } from './injectScript'

/** 稳定扩展 ID：由固定 seed 派生 RSA 公钥写入 manifest.key */
function buildStableExtensionKey(): { key: string; extensionId: string } {
  // 固定种子，保证各环境可用同一算法生成不同 key——这里用随机每次生成，ID 随 path+key
  const { publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 })
  const spki = publicKey.export({ type: 'spki', format: 'der' }) as Buffer
  const key = spki.toString('base64')
  // Chrome extension id = first 16 bytes of SHA256(publicKey DER) mapped to a-p
  const hash = createHash('sha256').update(spki).digest()
  let id = ''
  for (let i = 0; i < 16; i++) {
    id += String.fromCharCode(97 + (hash[i] >> 4))
    id += String.fromCharCode(97 + (hash[i] & 0xf))
  }
  // above encoding is wrong - correct is nibble to a-p:
  id = ''
  for (let i = 0; i < 16; i++) {
    const b = hash[i]
    id += String.fromCharCode(97 + ((b >> 4) & 0xf))
    id += String.fromCharCode(97 + (b & 0xf))
  }
  return { key, extensionId: id.slice(0, 32) }
}

/**
 * 写入解压扩展，并尝试预写 Profile Preferences（不依赖 --load-extension，
 * Chrome 137+ 常禁用该命令行开关）。
 */
export function writeFingerprintExtension(
  extDir: string,
  profile: FingerprintProfile,
  opts?: { languages?: string[] }
): { extDir: string; extensionId: string } {
  if (existsSync(extDir)) {
    rmSync(extDir, { recursive: true, force: true })
  }
  mkdirSync(extDir, { recursive: true })

  const { key, extensionId } = buildStableExtensionKey()
  const pageScript = buildFingerprintInjectScript(profile, {
    languages: opts?.languages,
    stealth: true
  })

  const manifest = {
    manifest_version: 3,
    name: 'BrowserBox Fingerprint',
    version: '1.0.0',
    description: 'Profile inject',
    key,
    permissions: ['scripting'],
    host_permissions: ['<all_urls>'],
    background: { service_worker: 'bg.js' },
    content_scripts: [
      {
        matches: ['http://*/*', 'https://*/*'],
        js: ['page.js'],
        run_at: 'document_start',
        all_frames: true,
        match_about_blank: true,
        world: 'MAIN'
      }
    ]
  }

  const bg = `
async function register() {
  try {
    const cur = await chrome.scripting.getRegisteredContentScripts();
    if (cur.some((s) => s.id === 'bb-fp')) {
      await chrome.scripting.unregisterContentScripts({ ids: ['bb-fp'] });
    }
    await chrome.scripting.registerContentScripts([{
      id: 'bb-fp',
      matches: ['http://*/*', 'https://*/*'],
      js: ['page.js'],
      runAt: 'document_start',
      allFrames: true,
      matchAboutBlank: true,
      world: 'MAIN'
    }]);
  } catch (e) {}
}
chrome.runtime.onInstalled.addListener(register);
chrome.runtime.onStartup.addListener(register);
register();
`

  writeFileSync(join(extDir, 'manifest.json'), JSON.stringify(manifest, null, 2), 'utf8')
  writeFileSync(join(extDir, 'page.js'), pageScript, 'utf8')
  writeFileSync(join(extDir, 'bg.js'), bg, 'utf8')
  return { extDir, extensionId }
}

/** 在 user-data-dir 的 Preferences 里登记解压扩展（启动前写入） */
export function seedExtensionPreferences(
  profileDir: string,
  extDir: string,
  extensionId: string
): void {
  mkdirSync(join(profileDir, 'Default'), { recursive: true })
  const prefPath = join(profileDir, 'Default', 'Preferences')
  let pref: Record<string, unknown> = {}
  if (existsSync(prefPath)) {
    try {
      pref = JSON.parse(readFileSync(prefPath, 'utf8')) as Record<string, unknown>
    } catch {
      pref = {}
    }
  }

  let manifest: Record<string, unknown> = {}
  try {
    manifest = JSON.parse(readFileSync(join(extDir, 'manifest.json'), 'utf8')) as Record<
      string,
      unknown
    >
  } catch {
    /* ignore */
  }

  const extensions = (pref.extensions as Record<string, unknown>) || {}
  const settings = (extensions.settings as Record<string, unknown>) || {}
  const ui = (extensions.ui as Record<string, unknown>) || {}
  ui.developer_mode = true

  const absExt = extDir.replace(/\//g, '\\')
  settings[extensionId] = {
    active_permissions: {
      api: ['scripting'],
      explicit_host: ['*://*/*'],
      manifest_permissions: [],
      scriptable_host: ['*://*/*']
    },
    granted_permissions: {
      api: ['scripting'],
      explicit_host: ['*://*/*'],
      manifest_permissions: [],
      scriptable_host: ['*://*/*']
    },
    commands: {},
    content_settings: [],
    creation_flags: 1,
    from_webstore: false,
    install_time: String(Date.now() * 1000),
    location: 4,
    newAllowFileAccess: true,
    path: absExt,
    state: 1,
    was_installed_by_default: false,
    was_installed_by_oem: false,
    manifest
  }

  extensions.settings = settings
  extensions.ui = ui
  pref.extensions = extensions

  writeFileSync(prefPath, JSON.stringify(pref), 'utf8')
}
