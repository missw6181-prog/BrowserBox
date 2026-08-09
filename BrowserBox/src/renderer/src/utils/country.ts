/** ISO 3166-1 alpha-2 helpers for flag-icons */

const ALIAS: Record<string, string> = {
  UK: 'gb',
  EN: 'gb',
  USA: 'us',
  KOR: 'kr',
  CHN: 'cn',
  JPN: 'jp',
  RUS: 'ru',
  GER: 'de',
  FRA: 'fr'
}

export function normalizeCountryCode(raw?: string | null): string {
  if (!raw) return ''
  const t = raw.trim()
  if (!t) return ''
  const upper = t.toUpperCase()
  if (ALIAS[upper]) return ALIAS[upper]
  // already alpha-2
  if (/^[A-Z]{2}$/.test(upper)) return upper.toLowerCase()
  // sometimes "KR / Korea"
  const m = upper.match(/^([A-Z]{2})\b/)
  if (m) {
    const c = m[1]
    return (ALIAS[c] || c).toLowerCase()
  }
  return ''
}

export const COUNTRY_NAME_ZH: Record<string, string> = {
  us: '美国',
  cn: '中国',
  tw: '台湾',
  hk: '香港',
  mo: '澳门',
  jp: '日本',
  kr: '韩国',
  kp: '朝鲜',
  gb: '英国',
  ie: '爱尔兰',
  de: '德国',
  fr: '法国',
  it: '意大利',
  es: '西班牙',
  pt: '葡萄牙',
  nl: '荷兰',
  be: '比利时',
  ch: '瑞士',
  at: '奥地利',
  se: '瑞典',
  no: '挪威',
  dk: '丹麦',
  fi: '芬兰',
  pl: '波兰',
  cz: '捷克',
  ru: '俄罗斯',
  ua: '乌克兰',
  tr: '土耳其',
  sa: '沙特',
  ae: '阿联酋',
  il: '以色列',
  in: '印度',
  sg: '新加坡',
  my: '马来西亚',
  th: '泰国',
  vn: '越南',
  id: '印尼',
  ph: '菲律宾',
  au: '澳大利亚',
  nz: '新西兰',
  ca: '加拿大',
  mx: '墨西哥',
  br: '巴西',
  ar: '阿根廷',
  cl: '智利',
  za: '南非',
  eg: '埃及',
  ng: '尼日利亚'
}

export function countryDisplayName(raw?: string | null): string {
  const code = normalizeCountryCode(raw)
  if (!code) return raw?.trim() || '—'
  return COUNTRY_NAME_ZH[code] || raw!.trim().toUpperCase()
}
