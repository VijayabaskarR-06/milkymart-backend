import { query } from './db.js'
import { sendPush } from './firebase.js'

/**
 * Single place to notify a user: always writes the in-app notification (which
 * the app shows in its bell list), and additionally sends an FCM push when
 * Firebase is configured and the user has registered a device.
 */
export async function notifyUser(userId, { title, body, data = {} }) {
  if (!userId) return
  await query('INSERT INTO notifications (user_id, title, body) VALUES ($1,$2,$3)', [userId, title, body])

  const { rows } = await query('SELECT token FROM device_tokens WHERE user_id=$1', [userId])
  if (!rows.length) return

  const { invalid } = await sendPush(rows.map((r) => r.token), { title, body, data })
  // Drop tokens the device no longer accepts so the table stays clean.
  if (invalid.length) {
    await query('DELETE FROM device_tokens WHERE token = ANY($1)', [invalid])
  }
}
