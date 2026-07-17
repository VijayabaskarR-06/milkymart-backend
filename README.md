# Milky Mart — Backend API + Admin Panel

Node/Express + Postgres backend that powers the **Milky Mart** mobile app and the
**MilkyMart Admin** dashboard. One deploy serves both:

- `GET /` — service info
- `GET /health` — health check
- `/api/*` — mobile-app endpoints (auth, products, orders, wallet, addresses, notifications, rider)
- `/api/admin/*` — admin endpoints (KPIs, orders, products, customers, riders)
- `/admin/` — the admin dashboard (static site, talks to `/api/admin`)

The app and the admin panel share one database, so an order placed in the app
appears in the admin instantly, and a status change in the admin flows back to
the customer.

## Demo credentials

- **Admin:** `admin@milkymart.app` / `milkymart123`
- **Customer:** phone `9876543210`, any 6-digit OTP
- **Rider:** phone `9998887770`, any 6-digit OTP

## Run locally

Requires Node 18+ and a Postgres database.

```bash
npm install
# Point at your Postgres (or run one locally):
export DATABASE_URL=postgres://postgres@localhost:5432/milkymart
npm run migrate   # create tables + seed demo data (also runs automatically on boot)
npm start         # http://localhost:4000  (admin at /admin)
```

## Deploy to Render (one click)

1. Push this repo to GitHub (already done if you're reading this there).
2. In [Render](https://render.com): **New → Blueprint**, connect this repo, **Apply**.
3. `render.yaml` provisions a free web service **and** a free Postgres database,
   wires `DATABASE_URL`, generates `JWT_SECRET`, and seeds the demo data on first boot.
4. Your API is live at `https://<service-name>.onrender.com`; the admin panel at `/admin`.

> Free Render web services sleep after ~15 min idle (first request then takes
> ~50s to wake), and the free Postgres plan expires after 90 days. Fine for a
> demo; upgrade the plans for always-on production use.

## Environment variables

| Variable | Purpose |
|---|---|
| `DATABASE_URL` | Postgres connection string (required in production) |
| `JWT_SECRET` | Signs auth tokens |
| `ADMIN_EMAIL` / `ADMIN_PASSWORD` | Seeded admin login |
| `PORT` | Defaults to 4000 |
