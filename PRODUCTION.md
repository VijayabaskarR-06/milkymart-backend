# Production readiness

An honest status of what's production-grade and what still needs real accounts
or services before this is a true production app.

## ✅ Done (production-grade)

- **Real backend + database** — Express API on PostgreSQL, transactions for
  wallet/order integrity.
- **Versioned migrations** — numbered SQL files applied once and tracked in
  `schema_migrations`, each in its own transaction.
- **Idempotent orders** — an idempotency key per checkout; double-taps, retries
  and concurrent submits collapse to a single order (verified with 5 parallel requests).
- **Real logout** — `token_version` on the user invalidates every token already
  issued, so a stolen/old token stops working immediately. Admin sessions work
  the same way: an admin can change their own password from the panel, and it
  signs out every other admin session at once.
- **Phone sign-in is Firebase-only in production** — the demo OTP fallback
  (any 6-digit code) is disabled once Firebase is configured, so the public API
  can't be used to sign in as an arbitrary phone number.
- **Wallet top-ups are rider-only** — customers cannot credit their own wallet
  at all; they hand cash to a delivery partner and an admin credits it. Every
  rider self-adjustment must carry a reason, recorded on the transaction.
- **Admin audit log** — wallet credits, product edits, rider approvals, order
  overrides, demo resets and password changes are all recorded with who did it
  and when, visible under the panel's Activity tab.
- **Order state machine** — orders can't move backwards or skip the delivery
  lifecycle; invalid transitions return 409 with the allowed next steps.
- **Schema validation** — zod on every write endpoint, with consistent errors.
- **Observability** — structured JSON logs, an `X-Request-Id` on every response,
  and guards for unhandled rejections/exceptions.
- **Pagination + indexes** — admin orders are paginated; indexes cover the hot paths.
- **Security headers** — `helmet` (CSP, HSTS, nosniff, frame options).
- **Rate limiting** — brute-force protection on auth endpoints (production).
- **Secrets** — fails fast if `JWT_SECRET` is unset in production; never seeds a
  known admin password in production.
- **CORS allowlist** — set `CORS_ORIGINS` to restrict browser callers.
- **Server-authoritative money** — totals are recomputed from live prices; a
  client-supplied total is ignored.
- **Live sync in the app** — refreshes on foreground, on opening a screen, and on
  a 45s poll, so admin/rider changes appear without a manual refresh.
- **Signed release APK** — R8-minified, resource-shrunk, signed with a real
  release keystore (not the debug key). ~2.7 MB.
- **HTTPS-only app** — the app talks to the backend over HTTPS (no cleartext).
- **Automated tests + CI** — 21 API tests (`npm test`) and 18 end-to-end app
  tests, with GitHub Actions running the API suite against Postgres on every push.
- **SMS OTP + Razorpay built and gated** — fully implemented; they activate the
  moment credentials are set. See [INTEGRATIONS.md](INTEGRATIONS.md).

## ⚠️ Needs YOUR account before it goes live

The code for all three is **already written and tested** — each one just needs
credentials set as environment variables. Full step-by-step: [INTEGRATIONS.md](INTEGRATIONS.md).

1. **SMS OTP (optional now).** Phone sign-in runs on **Firebase phone auth**,
   which is live and real. The backend's own SMS path (MSG91/Twilio) stays
   unconfigured and its demo fallback is disabled in production, so this is no
   longer a security gap — set `SMS_PROVIDER` only if you ever want to sign in
   without Firebase (e.g. a browser build).
2. **Payments.** Rider wallet adjustments credit instantly until
   `RAZORPAY_KEY_ID` / `RAZORPAY_KEY_SECRET` are set. Customers can't self-credit
   either way. Order creation, signature verification, idempotent crediting and
   the webhook are all built.
3. **Always-on hosting.** The free Render tier sleeps after ~15 min idle and its
   free Postgres **expires 90 days after creation with no backups**. Upgrade the
   database first.
4. **Play Store.** The APK is release-signed for direct install/sideload. To
   publish, enrol in the Google Play Console ($25), build an **AAB**
   (`./gradlew bundleRelease`), and enable Play App Signing. **Keep
   `milkymart-release.keystore` and its password safe — losing it means you can
   never update the app.**
5. **Custom domain + monitoring.** Add your own domain, plus error tracking
   (Sentry) and uptime monitoring.

## Nice-to-have hardening

- ~~Per-user rate limits and request logging.~~ Done — `/orders` and
  `/wallet/topup` are throttled per account (not just per IP) in production.
- ~~Admin audit log.~~ Done — see the Activity tab.
- Multiple admin accounts with roles (today there is a single admin login).
- Image uploads to object storage instead of bundled assets (needs Cloudinary
  credentials; the code is written and gated).
- ~~CI to run the test suite on every push.~~ Done.

## Build the release APK yourself

```bash
# in the app project (Milky-Mart-Clone)
VITE_API_URL="https://your-api.onrender.com" npm run build
npx cap sync android
cd android && ./gradlew assembleRelease   # signed APK
# or, for the Play Store:
cd android && ./gradlew bundleRelease      # AAB
```
Signing reads `android/keystore.properties` (kept out of git).
