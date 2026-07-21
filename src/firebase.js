import { log } from './logger.js'

// Firebase powers two optional features: phone-number sign-in (the app gets an
// ID token from Firebase, we verify it here) and push notifications via FCM.
// Both stay off until a service account is configured, so the app keeps working
// with the built-in OTP + in-app notifications until then.
//
// Provide credentials either as:
//   FIREBASE_SERVICE_ACCOUNT  — the service-account JSON (or base64 of it)
//   GOOGLE_APPLICATION_CREDENTIALS — path to that JSON file
let app = null
let initError = null

function serviceAccountFromEnv() {
  const raw = process.env.FIREBASE_SERVICE_ACCOUNT
  if (!raw) return null
  const text = raw.trim().startsWith('{') ? raw : Buffer.from(raw, 'base64').toString('utf8')
  return JSON.parse(text)
}

async function init() {
  if (app || initError) return app
  try {
    const { initializeApp, cert, applicationDefault, getApps } = await import('firebase-admin/app')
    if (getApps().length) {
      app = getApps()[0]
      return app
    }
    const sa = serviceAccountFromEnv()
    if (sa) {
      app = initializeApp({ credential: cert(sa), projectId: sa.project_id })
    } else if (process.env.GOOGLE_APPLICATION_CREDENTIALS) {
      app = initializeApp({ credential: applicationDefault() })
    } else {
      return null
    }
    log.info('firebase.initialised', { projectId: app.options.projectId })
    return app
  } catch (err) {
    initError = err
    log.error('firebase.init_failed', { error: err.message })
    return null
  }
}

export const firebaseConfigured = Boolean(
  process.env.FIREBASE_SERVICE_ACCOUNT || process.env.GOOGLE_APPLICATION_CREDENTIALS,
)

/**
 * Verifies a Firebase ID token from the app's phone sign-in.
 * Returns { ok, phone, uid } — phone is the 10-digit national number.
 */
export async function verifyFirebaseIdToken(idToken) {
  const instance = await init()
  if (!instance) return { ok: false, error: 'Firebase sign-in is not configured' }
  try {
    const { getAuth } = await import('firebase-admin/auth')
    const decoded = await getAuth(instance).verifyIdToken(idToken, true)
    const phone = String(decoded.phone_number || '').replace(/\D/g, '').slice(-10)
    if (!/^\d{10}$/.test(phone)) return { ok: false, error: 'That sign-in has no phone number attached' }
    return { ok: true, phone, uid: decoded.uid }
  } catch (err) {
    log.warn('firebase.token_rejected', { error: err.message })
    return { ok: false, error: 'Sign-in could not be verified' }
  }
}

/** Sends a push notification to a set of device tokens. Silently no-ops when off. */
export async function sendPush(tokens, { title, body, data = {} }) {
  const list = (tokens || []).filter(Boolean)
  if (!list.length) return { sent: 0, invalid: [] }
  const instance = await init()
  if (!instance) return { sent: 0, invalid: [] }
  try {
    const { getMessaging } = await import('firebase-admin/messaging')
    const res = await getMessaging(instance).sendEachForMulticast({
      tokens: list,
      notification: { title, body },
      data: Object.fromEntries(Object.entries(data).map(([k, v]) => [k, String(v)])),
      android: { priority: 'high', notification: { channelId: 'milkymart-orders' } },
    })
    // Collect tokens the device/app no longer accepts so we can prune them.
    const invalid = []
    res.responses.forEach((r, i) => {
      const code = r.error?.code || ''
      if (code.includes('registration-token-not-registered') || code.includes('invalid-argument')) invalid.push(list[i])
    })
    log.info('push.sent', { sent: res.successCount, failed: res.failureCount })
    return { sent: res.successCount, invalid }
  } catch (err) {
    log.error('push.failed', { error: err.message })
    return { sent: 0, invalid: [] }
  }
}
