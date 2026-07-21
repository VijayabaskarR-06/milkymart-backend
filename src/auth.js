import jwt from 'jsonwebtoken'
import { one } from './db.js'

const DEV_SECRET = 'dev-only-secret-change-in-production'
const SECRET = process.env.JWT_SECRET || DEV_SECRET

// Never run production with the fallback secret — tokens would be forgeable.
if (process.env.NODE_ENV === 'production' && SECRET === DEV_SECRET) {
  throw new Error('JWT_SECRET must be set in production')
}

export const signToken = (payload) => jwt.sign(payload, SECRET, { expiresIn: '30d' })

export const verifyToken = (token) => {
  try {
    return jwt.verify(token, SECRET)
  } catch {
    return null
  }
}

const bearer = (req) => {
  const header = req.headers.authorization || ''
  return header.startsWith('Bearer ') ? header.slice(7) : null
}

// Authenticates an app user (customer or rider). Tokens carry the user's
// token_version; logging out bumps that column, which invalidates every token
// previously issued to them — a real server-side logout.
export const requireUser = async (req, res, next) => {
  const claims = verifyToken(bearer(req))
  if (!claims || claims.kind !== 'user') return res.status(401).json({ error: 'Not authenticated' })
  try {
    const user = await one('SELECT id, role, token_version FROM users WHERE id=$1', [claims.id])
    if (!user) return res.status(401).json({ error: 'Account no longer exists' })
    if ((claims.tv ?? 0) !== user.token_version) {
      return res.status(401).json({ error: 'Session expired — please sign in again' })
    }
    req.auth = { id: user.id, role: user.role }
    next()
  } catch (err) {
    next(err)
  }
}

// Authenticates an admin-panel session.
export const requireAdmin = (req, res, next) => {
  const claims = verifyToken(bearer(req))
  if (!claims || claims.kind !== 'admin') return res.status(401).json({ error: 'Admin auth required' })
  req.admin = claims
  next()
}
