# PYQ Pulse — Admin Server

Standalone Express server for the **admin panel only**.

## What is included

- Admin login via Supabase Auth
- Admin token refresh
- Admin email allow-list via `ADMIN_EMAILS`
- All `/api/admin/*` CRUD APIs
- Admin dashboard, diagnostics, system check and health
- Admin media upload
- Supabase Storage support
- Privileged Supabase access kept on the server

## What was removed

- User signup
- User-side authentication middleware
- User/mobile API routes
- Flutter/user-side documentation
- Session-result SQL used by the user/mobile flow

The server does **not** expose a public/user API.

## Environment

Copy `.env.example` to `.env` and set:

```env
SUPABASE_URL=https://YOUR_PROJECT.supabase.co
SUPABASE_SECRET_KEY=sb_secret_...
ADMIN_EMAILS=your-admin-email@example.com
CORS_ORIGIN=http://localhost:5500
PORT=4000
```

`SUPABASE_SECRET_KEY` or the legacy `SUPABASE_SERVICE_ROLE_KEY` must stay server-side. Never put it in the admin-panel frontend.

## Install and run

```bash
npm install
npm start
```

Health:

`GET /health`

Admin login:

`POST /auth/login`

Admin refresh:

`POST /auth/refresh`

All admin endpoints require:

```http
Authorization: Bearer <SUPABASE_ACCESS_TOKEN>
```

The token's Supabase user email must be present in `ADMIN_EMAILS`.

## Admin endpoints

See `ADMIN_API.md` for the complete endpoint list and request formats.

## Important

Create the admin user in Supabase Auth first, then put that exact email in `ADMIN_EMAILS`.

Example:

```env
ADMIN_EMAILS=admin@example.com,another-admin@example.com
```

## Database/Admin fixes applied (2026-09-10)

- Diagnostics now reads `app_config.key` instead of `app_config.id`.
- Added null guards after admin PATCH updates.
- Added safe optional positive-integer parsing for set-question positions.
- Set-question replacement now checks delete errors.
- Added question/set exam relation validation and subject/exam + topic relation validation.
- Added question-create missing-row guard and cleanup on post-insert failures.
- Question image URL changes now synchronize `has_image` unless explicitly supplied.
- Added strict string-aware boolean parsing (`"false"` no longer becomes `true`).
- Added cleanup of `set_questions` before deleting a failed set create.
- Bulk question creation now validates relations and cleans inserted rows if counter refresh fails.
- Improved `23503` foreign-key error messaging and default unexpected DB errors to HTTP 500.
- Existing media bucket privacy is warned about instead of silently assumed public.
- Exam PATCH now accepts either exam `id` or `code` (id takes precedence).
- Server still requires a privileged Supabase secret/service-role key; never expose it in the frontend.

Before deployment, verify that `updated_at` exists in every table where the server writes it: `exams`, `sets`, `questions`, `banners`, `subscription_plans`, `market_products`, and `app_config`.

