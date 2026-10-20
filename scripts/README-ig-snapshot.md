# Weekly Instagram-feed snapshot (`scripts/ig-snapshot.mjs`)

Part of the **IG feed watch** (owner, 10/15/2026): the dashboard tracks each
funnel's weekly deposit rate next to what the client's Instagram feed looked
like that week. This script takes the weekly picture of the feed. It runs on
the **Mac Mini**, not on Vercel, because it needs a real browser.

Nothing here changes a client's funnel. Showing the best-run posts on a
funnel ("Freeze feed") is always a click in the dashboard.

## What it does

For every **live** B2C one-box funnel with an Instagram widget (and the
widget not turned off in the dashboard):

1. Loads the Elfsight widget in headless Chromium from a tiny local page
   (the platform script does not run from a `file://` page). Elfsight's
   posts API needs a login and is never called; the widget draws the post
   images itself, so the script reads them out of the rendered page
   (including the shadow DOM new-style widgets render into).
2. Keeps up to 12 post images in feed order (avatars skipped, duplicates
   removed), downloads each one and uploads a copy to the public Storage
   bucket `onebox-ig` at `<slug>/<YYYY-MM-DD>/<n>.jpg`. Instagram's own
   links expire within days; our copies do not.
3. Reads the account's **post count** and **followers** from Elfsight's two
   public endpoints (boot + profile). Unknown comes back as empty, never 0.
4. Writes ONE `ig_snapshots` row per funnel per day (`source =
   weekly-playwright`). Re-running on the same day replaces that day's row;
   it never duplicates.

A funnel snapped less than 6 days ago is skipped, so the weekly job can be
re-run safely. `--force` ignores that rule. One widget per page load, up to
60 s each; a healthy funnel takes about 7 s.

Exit code is 1 only when every attempted funnel failed (or when Playwright,
Chromium or the Supabase keys are missing), so launchd/cron logs show a
real failure, not a quiet week.

## One-time setup on the Mac Mini

1. Node 20 or newer (`node -v`).
2. Repo checked out with its `.env.local` in place (it needs
   `NEXT_PUBLIC_SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY`; they can also
   be set in the environment, or point `ENV_FILE=/path/to/.env.local`).
3. From the repo root:

   ```sh
   npm install
   npm i -D playwright && npx playwright install chromium
   git checkout -- package.json package-lock.json
   ```

   Playwright is deliberately **not** a project dependency (Vercel must not
   install a browser). The `git checkout` line keeps `package.json` clean;
   the package stays in `node_modules` and Chromium lives in
   `~/Library/Caches/ms-playwright`. After a `git pull` + `npm install`,
   run the install line again (quick — Chromium is already cached). The
   script prints that exact line and exits 1 whenever either piece is
   missing.

## Manual runs (do these first)

From the repo root:

```sh
# 1. Render one funnel, print what it found, write nothing
node scripts/ig-snapshot.mjs --dry --limit 1

# 2. Real run for one funnel, even if it was snapped this week
node scripts/ig-snapshot.mjs --slug a-natural-beautie --force

# 3. Everything that is due
node scripts/ig-snapshot.mjs
```

Flags: `--slug <slug>` (one funnel), `--limit <n>` (first n due funnels),
`--dry` (render + report only), `--force` (ignore the 6-day rule). Each
funnel prints one line: `slug · n images · posts · ms`, then a summary.

## Weekly schedule: launchd (Monday 5:00 AM local)

Save as `~/Library/LaunchAgents/com.pmucare.ig-snapshot.plist`, replacing
the repo path if the checkout lives elsewhere. It runs through a login
shell so the usual `node` (Homebrew or nvm) is found.

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.pmucare.ig-snapshot</string>
  <key>ProgramArguments</key>
  <array>
    <string>/bin/zsh</string>
    <string>-lc</string>
    <string>cd "/Users/netzahmizrahi/Run Claude Code Here/pmu-dashboard" &amp;&amp; node scripts/ig-snapshot.mjs</string>
  </array>
  <key>StartCalendarInterval</key>
  <dict>
    <key>Weekday</key>
    <integer>1</integer>
    <key>Hour</key>
    <integer>5</integer>
    <key>Minute</key>
    <integer>0</integer>
  </dict>
  <key>StandardOutPath</key>
  <string>/Users/netzahmizrahi/Library/Logs/ig-snapshot.log</string>
  <key>StandardErrorPath</key>
  <string>/Users/netzahmizrahi/Library/Logs/ig-snapshot.log</string>
  <key>RunAtLoad</key>
  <false/>
