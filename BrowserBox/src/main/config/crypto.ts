import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'crypto'
import { app } from 'electron'

/**
 * Local credential encryption.
 * Prefer machine-bound key derived from app path + username.
 * (DPAPI can be swapped in later via native addon; this is V1 safe default.)
 */
function deriveKey(): Buffer {
  const material = `${app.getPath('userData')}|${process.env.USERNAME || process.env.USER || 'browserbox'}|v1`
  return scryptSync(material, 'BrowserBoxSaltV1', 32)
}

export function encryptSecret(plain: string): string {
  if (!plain) return ''
  const key = deriveKey()
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', key, iv)
  const enc = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()])
  const tag = cipher.getAuthTag()
  return Buffer.concat([iv, tag, enc]).toString('base64')
}

export function decryptSecret(blob: string): string {
  if (!blob) return ''
  const buf = Buffer.from(blob, 'base64')
  const iv = buf.subarray(0, 12)
  const tag = buf.subarray(12, 28)
  const data = buf.subarray(28)
  const key = deriveKey()
  const decipher = createDecipheriv('aes-256-gcm', key, iv)
  decipher.setAuthTag(tag)
  return Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8')
}
