import { z } from 'zod'

// Wraps a zod schema as Express middleware; puts the parsed value on req.valid
// and returns a consistent 400 shape on failure.
export const validate = (schema) => (req, res, next) => {
  const result = schema.safeParse(req.body ?? {})
  if (!result.success) {
    const first = result.error.issues[0]
    return res.status(400).json({
      error: first?.message || 'Invalid request',
      field: first?.path?.join('.') || undefined,
    })
  }
  req.valid = result.data
  next()
}

const phone = z
  .string()
  .transform((v) => v.replace(/\D/g, ''))
  .refine((v) => /^\d{10}$/.test(v), 'Enter a valid 10-digit mobile number')

export const schemas = {
  requestOtp: z.object({ phone }),
  verifyOtp: z.object({
    phone,
    otp: z.string().regex(/^\d{6}$/, 'Enter a 6-digit OTP'),
    role: z.enum(['customer', 'rider']).optional().default('customer'),
  }),
  updateName: z.object({
    name: z.string().trim().min(1, 'Name cannot be empty').max(40),
  }),
  address: z.object({
    label: z.string().trim().min(1, 'Add a label').max(20),
    detail: z.string().trim().min(1, 'Add a full address').max(140),
  }),
  topup: z.object({
    amount: z.coerce.number().int().positive('Enter an amount greater than ₹0').max(50000, 'Maximum is ₹50,000 per top-up'),
    note: z.string().trim().max(140).optional(),
  }),
  placeOrder: z.object({
    items: z
      .array(
        z.object({
          id: z.string().min(1, 'Invalid product'),
          quantity: z.coerce
            .number()
            .int('Quantity must be a whole number')
            .min(1, 'Each item needs a quantity of at least 1')
            .max(99, 'Maximum 99 per item'),
        }),
      )
      .min(1, 'Your cart is empty'),
    address: z.string().trim().min(1, 'Choose a delivery address').max(140),
    slot: z.string().trim().max(40).optional(),
    date: z.string().trim().max(40).optional(),
    idempotencyKey: z.string().trim().max(80).optional(),
  }),
  adminLogin: z.object({
    email: z.string().trim().email('Enter a valid email'),
    password: z.string().min(1, 'Enter your password'),
  }),
  adminChangePassword: z
    .object({
      currentPassword: z.string().min(1, 'Enter your current password'),
      newPassword: z
        .string()
        .min(10, 'New password must be at least 10 characters')
        .max(200)
        .refine((v) => /[a-zA-Z]/.test(v) && /[0-9]/.test(v), 'Use a mix of letters and numbers'),
    })
    .refine((v) => v.currentPassword !== v.newPassword, {
      message: 'New password must be different from the current one',
      path: ['newPassword'],
    }),
  orderStatus: z.object({
    status: z.enum(['Confirmed', 'Packed', 'Out for delivery', 'Delivered', 'Cancelled']),
  }),
  assignRider: z.object({ riderId: z.coerce.number().int().positive().nullable() }),
  approveRider: z.object({ approved: z.boolean().optional().default(true) }),
  product: z.object({
    id: z.string().trim().min(1).max(60),
    name: z.string().trim().min(1).max(80),
    size: z.string().trim().max(40).optional(),
    price: z.coerce.number().positive().max(100000),
    mrp: z.coerce.number().positive().max(100000).optional(),
    category: z.string().trim().max(40).optional(),
    badge: z.string().trim().max(30).nullable().optional(),
    description: z.string().trim().max(300).optional(),
    image: z.string().trim().max(200).optional(),
    stock: z.coerce.number().int().min(0).max(100000).optional(),
  }),
}

// Allowed order transitions — prevents an order moving backwards or skipping
// straight from Confirmed to Delivered by accident.
const TRANSITIONS = {
  Confirmed: ['Packed', 'Out for delivery', 'Cancelled'],
  Packed: ['Out for delivery', 'Cancelled'],
  'Out for delivery': ['Delivered', 'Cancelled'],
  Delivered: [],
  Cancelled: [],
}

export const canTransition = (from, to) => from === to || (TRANSITIONS[from] || []).includes(to)
export const allowedNext = (from) => TRANSITIONS[from] || []
