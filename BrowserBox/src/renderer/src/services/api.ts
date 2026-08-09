export type ApiResult<T> =
  | { ok: true; data: T }
  | { ok: false; error: { code: string; message: string; details?: unknown } }

export async function invoke<T>(channel: string, ...args: unknown[]): Promise<T> {
  const res = (await window.browserBox.invoke<T>(channel, ...args)) as ApiResult<T>
  if (!res.ok) {
    const err = new Error(res.error.message) as Error & { code?: string; details?: unknown }
    err.code = res.error.code
    err.details = res.error.details
    throw err
  }
  return res.data
}
