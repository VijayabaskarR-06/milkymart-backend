import jwt from 'jsonwebtoken'

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

// Authenticates an app user (customer or rider). Attaches req.auth = { id, role }.
export const requireUser = (req, res, next) => {
  const claims = verifyToken(bearer(req))
  if (!claims || claims.kind !== 'user') return res.status(401).json({ error: 'Not authenticated' })
  req.auth = claims
  next()
}

// Authenticates an admin-panel session.
export const requireAdmin = (req, res, next) => {
  const claims = verifyToken(bearer(req))
  if (!claims || claims.kind !== 'admin') return res.status(401).json({ error: 'Admin auth required' })
  req.admin = claims
  next()
}