</dict>
</plist>
```

Then:

```sh
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.pmucare.ig-snapshot.plist
launchctl kickstart gui/$(id -u)/com.pmucare.ig-snapshot   # run it once now to test
tail -f ~/Library/Logs/ig-snapshot.log
```

To remove: `launchctl bootout gui/$(id -u)/com.pmucare.ig-snapshot`.

If the Mini is asleep at 5:00, launchd runs the job when it wakes; if it is
powered off, that week is skipped (the next run catches up — the 6-day
rule only skips funnels snapped recently). Keep the Mini set to never
sleep, or add a "wake" schedule in System Settings → Energy.

### Crontab alternative

`crontab -e`, then (one line, repo path quoted; use the full path from
`which node`):

```
0 5 * * 1 cd "/Users/netzahmizrahi/Run Claude Code Here/pmu-dashboard" && /opt/homebrew/bin/node scripts/ig-snapshot.mjs >> "$HOME/Library/Logs/ig-snapshot.log" 2>&1
```

## Checking the results

- **Dashboard**: Cost/Deposit tab → the client's Funnel-setup card shows
  the latest snapshot date, post count and the posts themselves (next to
  the best-run set when one is recorded).
- **SQL** (Supabase → SQL editor, project `rtmiakhhohhfaqghieri`):

  ```sql
  select slug, taken_at, array_length(imgs, 1) as images, posts_count, followers
  from ig_snapshots
  where source = 'weekly-playwright'
  order by taken_at desc, slug;
  ```

  One row per funnel per run day is right; the same slug twice on one day
  is a bug.
- **Storage**: Supabase → Storage → `onebox-ig` → `<slug>/<date>/0.jpg …`.
  Every URL in `imgs` is a public link into that folder.
- **Log**: `~/Library/Logs/ig-snapshot.log` (launchd) — the last block
  ends with `Summary: N ok, N failed, N skipped`.

## Common failures

| Message / symptom | Meaning | Fix |
| --- | --- | --- |
| `Playwright is not installed` / `Chromium for Playwright is not installed` | the package or the browser is missing (often after `npm install` pruned it) | run `npm i -D playwright && npx playwright install chromium`, then `git checkout -- package.json package-lock.json` |
| `Missing NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY` | `.env.local` not found next to the repo | copy it in, or set `ENV_FILE=/path/to/.env.local` |
| `Nothing to do — every funnel was skipped` | everything was snapped in the last 6 days | expected mid-week; `--force` to snapshot anyway |
| `slug · FAILED · no post images rendered within 60 s` | widget showed nothing: Elfsight account paused, Instagram source disconnected or private, or no internet | open `https://<widget-id>.elf.site` in a browser; fix the widget in Elfsight; re-run with `--slug x --force` |
| `slug · skipped — widget is turned off` | the dashboard's "Turn widget off" is active for this client | nothing to do; that funnel shows no feed |
| `posts ?` on a line | Elfsight's public profile lookup returned nothing (404 / schema change) | images are still stored; post count stays empty for that week |
| `skip image … not an image` | one post's CDN link expired between render and download | harmless; the row keeps the other images |
| `upload …: new row violates row-level security` | the key in `.env.local` is not the service-role key | use `SUPABASE_SERVICE_ROLE_KEY` from Supabase → Settings → API |
| job never ran (empty log) | agent not loaded, or Mini was off | `launchctl print gui/$(id -u)/com.pmucare.ig-snapshot`; re-bootstrap the plist |
