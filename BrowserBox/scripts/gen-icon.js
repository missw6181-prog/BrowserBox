const { app, nativeImage, BrowserWindow } = require('electron')
const { writeFileSync, readFileSync } = require('fs')
const { join } = require('path')

const root = process.cwd()

function packIco(pngs) {
  const count = pngs.length
  const headerSize = 6 + 16 * count
  let offset = headerSize
  const offsets = []
  let total = headerSize
  for (const item of pngs) {
    offsets.push(offset)
    offset += item.png.length
    total += item.png.length
  }
  const buf = Buffer.alloc(total)
  let o = 0
  buf.writeUInt16LE(0, o)
  o += 2
  buf.writeUInt16LE(1, o)
  o += 2
  buf.writeUInt16LE(count, o)
  o += 2
  for (let i = 0; i < count; i++) {
    const size = pngs[i].size
    buf[o++] = size >= 256 ? 0 : size
    buf[o++] = size >= 256 ? 0 : size
    buf[o++] = 0
    buf[o++] = 0
    buf.writeUInt16LE(1, o)
    o += 2
    buf.writeUInt16LE(32, o)
    o += 2
    buf.writeUInt32LE(pngs[i].png.length, o)
    o += 4
    buf.writeUInt32LE(offsets[i], o)
    o += 4
  }
  for (let i = 0; i < count; i++) pngs[i].png.copy(buf, offsets[i])
  return buf
}

app.whenReady().then(async () => {
  const svg = readFileSync(join(root, 'resources', 'icon.svg'), 'utf8')
  const b64 = Buffer.from(svg, 'utf8').toString('base64')

  const win = new BrowserWindow({
    width: 64,
    height: 64,
    show: false,
    webPreferences: { offscreen: true, contextIsolation: false }
  })
  await win.loadURL('data:text/html,<html><body></body></html>')

  const dataUrl = await win.webContents.executeJavaScript(`
    new Promise((resolve, reject) => {
      const size = 512
      const canvas = document.createElement('canvas')
      canvas.width = size
      canvas.height = size
      const ctx = canvas.getContext('2d')
      ctx.clearRect(0, 0, size, size)
      const img = new Image()
      img.onload = () => {
        try {
          ctx.drawImage(img, 0, 0, size, size)
          resolve(canvas.toDataURL('image/png'))
        } catch (e) { reject(String(e)) }
      }
      img.onerror = () => reject('svg load failed')
      img.src = 'data:image/svg+xml;base64,${b64}'
    })
  `)

  const png512 = nativeImage.createFromDataURL(dataUrl).toPNG()
  writeFileSync(join(root, 'resources', 'icon.png'), png512)

  const base = nativeImage.createFromBuffer(png512)
  const sizes = [16, 24, 32, 48, 64, 128, 256]
  const pngs = sizes.map((size) => ({
    size,
    png: base.resize({ width: size, height: size, quality: 'best' }).toPNG()
  }))
  writeFileSync(join(root, 'resources', 'icon.ico'), packIco(pngs))
  console.log('OK transparent icon.png + icon.ico', png512.length)
  app.quit()
})
