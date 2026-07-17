# Production readiness

An honest status of what's production-grade and what still needs real accounts
or services before this is a true production app.

## ✅ Done (production-grade)

- **Real backend + database** — Express API on PostgreSQL, transactions for
  wallet/order integrity, self-migrating on boot.
- **Security headers** — `helmet` (CSP, HSTS, nosniff, frame options).
- **Rate limiting** — brute-force protection on auth endpoints (production).
- **Secrets** — fails fast if `JWT_SECRET` is unset in production; never seeds a
  known admin password in production (generates one and logs it if unset).
- **CORS allowlist** — set `CORS_ORIGINS` to restrict browser callers.
- **Signed release APK** — R8-minified, resource-shrunk, signed with a real
  release keystore (not the debug key). ~2.7 MB.
- **HTTPS-only app** — the app talks to the backend over HTTPS (no cleartext).
- **Automated tests** — 15 end-to-end tests against the live API.

## ⚠️ Needs YOUR account / service before real launch

These require credentials or paid services only you can provide:

1. **Real OTP / SMS.** Login currently accepts *any* 6-digit code (demo). For
   production, integrate an SMS OTP provider (MSG91, Twilio, or Firebase Phone
   Auth) and verify the code server-side in `POST /api/auth/verify-otp`.
2. **Payments.** Wallet / UPI / COD are simulated. Integrate a gateway
   (Razorpay or Stripe) with webhooks to confirm payments before creating orders.
3. **Always-on hosting.** The free Render tier sleeps after ~15 min idle and its
   free Postgres expires in 90 days. Move to paid Render / a managed Postgres
   (Neon, Supabase, RDS) for production, and take database backups.
4. **Play Store.** The APK is release-signed for direct install/sideload. To
   publish, enrol in the Google Play Console ($25), build an **AAB**
   (`./gradlew bundleRelease`), and enable Play App Signing. **Keep
   `milkymart-release.keystore` and its password safe — losing it means you can
   never update the app.**
5. **Custom domain + monitoring.** Add your own domain, plus error tracking
   (Sentry) and uptime monitoring.

## Nice-to-have hardening

- Per-user rate limits and request logging.
- Admin roles / audit log.
- Image uploads to object storage instead of bundled assets.
- CI to run the test suite on every push.

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
