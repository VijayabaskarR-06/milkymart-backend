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

---

## 4. Firebase Phone Auth + Push notifications (FCM)

One Firebase project powers both. Everything server-side is built; it activates
when you set the service account.

### Create the project
1. [console.firebase.google.com](https://console.firebase.google.com) → **Add project**.
2. **Authentication → Sign-in method → Phone → Enable.**
3. **Project settings → General → Add app → Android**
   - Package name: `com.milkymart.clone`
   - Add your signing SHA-1 (required for phone auth):
     ```bash
     keytool -list -v -keystore android/milkymart-release.keystore -alias milkymart
     ```
   - Download **`google-services.json`** → drop it into `android/app/` in the app project.
4. **Project settings → Service accounts → Generate new private key** (JSON).

### Set on Render
| Variable | Value |
|---|---|
| `FIREBASE_SERVICE_ACCOUNT` | the whole service-account JSON (or its base64) |

Once set, `/api/config` reports `"firebaseAuth":true,"push":true`, and:
- `POST /api/auth/firebase` accepts a Firebase ID token and returns a Milky Mart session.
- Order status changes send an FCM push to every device the user registered
  (`POST /api/devices`), on top of the in-app notification.

> The app keeps using the built-in OTP screen until `google-services.json` is
> added and the app is rebuilt — so nothing breaks in the meantime.

---

## 5. Product image uploads (Cloudinary)

**Today:** the admin's "Add product" form saves with a bundled stock image.
**After:** the chosen photo uploads to a CDN and appears in the app.

1. Sign up at [cloudinary.com](https://cloudinary.com) (free tier is generous).
2. Dashboard → copy **Cloud name**, **API Key**, **API Secret**.
3. Set on Render:

| Variable | Value |
|---|---|
| `CLOUDINARY_CLOUD_NAME` | your cloud name |
| `CLOUDINARY_API_KEY` | your API key |
| `CLOUDINARY_API_SECRET` | your API secret |

Uploads are validated (JPEG/PNG/WebP, max 5 MB) and served resized and
auto-formatted (`f_auto,q_auto,w_600`).

---

## 6. Error monitoring (Sentry)

1. [sentry.io](https://sentry.io) → new **Node.js** project → copy the DSN.
2. Set `SENTRY_DSN` on Render.

Unhandled errors and 500s are reported with the request path and an
`X-Request-Id` to correlate with the logs. Authorization headers and cookies are
stripped before anything is sent.

---

## 7. Maps — already working, no key needed

The rider's **Directions** button opens Google Maps with turn-by-turn navigation
to the delivery address, using a universal Maps URL. No API key, no billing.

Only add Google Maps Platform / Ola Maps billing if you later want in-app maps,
pin-drop address selection, or live rider tracking.

---

## 8. Legal pages (needed before the Play Store will publish)

Already hosted by the backend:

- `https://<your-api>/legal/privacy.html`
- `https://<your-api>/legal/terms.html`

Paste those URLs into your Play Console listing. Update the contact email in
`public/legal/*.html` if you want a different support address.
