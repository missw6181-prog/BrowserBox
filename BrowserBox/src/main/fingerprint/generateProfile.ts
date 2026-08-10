import { createHash, randomUUID } from 'crypto'
import type { FingerprintProfile } from '../../shared/types'

const CHROME_MAJORS = [120, 121, 122, 124, 125, 126, 128, 130, 131, 133, 135, 136, 138, 140]
const HW_CONCURRENCY = [2, 4, 6, 8, 12, 16]
const DEVICE_MEMORY = [2, 4, 8]
const SCREENS: Array<{ width: number; height: number; colorDepth: number; pixelRatio: number }> = [
  { width: 1920, height: 1080, colorDepth: 24, pixelRatio: 1 },
  { width: 2560, height: 1440, colorDepth: 24, pixelRatio: 1 },
  { width: 1366, height: 768, colorDepth: 24, pixelRatio: 1 },
  { width: 1536, height: 864, colorDepth: 24, pixelRatio: 1.25 },
  { width: 1440, height: 900, colorDepth: 24, pixelRatio: 1 },
  { width: 1680, height: 1050, colorDepth: 24, pixelRatio: 1 },
  { width: 1280, height: 720, colorDepth: 24, pixelRatio: 1 },
  { width: 1920, height: 1200, colorDepth: 24, pixelRatio: 1 }
]

const WEBGL_POOL: Array<{ vendor: string; renderer: string }> = [
  {
    vendor: 'Google Inc. (NVIDIA)',
    renderer: 'ANGLE (NVIDIA, NVIDIA GeForce GTX 1650 Direct3D11 vs_5_0 ps_5_0, D3D11)'
  },
  {
    vendor: 'Google Inc. (NVIDIA)',
    renderer: 'ANGLE (NVIDIA, NVIDIA GeForce RTX 3060 Direct3D11 vs_5_0 ps_5_0, D3D11)'
  },
  {
    vendor: 'Google Inc. (AMD)',
    renderer: 'ANGLE (AMD, AMD Radeon RX 580 Series Direct3D11 vs_5_0 ps_5_0, D3D11)'
  },
  {
    vendor: 'Google Inc. (Intel)',
    renderer: 'ANGLE (Intel, Intel(R) UHD Graphics 620 Direct3D11 vs_5_0 ps_5_0, D3D11)'
  },
  {
    vendor: 'Google Inc. (Intel)',
    renderer: 'ANGLE (Intel, Intel(R) Iris(R) Xe Graphics Direct3D11 vs_5_0 ps_5_0, D3D11)'
  }
]

const LANGUAGE_POOL: string[][] = [
  ['en-US', 'en'],
  ['zh-CN', 'zh', 'en-US', 'en'],
  ['en-GB', 'en'],
  ['ja-JP', 'ja', 'en-US', 'en'],
  ['ko-KR', 'ko', 'en-US', 'en'],
  ['de-DE', 'de', 'en-US', 'en']
]

/** 由 seed 派生稳定伪随机整数序列 */
function makeRng(seed: string): () => number {
  let h = createHash('sha256').update(seed).digest()
  let i = 0
  return () => {
    if (i + 4 > h.length) {
      h = createHash('sha256').update(h).digest()
      i = 0
    }
    const n = h.readUInt32BE(i)
    i += 4
    return n / 0x100000000
  }
}

function pick<T>(rng: () => number, list: T[]): T {
  return list[Math.floor(rng() * list.length) % list.length]
}

function buildUserAgent(rng: () => number): string {
  const major = pick(rng, CHROME_MAJORS)
  const build = 5000 + Math.floor(rng() * 2000)
  const patch = Math.floor(rng() * 200)
  return `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${major}.0.${build}.${patch} Safari/537.36`
}

export function generateFingerprintProfile(seed?: string): FingerprintProfile {
  const s = seed || randomUUID()
  const rng = makeRng(s)
  const screen = pick(rng, SCREENS)
  const webgl = pick(rng, WEBGL_POOL)
  const languages = pick(rng, LANGUAGE_POOL)
  return {
    seed: s,
    generatedAt: new Date().toISOString(),
    userAgent: buildUserAgent(rng),
    platform: 'Win32',
    languages: [...languages],
    hardwareConcurrency: pick(rng, HW_CONCURRENCY),
    deviceMemory: pick(rng, DEVICE_MEMORY),
    screen: { ...screen },
    canvasNoise: 0.00005 + rng() * 0.0002,
    webglVendor: webgl.vendor,
    webglRenderer: webgl.renderer,
    audioNoise: 0.00001 + rng() * 0.00005
  }
}

export function isValidFingerprintProfile(v: unknown): v is FingerprintProfile {
  if (!v || typeof v !== 'object') return false
  const p = v as FingerprintProfile
  return (
    typeof p.seed === 'string' &&
    typeof p.userAgent === 'string' &&
    typeof p.platform === 'string' &&
    Array.isArray(p.languages) &&
    typeof p.hardwareConcurrency === 'number' &&
    typeof p.deviceMemory === 'number' &&
    !!p.screen &&
    typeof p.canvasNoise === 'number' &&
    typeof p.webglVendor === 'string' &&
    typeof p.webglRenderer === 'string' &&
    typeof p.audioNoise === 'number'
  )
}
