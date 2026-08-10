import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import { logger } from '../logger/Logger'

function deepMerge(target: Record<string, unknown>, patch: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...target }
  for (const [k, v] of Object.entries(patch)) {
    if (
      v &&
      typeof v === 'object' &&
      !Array.isArray(v) &&
      out[k] &&
      typeof out[k] === 'object' &&
      !Array.isArray(out[k])
    ) {
      out[k] = deepMerge(out[k] as Record<string, unknown>, v as Record<string, unknown>)
    } else {
      out[k] = v
    }
  }
  return out
}

/**
 * 合并写入 Profile/Default/Preferences（Chrome 未启动时安全）。
 * 主要用于 intl.accept_languages。
 */
export function mergeProfilePreferences(
  profileAbs: string,
  patch: Record<string, unknown>
): void {
  const defaultDir = join(profileAbs, 'Default')
  mkdirSync(defaultDir, { recursive: true })
  const prefPath = join(defaultDir, 'Preferences')
  let current: Record<string, unknown> = {}
  if (existsSync(prefPath)) {
    try {
      current = JSON.parse(readFileSync(prefPath, 'utf8')) as Record<string, unknown>
    } catch (err) {
      logger.warn('environment', 'Preferences 解析失败，将覆盖写入 intl 段', { err: String(err) })
      current = {}
    }
  }
  const merged = deepMerge(current, patch)
  writeFileSync(prefPath, JSON.stringify(merged), 'utf8')
}

export function applyAcceptLanguages(profileAbs: string, acceptLanguages: string): void {
  mergeProfilePreferences(profileAbs, {
    intl: {
      accept_languages: acceptLanguages
    }
  })
}
