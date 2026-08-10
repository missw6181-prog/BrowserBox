/**
 * 代理国家码 → 浏览器语言 / Accept-Language / 时区 / locale
 * 未知国家返回 null（不覆盖系统设置）
 */

export interface RegionLocale {
  country: string
  lang: string
  acceptLanguages: string
  timezone: string
  locale: string
}

const ALIAS: Record<string, string> = {
  UK: 'GB',
  EN: 'GB',
  USA: 'US',
  KOR: 'KR',
  CHN: 'CN',
  JPN: 'JP',
  RUS: 'RU',
  GER: 'DE',
  FRA: 'FR'
}

/** 与渲染层 country 规范化对齐的主进程版本 */
export function normalizeCountryCode(raw?: string | null): string {
  if (!raw) return ''
  const t = raw.trim()
  if (!t) return ''
  const upper = t.toUpperCase()
  if (ALIAS[upper]) return ALIAS[upper]
  if (/^[A-Z]{2}$/.test(upper)) return upper
  const m = upper.match(/^([A-Z]{2})\b/)
  if (m) return ALIAS[m[1]] || m[1]
  return ''
}

/** 常见国家默认映射（单一主时区；大国取代表性时区） */
const REGION_MAP: Record<string, Omit<RegionLocale, 'country'>> = {
  US: { lang: 'en-US', acceptLanguages: 'en-US,en', timezone: 'America/New_York', locale: 'en-US' },
  CA: { lang: 'en-CA', acceptLanguages: 'en-CA,en-US,en', timezone: 'America/Toronto', locale: 'en-CA' },
  GB: { lang: 'en-GB', acceptLanguages: 'en-GB,en', timezone: 'Europe/London', locale: 'en-GB' },
  IE: { lang: 'en-IE', acceptLanguages: 'en-IE,en-GB,en', timezone: 'Europe/Dublin', locale: 'en-IE' },
  AU: { lang: 'en-AU', acceptLanguages: 'en-AU,en', timezone: 'Australia/Sydney', locale: 'en-AU' },
  NZ: { lang: 'en-NZ', acceptLanguages: 'en-NZ,en', timezone: 'Pacific/Auckland', locale: 'en-NZ' },
  CN: { lang: 'zh-CN', acceptLanguages: 'zh-CN,zh,en-US,en', timezone: 'Asia/Shanghai', locale: 'zh-CN' },
  TW: { lang: 'zh-TW', acceptLanguages: 'zh-TW,zh,en-US,en', timezone: 'Asia/Taipei', locale: 'zh-TW' },
  HK: { lang: 'zh-HK', acceptLanguages: 'zh-HK,zh-TW,zh,en', timezone: 'Asia/Hong_Kong', locale: 'zh-HK' },
  MO: { lang: 'zh-MO', acceptLanguages: 'zh-MO,zh-TW,zh,en', timezone: 'Asia/Macau', locale: 'zh-MO' },
  JP: { lang: 'ja', acceptLanguages: 'ja,en-US,en', timezone: 'Asia/Tokyo', locale: 'ja-JP' },
  KR: { lang: 'ko', acceptLanguages: 'ko,en-US,en', timezone: 'Asia/Seoul', locale: 'ko-KR' },
  DE: { lang: 'de', acceptLanguages: 'de-DE,de,en-US,en', timezone: 'Europe/Berlin', locale: 'de-DE' },
  FR: { lang: 'fr', acceptLanguages: 'fr-FR,fr,en-US,en', timezone: 'Europe/Paris', locale: 'fr-FR' },
  IT: { lang: 'it', acceptLanguages: 'it-IT,it,en-US,en', timezone: 'Europe/Rome', locale: 'it-IT' },
  ES: { lang: 'es', acceptLanguages: 'es-ES,es,en-US,en', timezone: 'Europe/Madrid', locale: 'es-ES' },
  PT: { lang: 'pt-PT', acceptLanguages: 'pt-PT,pt,en-US,en', timezone: 'Europe/Lisbon', locale: 'pt-PT' },
  NL: { lang: 'nl', acceptLanguages: 'nl-NL,nl,en-US,en', timezone: 'Europe/Amsterdam', locale: 'nl-NL' },
  BE: { lang: 'nl-BE', acceptLanguages: 'nl-BE,fr-BE,nl,fr,en', timezone: 'Europe/Brussels', locale: 'nl-BE' },
  CH: { lang: 'de-CH', acceptLanguages: 'de-CH,fr-CH,it-CH,de,fr,en', timezone: 'Europe/Zurich', locale: 'de-CH' },
  AT: { lang: 'de-AT', acceptLanguages: 'de-AT,de,en-US,en', timezone: 'Europe/Vienna', locale: 'de-AT' },
  SE: { lang: 'sv', acceptLanguages: 'sv-SE,sv,en-US,en', timezone: 'Europe/Stockholm', locale: 'sv-SE' },
  NO: { lang: 'nb', acceptLanguages: 'nb-NO,nb,en-US,en', timezone: 'Europe/Oslo', locale: 'nb-NO' },
  DK: { lang: 'da', acceptLanguages: 'da-DK,da,en-US,en', timezone: 'Europe/Copenhagen', locale: 'da-DK' },
  FI: { lang: 'fi', acceptLanguages: 'fi-FI,fi,en-US,en', timezone: 'Europe/Helsinki', locale: 'fi-FI' },
  PL: { lang: 'pl', acceptLanguages: 'pl-PL,pl,en-US,en', timezone: 'Europe/Warsaw', locale: 'pl-PL' },
  CZ: { lang: 'cs', acceptLanguages: 'cs-CZ,cs,en-US,en', timezone: 'Europe/Prague', locale: 'cs-CZ' },
  RU: { lang: 'ru', acceptLanguages: 'ru-RU,ru,en-US,en', timezone: 'Europe/Moscow', locale: 'ru-RU' },
  UA: { lang: 'uk', acceptLanguages: 'uk-UA,uk,ru,en-US,en', timezone: 'Europe/Kyiv', locale: 'uk-UA' },
  TR: { lang: 'tr', acceptLanguages: 'tr-TR,tr,en-US,en', timezone: 'Europe/Istanbul', locale: 'tr-TR' },
  SA: { lang: 'ar', acceptLanguages: 'ar-SA,ar,en-US,en', timezone: 'Asia/Riyadh', locale: 'ar-SA' },
  AE: { lang: 'ar', acceptLanguages: 'ar-AE,ar,en-US,en', timezone: 'Asia/Dubai', locale: 'ar-AE' },
  IL: { lang: 'he', acceptLanguages: 'he-IL,he,en-US,en', timezone: 'Asia/Jerusalem', locale: 'he-IL' },
  IN: { lang: 'en-IN', acceptLanguages: 'en-IN,hi,en', timezone: 'Asia/Kolkata', locale: 'en-IN' },
  SG: { lang: 'en-SG', acceptLanguages: 'en-SG,zh-CN,en', timezone: 'Asia/Singapore', locale: 'en-SG' },
  MY: { lang: 'ms', acceptLanguages: 'ms-MY,en-US,en', timezone: 'Asia/Kuala_Lumpur', locale: 'ms-MY' },
  TH: { lang: 'th', acceptLanguages: 'th-TH,th,en-US,en', timezone: 'Asia/Bangkok', locale: 'th-TH' },
  VN: { lang: 'vi', acceptLanguages: 'vi-VN,vi,en-US,en', timezone: 'Asia/Ho_Chi_Minh', locale: 'vi-VN' },
  ID: { lang: 'id', acceptLanguages: 'id-ID,id,en-US,en', timezone: 'Asia/Jakarta', locale: 'id-ID' },
  PH: { lang: 'en-PH', acceptLanguages: 'en-PH,fil,en', timezone: 'Asia/Manila', locale: 'en-PH' },
  MX: { lang: 'es-MX', acceptLanguages: 'es-MX,es,en-US,en', timezone: 'America/Mexico_City', locale: 'es-MX' },
  BR: { lang: 'pt-BR', acceptLanguages: 'pt-BR,pt,en-US,en', timezone: 'America/Sao_Paulo', locale: 'pt-BR' },
  AR: { lang: 'es-AR', acceptLanguages: 'es-AR,es,en-US,en', timezone: 'America/Argentina/Buenos_Aires', locale: 'es-AR' },
  CL: { lang: 'es-CL', acceptLanguages: 'es-CL,es,en-US,en', timezone: 'America/Santiago', locale: 'es-CL' },
  ZA: { lang: 'en-ZA', acceptLanguages: 'en-ZA,en', timezone: 'Africa/Johannesburg', locale: 'en-ZA' },
  EG: { lang: 'ar', acceptLanguages: 'ar-EG,ar,en-US,en', timezone: 'Africa/Cairo', locale: 'ar-EG' },
  NG: { lang: 'en-NG', acceptLanguages: 'en-NG,en', timezone: 'Africa/Lagos', locale: 'en-NG' }
}

export function countryToLocale(rawCountry?: string | null): RegionLocale | null {
  const country = normalizeCountryCode(rawCountry)
  if (!country) return null
  const hit = REGION_MAP[country]
  if (!hit) return null
  return { country, ...hit }
}
