import { createHash } from 'node:crypto'
import { log } from './logger.js'

// Product images live in Cloudinary once configured. Until then the admin can
// still pick from the images bundled with the app, so nothing breaks.
const CLOUD = process.env.CLOUDINARY_CLOUD_NAME
const KEY = process.env.CLOUDINARY_API_KEY
const SECRET = process.env.CLOUDINARY_API_SECRET

export const storageConfigured = Boolean(CLOUD && KEY && SECRET)
const MAX_BYTES = 5 * 1024 * 1024
const ALLOWED = ['image/jpeg', 'image/png', 'image/webp']

/**
 * Uploads a base64 data URL to Cloudinary and returns a CDN URL.
 * Images are delivered auto-resized and auto-format by the transformation.
 */
export async function uploadProductImage(dataUrl, publicIdHint = '') {
  if (!storageConfigured) return { ok: false, error: 'Image storage is not configured' }

  const match = /^data:([^;]+);base64,(.+)$/.exec(String(dataUrl || ''))
  if (!match) return { ok: false, error: 'Send the image as a base64 data URL' }
  const [, mime, b64] = match
  if (!ALLOWED.includes(mime)) return { ok: false, error: 'Use a JPEG, PNG or WebP image' }
  const bytes = Buffer.from(b64, 'base64').length
  if (bytes > MAX_BYTES) return { ok: false, error: 'Image must be under 5 MB' }

  const timestamp = Math.floor(Date.now() / 1000)
  const folder = 'milkymart/products'
  const publicId = `${folder}/${(publicIdHint || 'item').replace(/[^a-z0-9-]/gi, '-').toLowerCase()}-${timestamp}`
  // Cloudinary signs the alphabetically-sorted params with the API secret.
  const toSign = `public_id=${publicId}&timestamp=${timestamp}${SECRET}`
  const signature = createHash('sha1').update(toSign).digest('hex')

  const form = new URLSearchParams({
    file: dataUrl,
    api_key: KEY,
    timestamp: String(timestamp),
    public_id: publicId,
    signature,
  })

  const res = await fetch(`https://api.cloudinary.com/v1_1/${CLOUD}/image/upload`, { method: 'POST', body: form })
  const json = await res.json().catch(() => ({}))
  if (!res.ok) {
    log.error('storage.upload_failed', { status: res.status, error: json?.error?.message })
    return { ok: false, error: json?.error?.message || 'Upload failed' }
  }
  // Serve a resized, auto-format version rather than the original.
  const url = json.secure_url.replace('/upload/', '/upload/f_auto,q_auto,w_600/')
  log.info('storage.uploaded', { publicId: json.public_id, bytes })
  return { ok: true, url, publicId: json.public_id }
}

/** Removes an image when its product is deleted or replaced. */
export async function deleteProductImage(publicId) {
  if (!storageConfigured || !publicId) return
  const timestamp = Math.floor(Date.now() / 1000)
  const signature = createHash('sha1').update(`public_id=${publicId}&timestamp=${timestamp}${SECRET}`).digest('hex')
  const form = new URLSearchParams({ public_id: publicId, api_key: KEY, timestamp: String(timestamp), signature })
  await fetch(`https://api.cloudinary.com/v1_1/${CLOUD}/image/destroy`, { method: 'POST', body: form }).catch(() => {})
}
