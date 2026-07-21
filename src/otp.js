import { createHash, randomInt } from 'node:crypto'
import { query, one } from './db.js'
import { log } from './logger.js'

// OTP delivery is credential-gated. With no provider keys the service runs in
// DEMO mode (any 6-digit code is accepted) so the app stays usable; the moment
// SMS_PROVIDER + credentials are set it switches to real codes over SMS.
export const OTP_TTL_MINUTES = 5
const MAX_ATTEMPTS = 5
const RESEND_COOLDOWN_SECONDS = 30

export const smsProvider = (process.env.SMS_PROVIDER || '').toLowerCase() // 'msg91' | 'twilio' | ''
export const isLiveOtp = Boolean(
  (smsProvider === 'msg91' && process.env.MSG91_AUTH_KEY) ||
  (smsProvider === 'twilio' && process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_AUTH_TOKEN && process.env.TWILIO_FROM),
)

const hash = (phone, code) => createHash('sha256').update(`${phone}:${code}`).digest('hex')

async function sendSms(phone, code) {
  const text = `${code} is your Milky Mart verification code. It expires in ${OTP_TTL_MINUTES} minutes.`
  if (smsProvider === 'msg91') {
    const res = await fetch('https://control.msg91.com/api/v5/flow/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', authkey: process.env.MSG91_AUTH_KEY },
      body: JSON.stringify({
        template_id: process.env.MSG91_TEMPLATE_ID,
        sender: process.env.MSG91_SENDER_ID,
        short_url: '0',
        recipients: [{ mobiles: `91${phone}`, OTP: code }],
      }),
    })
    if (!res.ok) throw new Error(`MSG91 responded ${res.status}`)
    return
  }
  if (smsProvider === 'twilio') {
    const sid = process.env.TWILIO_ACCOUNT_SID
    const body = new URLSearchParams({ To: `+91${phone}`, From: process.env.TWILIO_FROM, Body: text })
    const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`, {
      method: 'POST',
      headers: {
        Authorization: 'Basic ' + Buffer.from(`${sid}:${process.env.TWILIO_AUTH_TOKEN}`).toString('base64'),
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body,
    })
    if (!res.ok) throw new Error(`Twilio responded ${res.status}`)
    return
  }
  throw new Error('No SMS provider configured')
}

/** Creates and delivers a code. Returns { demo, cooldown } — never the code itself. */
export async function issueOtp(phone) {
  const recent = await one(
    `SELECT created_at FROM otp_codes WHERE phone=$1 AND created_at > now() - ($2 || ' seconds')::interval
     ORDER BY created_at DESC LIMIT 1`,
    [phone, String(RESEND_COOLDOWN_SECONDS)],
  )
  if (recent) {
    const waited = Math.ceil((Date.now() - new Date(recent.created_at).getTime()) / 1000)
    return { cooldown: Math.max(1, RESEND_COOLDOWN_SECONDS - waited), demo: !isLiveOtp }
  }

  if (!isLiveOtp) {
    // Demo mode: no code is stored, verification accepts any 6 digits.
    log.info('otp.demo_mode', { phone: phone.slice(-4) })
    return { demo: true }
  }

  const code = String(randomInt(100000, 1000000))
  await query('DELETE FROM otp_codes WHERE phone=$1', [phone])
  await query(
    `INSERT INTO otp_codes (phone, code_hash, expires_at) VALUES ($1,$2, now() + ($3 || ' minutes')::interval)`,
    [phone, hash(phone, code), String(OTP_TTL_MINUTES)],
  )
  await sendSms(phone, code)
  log.info('otp.sent', { phone: phone.slice(-4), provider: smsProvider })
  return { demo: false }
}

/** Verifies a code. Returns { ok } or { ok:false, error }. */
export async function verifyOtp(phone, code) {
  if (!isLiveOtp) return { ok: true } // demo mode — any 6 digits (already format-checked)

  const row = await one('SELECT * FROM otp_codes WHERE phone=$1 ORDER BY created_at DESC LIMIT 1', [phone])
  if (!row) return { ok: false, error: 'Request a new OTP' }
  if (new Date(row.expires_at) < new Date()) {
    await query('DELETE FROM otp_codes WHERE phone=$1', [phone])
    return { ok: false, error: 'That OTP expired — request a new one' }
  }
  if (row.attempts >= MAX_ATTEMPTS) {
    await query('DELETE FROM otp_codes WHERE phone=$1', [phone])
    return { ok: false, error: 'Too many wrong attempts — request a new OTP' }
  }
  if (row.code_hash !== hash(phone, code)) {
    await query('UPDATE otp_codes SET attempts = attempts + 1 WHERE id=$1', [row.id])
    return { ok: false, error: 'Incorrect OTP' }
  }
  await query('DELETE FROM otp_codes WHERE phone=$1', [phone])
  return { ok: true }
}
