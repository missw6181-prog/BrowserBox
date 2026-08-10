/** 浏览器语言预设（环境可单独指定；空 = 自动） */

export interface LanguagePreset {
  /** 存入 Environment.browserLang */
  id: string
  label: string
  lang: string
  acceptLanguages: string
  locale: string
  /** 无代理时区可跟随时的回退时区 */
  timezone: string
}

export const LANGUAGE_PRESETS: LanguagePreset[] = [
  {
    id: 'zh-CN',
    label: '简体中文 (zh-CN)',
    lang: 'zh-CN',
    acceptLanguages: 'zh-CN,zh,en-US,en',
    locale: 'zh-CN',
    timezone: 'Asia/Shanghai'
  },
  {
    id: 'zh-TW',
    label: '繁体中文 (zh-TW)',
    lang: 'zh-TW',
    acceptLanguages: 'zh-TW,zh,en-US,en',
    locale: 'zh-TW',
    timezone: 'Asia/Taipei'
  },
  {
    id: 'en-US',
    label: '英语美国 (en-US)',
    lang: 'en-US',
    acceptLanguages: 'en-US,en',
    locale: 'en-US',
    timezone: 'America/New_York'
  },
  {
    id: 'en-GB',
    label: '英语英国 (en-GB)',
    lang: 'en-GB',
    acceptLanguages: 'en-GB,en',
    locale: 'en-GB',
    timezone: 'Europe/London'
  },
  {
    id: 'ja',
    label: '日语 (ja)',
    lang: 'ja',
    acceptLanguages: 'ja,en-US,en',
    locale: 'ja-JP',
    timezone: 'Asia/Tokyo'
  },
  {
    id: 'ko',
    label: '韩语 (ko)',
    lang: 'ko',
    acceptLanguages: 'ko,en-US,en',
    locale: 'ko-KR',
    timezone: 'Asia/Seoul'
  },
  {
    id: 'de',
    label: '德语 (de)',
    lang: 'de',
    acceptLanguages: 'de-DE,de,en-US,en',
    locale: 'de-DE',
    timezone: 'Europe/Berlin'
  },
  {
    id: 'fr',
    label: '法语 (fr)',
    lang: 'fr',
    acceptLanguages: 'fr-FR,fr,en-US,en',
    locale: 'fr-FR',
    timezone: 'Europe/Paris'
  },
  {
    id: 'es',
    label: '西班牙语 (es)',
    lang: 'es',
    acceptLanguages: 'es-ES,es,en-US,en',
    locale: 'es-ES',
    timezone: 'Europe/Madrid'
  },
  {
    id: 'pt-BR',
    label: '葡萄牙语巴西 (pt-BR)',
    lang: 'pt-BR',
    acceptLanguages: 'pt-BR,pt,en-US,en',
    locale: 'pt-BR',
    timezone: 'America/Sao_Paulo'
  },
  {
    id: 'ru',
    label: '俄语 (ru)',
    lang: 'ru',
    acceptLanguages: 'ru-RU,ru,en-US,en',
    locale: 'ru-RU',
    timezone: 'Europe/Moscow'
  },
  {
    id: 'vi',
    label: '越南语 (vi)',
    lang: 'vi',
    acceptLanguages: 'vi-VN,vi,en-US,en',
    locale: 'vi-VN',
    timezone: 'Asia/Ho_Chi_Minh'
  },
  {
    id: 'th',
    label: '泰语 (th)',
    lang: 'th',
    acceptLanguages: 'th-TH,th,en-US,en',
    locale: 'th-TH',
    timezone: 'Asia/Bangkok'
  },
  {
    id: 'id',
    label: '印尼语 (id)',
    lang: 'id',
    acceptLanguages: 'id-ID,id,en-US,en',
    locale: 'id-ID',
    timezone: 'Asia/Jakarta'
  },
  {
    id: 'ar',
    label: '阿拉伯语 (ar)',
    lang: 'ar',
    acceptLanguages: 'ar-SA,ar,en-US,en',
    locale: 'ar-SA',
    timezone: 'Asia/Riyadh'
  }
]

export function getLanguagePreset(id?: string | null): LanguagePreset | null {
  if (!id) return null
  return LANGUAGE_PRESETS.find((p) => p.id === id) || null
}
