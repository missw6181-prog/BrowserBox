import type { FingerprintProfile } from '../../shared/types'
import { buildUserAgentMetadata, parseChromeVersionFromUa } from './uaMeta'

export interface InjectScriptOptions {
  languages?: string[]
  /**
   * 降低自动化检测：隐藏 webdriver、不写全局标记、属性不可枚举；
   * 并关闭高风险的 Canvas/Audio 原型污染（BrowserScan 等极易识破）。
   */
  stealth?: boolean
}

/**
 * 生成在每个新文档执行的轻量伪装脚本。
 */
export function buildFingerprintInjectScript(
  profile: FingerprintProfile,
  opts?: InjectScriptOptions
): string {
  const stealth = opts?.stealth !== false
  const languages = opts?.languages?.length ? opts.languages : profile.languages
  const fullVer = parseChromeVersionFromUa(profile.userAgent) || '120.0.0.0'
  const major = fullVer.split('.')[0]
  const meta = buildUserAgentMetadata(profile.userAgent)

  const cfg = JSON.stringify({
    userAgent: profile.userAgent,
    platform: profile.platform,
    languages,
    hardwareConcurrency: profile.hardwareConcurrency,
    deviceMemory: profile.deviceMemory,
    screen: profile.screen,
    // stealth 下默认不改 Canvas/Audio（噪声补丁本身是强指纹/机器人特征）
    canvasNoise: stealth ? 0 : profile.canvasNoise,
    webglVendor: stealth ? '' : profile.webglVendor,
    webglRenderer: stealth ? '' : profile.webglRenderer,
    audioNoise: stealth ? 0 : profile.audioNoise,
    seed: profile.seed,
    fullVersion: fullVer,
    major,
    brands: meta.brands,
    fullVersionList: meta.fullVersionList,
    platformVersion: meta.platformVersion,
    architecture: meta.architecture,
    bitness: meta.bitness,
    stealth
  })

  return `(() => {
  const CFG = ${cfg};
  const define = (obj, prop, getter) => {
    try {
      Object.defineProperty(obj, prop, {
        get: getter,
        configurable: true,
        enumerable: false
      });
    } catch (e) {}
  };

  // —— 反自动化痕迹 ——
  if (CFG.stealth) {
    try {
      define(Navigator.prototype, 'webdriver', () => undefined);
    } catch (e) {}
    try {
      if (window.chrome && !window.chrome.runtime) {
        // 保持 chrome 对象存在即可，不伪造复杂 runtime
      }
    } catch (e) {}
  }

  // —— navigator 基础 ——
  try {
    define(Navigator.prototype, 'userAgent', () => CFG.userAgent);
    define(Navigator.prototype, 'appVersion', () => CFG.userAgent.replace(/^Mozilla\\//, ''));
    define(Navigator.prototype, 'platform', () => CFG.platform);
    define(Navigator.prototype, 'vendor', () => 'Google Inc.');
    define(Navigator.prototype, 'language', () => (CFG.languages && CFG.languages[0]) || 'en-US');
    define(Navigator.prototype, 'languages', () => Object.freeze([...CFG.languages]));
    define(Navigator.prototype, 'hardwareConcurrency', () => CFG.hardwareConcurrency);
    define(Navigator.prototype, 'deviceMemory', () => CFG.deviceMemory);
    define(Navigator.prototype, 'maxTouchPoints', () => 0);
  } catch (e) {}

  // —— User-Agent Client Hints ——
  try {
    const uaData = {
      brands: CFG.brands,
      mobile: false,
      platform: 'Windows',
      getHighEntropyValues: function (hints) {
        const want = Array.isArray(hints) ? hints : [];
        const out = {
          brands: CFG.brands,
          mobile: false,
          platform: 'Windows'
        };
        if (want.includes('architecture')) out.architecture = CFG.architecture;
        if (want.includes('bitness')) out.bitness = CFG.bitness;
        if (want.includes('model')) out.model = '';
        if (want.includes('platformVersion')) out.platformVersion = CFG.platformVersion;
        if (want.includes('fullVersionList')) out.fullVersionList = CFG.fullVersionList;
        if (want.includes('uaFullVersion') || want.includes('fullVersion')) out.uaFullVersion = CFG.fullVersion;
        if (want.includes('wow64')) out.wow64 = false;
        return Promise.resolve(out);
      },
      toJSON: function () {
        return { brands: CFG.brands, mobile: false, platform: 'Windows' };
      }
    };
    define(Navigator.prototype, 'userAgentData', () => uaData);
  } catch (e) {}

  // —— screen / DPR：stealth 下不改（与真实窗口/DPR 易矛盾）——
  if (!CFG.stealth) {
    try {
      const s = CFG.screen || {};
      define(Screen.prototype, 'width', () => s.width);
      define(Screen.prototype, 'height', () => s.height);
      define(Screen.prototype, 'availWidth', () => s.width);
      define(Screen.prototype, 'availHeight', () => Math.max(0, (s.height || 0) - 40));
      define(Screen.prototype, 'colorDepth', () => s.colorDepth || 24);
      define(Screen.prototype, 'pixelDepth', () => s.colorDepth || 24);
      define(window, 'devicePixelRatio', () => s.pixelRatio || 1);
    } catch (e) {}
  }
  // —— WebGL：stealth 下不改（只改 vendor/renderer 会与真实 GL 参数矛盾，BrowserScan 更易扣分）——
  if (!CFG.stealth) {
    try {
      const patchGl = (proto) => {
        if (!proto || typeof proto.getParameter !== 'function') return;
        const orig = proto.getParameter;
        proto.getParameter = function (param) {
          const dbg = this.getExtension && this.getExtension('WEBGL_debug_renderer_info');
          if (dbg) {
            if (param === dbg.UNMASKED_VENDOR_WEBGL) return CFG.webglVendor;
            if (param === dbg.UNMASKED_RENDERER_WEBGL) return CFG.webglRenderer;
          }
          if (param === 37445) return CFG.webglVendor;
          if (param === 37446) return CFG.webglRenderer;
          return orig.apply(this, arguments);
        };
      };
      if (typeof WebGLRenderingContext !== 'undefined') patchGl(WebGLRenderingContext.prototype);
      if (typeof WebGL2RenderingContext !== 'undefined') patchGl(WebGL2RenderingContext.prototype);
    } catch (e) {}
  }
  // Canvas / Audio 噪声：stealth 关闭（易被标成异常指纹）
  if (!CFG.stealth && CFG.canvasNoise) {
    try {
      const noiseAt = (i, magnitude) => {
        let h = 0;
        const str = CFG.seed + ':' + i;
        for (let j = 0; j < str.length; j++) h = ((h << 5) - h + str.charCodeAt(j)) | 0;
        const u = ((h >>> 0) % 10000) / 10000;
        return (u - 0.5) * 2 * magnitude;
      };
      const proto = CanvasRenderingContext2D && CanvasRenderingContext2D.prototype;
      if (proto && proto.getImageData) {
        const origGetImageData = proto.getImageData;
        proto.getImageData = function () {
          const imageData = origGetImageData.apply(this, arguments);
          try {
            const d = imageData.data;
            const mag = CFG.canvasNoise || 0.0001;
            for (let i = 0; i < d.length; i += 4) {
              d[i] = Math.max(0, Math.min(255, (d[i] + noiseAt(i, mag * 255)) | 0));
            }
          } catch (e) {}
          return imageData;
        };
      }
    } catch (e) {}
  }
})();`
}
