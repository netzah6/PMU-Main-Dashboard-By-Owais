# PMU Dashboard — Setup Guide

## 1. Environment Variables

Copy `.env.local` and fill in your real values:

```
NEXT_PUBLIC_SUPABASE_URL=https://heglznxmldngkfqwvjvx.supabase.co
NEXT_PUBLIC_SUPABASE_ANON_KEY=<from Supabase dashboard → Settings → API>
SUPABASE_SERVICE_ROLE_KEY=<from Supabase dashboard → Settings → API>
GOOGLE_SERVICE_ACCOUNT_EMAIL=<not used yet — for future sheet sync>
GOOGLE_PRIVATE_KEY=<not used yet>
SHEET1_ID=1n2x8dol-PYiiVn9KkM9bFohekkQKQkzydANkHCj97MY
SHEET2_ID=1GhWsh1ndfbM0i5ig3ChYts3qhGIOYjrKOxZSyO4UKvE
SHEET3_ID=176PfO14yB7bBGUlDHOqm3qTYYMC9UaqadT_DSlXhX4g
SHEET4_ID=1d1oesPrzDhOGTWV2A3O7bo1XB8NeOwUEvKZ5hlUFsVE
GHL_API_KEY=pit-d404ce7f-7a4f-4130-84ed-06740a051cd6
GHL_LOCATION_ID=SfpNMJ5YU9lBkxss47lK
CRON_SECRET=<generate a random string — e.g. openssl rand -hex 32>
```

## 2. Supabase Setup

1. Go to Supabase dashboard → SQL Editor
2. Paste and run the contents of `supabase/schema.sql`
3. This creates all 14 tables, RLS policies, and enables Realtime

## 3. Create Admin User

1. In Supabase dashboard → Authentication → Users → Invite User
2. Enter `Nicolad@pmu-bookings.com` and send invite
3. After user accepts, get their UUID from the Users table
4. Run in SQL Editor:
   ```sql
   INSERT INTO user_roles (user_id, email, role)
   VALUES ('<UUID>', 'Nicolad@pmu-bookings.com', 'admin');
   ```
5. Repeat for `Stephanie@pmu-bookings.com` with role `editor`

## 4. Deploy to Vercel

```bash
npm install -g vercel
vercel --prod
```

Add all environment variables in Vercel dashboard → Project → Settings → Environment Variables.

The `vercel.json` cron job runs every 15 minutes at `/api/cron/sync`.  
Set `CRON_SECRET` in Vercel env vars and Vercel will send it as Bearer token.

## 5. Google Apps Script (onEdit Webhook)

1. Open `google-apps-script/onEdit.gs`
2. Update `VERCEL_WEBHOOK_URL` with your Vercel deployment URL
3. Open each Google Sheet → Extensions → Apps Script
4. Paste the script and save
5. Add a trigger: Edit → On edit → onEdit function
6. Authorize and test with the `testWebhook()` function

**Install on these spreadsheets:**
- SHEET1: Clients Master, Leads Master, Deposits, Outgoing Calls, Bookings, Signed Agreements
- SHEET2: LTV Sheet1, LTV Sheet2
- SHEET3: Add Data - Tracking (Performance)
- SHEET4: 7 Days CPL, 14 Days CPL, All Time Campaign Budget

## 6. Populate Data

Since Google Sheets write-back is stubbed, populate Supabase directly by:
- Running a one-time import script reading from Sheets and inserting rows
- Or manually via Supabase Table Editor (import CSV)

Each row format: `{ id: <row_number>, data: { ...all_column_values } }`

## 7. URL Structure

| URL | Tab |
|-----|-----|
| `/clients` | Clients (default) |
| `/performance` | Performance |
| `/deposits` | Deposits |
| `/bookings` | Bookings |
| `/leads` | Leads |
| `/calls` | Outgoing Calls |
| `/agreements` | Agreements |
| `/cpl-7days` | CPL 7 Days |
| `/cpl-14days` | CPL 14 Days |
| `/budget` | Campaign Budget |
| `/ltv` | LTV |
| `/map` | US Map |
| `/settings` | User Management (admin only) |
| `/login` | Login |

## 8. Local Development

```bash
npm run dev
# Open http://localhost:3000
```
