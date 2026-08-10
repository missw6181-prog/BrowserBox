import { writeFingerprintExtension } from '../src/main/fingerprint/buildExtension'
import { generateFingerprintProfile } from '../src/main/fingerprint/generateProfile'
import { join } from 'path'
const ext = process.argv[2]
writeFingerprintExtension(ext, generateFingerprintProfile())
console.log('ext', ext)
