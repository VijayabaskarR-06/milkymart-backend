# Going live: SMS OTP, payments, hosting

Both integrations are **already built and tested**. They stay in demo mode until
you add credentials — no code change, just environment variables on Render
(Dashboard → your service → Environment → Add, then redeploy).

Check what's currently active any time:

```bash
curl https://milkymart-daily-api.onrender.com/api/config
# {"liveOtp":false,"livePayments":false}   <- demo mode
```

---

## 1. Real SMS OTP (fixes the biggest security hole)

**Today:** any 6-digit code logs anyone in as any phone number.
**After:** a real 6-digit code is texted, expires in 5 minutes, allows 5 attempts,
and has a 30-second resend cooldown. All of that is already implemented.

### Option A — MSG91 (recommended in India, ~₹0.15/SMS)
1. Sign up at [msg91.com](https://msg91.com) and add credit.
2. Create a **sender ID** (6 letters, e.g. `MLKMRT`) and get it approved by DLT.
3. Create an **OTP flow/template** containing a `##OTP##` variable; note its Template ID.
4. Copy your **Auth Key** from the dashboard.
5. Set on Render:

| Variable | Value |
|---|---|
| `SMS_PROVIDER` | `msg91` |
| `MSG91_AUTH_KEY` | your auth key |
| `MSG91_TEMPLATE_ID` | your template id |
| `MSG91_SENDER_ID` | e.g. `MLKMRT` |

> India requires **DLT registration** (sender ID + template) before SMS delivers.
> MSG91 walks you through it; approval usually takes 1–2 days.

### Option B — Twilio (easier to start, pricier for India)
| Variable | Value |
|---|---|
| `SMS_PROVIDER` | `twilio` |
| `TWILIO_ACCOUNT_SID` | from the Twilio console |
| `TWILIO_AUTH_TOKEN` | from the Twilio console |
| `TWILIO_FROM` | your Twilio number, e.g. `+1415…` |

Redeploy, then confirm `"liveOtp": true` at `/api/config`.

---

## 2. Real payments (Razorpay)

**Today:** wallet top-ups credit instantly (fake money). Cash on delivery is real.
**After:** a top-up creates a Razorpay order, the app completes checkout, and the
server credits the wallet **only after verifying the payment signature** — with
replay protection so a payment can never be credited twice.

1. Create an account at [razorpay.com](https://razorpay.com) and complete KYC
   (business PAN + bank account; approval takes a few days).
2. Settings → API Keys → **Generate Key**.
3. Set on Render:

| Variable | Value |
|---|---|
| `RAZORPAY_KEY_ID` | `rzp_live_…` (or `rzp_test_…` to trial it) |
| `RAZORPAY_KEY_SECRET` | the matching secret |
| `RAZORPAY_WEBHOOK_SECRET` | any strong string you also paste into Razorpay |

4. In Razorpay → Settings → Webhooks, add
   `https://<your-api>/api/webhooks/razorpay` with the same secret.

Start with **test keys** (`rzp_test_…`) — they exercise the whole flow with no real money.

### Endpoints already built
| Endpoint | Purpose |
|---|---|
| `POST /api/wallet/topup/create` | creates the Razorpay order |
| `POST /api/wallet/topup/confirm` | verifies the signature and credits the wallet |

---

## 3. Hosting that doesn't sleep + backups

The free tier sleeps after ~15 minutes (≈50s cold start) and the free Postgres
**expires 90 days after creation**.

| Item | Free | Recommended |
|---|---|---|
| Web service | sleeps | **Starter — $7/mo**, always on |
| Postgres | expires in 90 days, no backups | **Basic — from $7/mo**, daily backups + point-in-time restore |

In Render: service → Settings → **Change Instance Type**; database → **Upgrade**.
Do the database first — when the free one expires the data is gone.

Also worth doing once you're on paid:
- Add a **custom domain** (Settings → Custom Domain) and rebuild the app pointing at it.
- Turn on a **Sentry** DSN for error alerts.
- Take a manual backup before any big change: `pg_dump "$DATABASE_URL" > backup.sql`.

---

## Order of work I'd suggest

1. **Upgrade Postgres** — cheapest insurance; the free one expiring loses everything.
2. **SMS OTP** — closes the "anyone can log in as anyone" hole. Start DLT early, it's the slow part.
3. **Razorpay test keys** — prove the payment flow end to end, then swap to live keys after KYC.
4. **Upgrade the web service** — when you want it always-on for real users.
