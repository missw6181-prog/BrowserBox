/// <reference types="vite/client" />

declare module '*.vue' {
  import type { DefineComponent } from 'vue'
  const component: DefineComponent<object, object, unknown>
  export default component
}

interface Window {
  browserBox: {
    invoke: <T = unknown>(
      channel: string,
      ...args: unknown[]
    ) => Promise<
      | { ok: true; data: T }
      | { ok: false; error: { code: string; message: string; details?: unknown } }
    >
    on: (channel: string, listener: (...args: unknown[]) => void) => () => void
  }
}
