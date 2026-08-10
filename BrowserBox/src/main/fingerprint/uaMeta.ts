import type { FingerprintProfile } from '../../shared/types'

/** 从 UA 解析 Chrome 完整版本，如 131.0.6778.86 */
export function parseChromeVersionFromUa(ua: string): string | null {
  const m = ua.match(/Chrome\/(\d+\.\d+\.\d+\.\d+)/i) || ua.match(/Chrome\/(\d+\.\d+\.\d+)/i)
  return m ? m[1] : null
}

/** 用真实浏览器版本改写 UA 中的 Chrome 版本，避免 Client Hints / UA 版本对不上 */
export function alignUserAgentToChromeVersion(ua: string, chromeVersion: string): string {
  const ver = chromeVersion.trim()
  if (!ver || !/^\d+(\.\d+){0,3}$/.test(ver)) return ua
  const parts = ver.split('.')
  while (parts.length < 4) parts.push('0')
  const full = parts.slice(0, 4).join('.')
  if (/Chrome\/\d+(\.\d+){0,3}/i.test(ua)) {
    return ua.replace(/Chrome\/\d+(\.\d+){0,3}/i, `Chrome/${full}`)
  }
  return ua
}

export function alignFingerprintToChromeVersion(
  profile: FingerprintProfile,
  chromeVersion: string
): FingerprintProfile {
  return {
    ...profile,
    userAgent: alignUserAgentToChromeVersion(profile.userAgent, chromeVersion)
  }
}

/** CDP Emulation.setUserAgentOverride 的 userAgentMetadata */
export function buildUserAgentMetadata(ua: string): {
  brands: Array<{ brand: string; version: string }>
  fullVersionList: Array<{ brand: string; version: string }>
  platform: string
  platformVersion: string
  architecture: string
  model: string
  mobile: boolean
  bitness: string
  wow64: boolean
} {
  const full = parseChromeVersionFromUa(ua) || '120.0.0.0'
  const major = full.split('.')[0]
  const brands = [
    { brand: 'Not)A;Brand', version: '99' },
    { brand: 'Google Chrome', version: major },
    { brand: 'Chromium', version: major }
  ]
  const fullVersionList = [
    { brand: 'Not)A;Brand', version: '10.0.0.0' },
    { brand: 'Google Chrome', version: full },
    { brand: 'Chromium', version: full }
  ]
  return {
    brands,
    fullVersionList,
    platform: 'Windows',
    platformVersion: '15.0.0',
    architecture: 'x86',
    model: '',
    mobile: false,
    bitness: '64',
    wow64: false
  }
}
