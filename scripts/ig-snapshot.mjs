#!/usr/bin/env node
/* Weekly Instagram-feed snapshot for the one-box funnels (IG feed watch,
   owner 2026-10-15). Runs on a Mac, NOT on Vercel: it needs a real
   browser. Elfsight's posts API needs auth (never called); the widget
   renders the post images client-side, so we load the widget in headless
   Chromium, read the image URLs out of the rendered DOM (new-schema
   widgets render into shadow DOM), download each image, upload the copies
   to the public Storage bucket `onebox-ig` under <slug>/<date>/<n>.jpg and
   write ONE ig_snapshots row per funnel per day (replace, never duplicate).
   Post count + followers come from the two PUBLIC Elfsight endpoints.

   Nothing here touches a client's funnel: freezing a feed to a snapshot is
   always an explicit click in the dashboard.

   Usage (from the repo root, Node 20+):
     node scripts/ig-snapshot.mjs                 # every live funnel due for a snapshot
     node scripts/ig-snapshot.mjs --dry --limit 1 # render + report, write nothing
     node scripts/ig-snapshot.mjs --slug x --force
   Flags: --slug <slug> | --limit <n> | --dry | --force (ignore the 6-day rule)
   Setup: see scripts/README-ig-snapshot.md */

import { readFileSync, existsSync } from "node:fs";
import { createServer } from "node:http";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createClient } from "@supabase/supabase-js";

const INSTALL = "npm i -D playwright && npx playwright install chromium";
const BUCKET = "onebox-ig";
const SOURCE = "weekly-playwright";
const MIN_AGE_DAYS = 6; // a funnel snapped < 6 days ago is skipped (unless --force)
const WIDGET_TIMEOUT_MS = 60_000; // per widget
const POLL_MS = 2_000;
const MIN_IMAGES = 3;
const MAX_IMAGES = 12;
const DOWNLOAD_TIMEOUT_MS = 20_000;

/* ---------- flags ---------- */
const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const opt = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const ONLY_SLUG = opt("--slug");
const LIMIT = opt("--limit") ? Number(opt("--limit")) : Infinity;
const DRY = flag("--dry");
const FORCE = flag("--force");
if (opt("--limit") && !(LIMIT > 0)) {
  console.error("--limit needs a positive number");
  process.exit(1);
}

/* ---------- env (.env.local or process.env) ---------- */
const __dirname = dirname(fileURLToPath(import.meta.url));
const ENV_FILES = [
  process.env.ENV_FILE,
  join(__dirname, "..", ".env.local"),
  "/Users/netzahmizrahi/Run Claude Code Here/pmu-dashboard/.env.local",
].filter(Boolean);
const env = { ...process.env };
const envFile = ENV_FILES.find((f) => existsSync(f));
if (envFile) {
  for (const line of readFileSync(envFile, "utf8").split("\n")) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (m && !process.env[m[1]]) env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
}
const SB_URL = env.NEXT_PUBLIC_SUPABASE_URL;
const SB_KEY = env.SUPABASE_SERVICE_ROLE_KEY;
if (!SB_URL || !SB_KEY) {
  console.error("Missing NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY (set them in .env.local or the environment).");
  process.exit(1);
}
const svc = createClient(SB_URL, SB_KEY, { auth: { persistSession: false } });

/* ---------- playwright (installed by the operator, never a dependency here) ---------- */
let chromium;
try {
  ({ chromium } = await import("playwright"));
} catch {
  console.error(`Playwright is not installed. Run:\n  ${INSTALL}`);
  process.exit(1);
}

/* ---------- helpers ---------- */
const pad = (n) => String(n).padStart(2, "0");
const localToday = () => {
  const d = new Date();
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
};
const TODAY = localToday();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 32-hex (bare, dashed, or inside https://<hex>.elf.site) → 8-4-4-4-12, or null. */
function widgetId(raw) {
  const s = String(raw ?? "");
  const hex = (s.match(/([a-f0-9]{32})/i)?.[1] ?? s.match(/([a-f0-9-]{36})/i)?.[1] ?? "").replace(/-/g, "").toLowerCase();
  if (hex.length !== 32) return null;
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** Post count + followers from Elfsight's PUBLIC boot + profile endpoints
    (mirrors elfsightProfile in src/lib/ig-feed-watch.ts). null = unknown;
    a 404 profile comes back as `{payload: []}` and is treated as unknown. */
async function elfsightProfile(id, pageUrl = "https://book.pmu-care.com/") {
  try {
    const boot = await (
      await fetch(`https://core.service.elfsight.com/p/boot/?page=${encodeURIComponent(pageUrl)}&w=${id}`, {
        signal: AbortSignal.timeout(10_000),
      })
    ).json();
    const settings = boot?.data?.widgets?.[id]?.data?.settings;
    const raw =
      settings?.dataServiceSource?.[0]?.name ??
      settings?.sources?.[0]?.source?.replace(/^https?:\/\/(www\.)?instagram\.com\//i, "").replace(/\/.*$/, "") ??
      "";
    const username = String(raw).replace(/^@/, "").trim();
    if (!username || /^instagram$/i.test(username)) return null;
    const prof = await (
      await fetch(`https://widget-data.service.elfsight.com/api/instagram/profile?username=${encodeURIComponent(username)}`, {
        signal: AbortSignal.timeout(10_000),
      })
    ).json();
    const d = prof?.payload;
    if (!d || typeof d !== "object" || Array.isArray(d)) return { username, postsCount: null, followers: null };
    return {
      username,
      postsCount: typeof d.postsCount === "number" ? d.postsCount : null,
      followers: typeof d.followersCount === "number" ? d.followersCount : null,
    };
  } catch {
    return null;
  }
}

/** Every eligible funnel: live, B2C (not extras.template "b2b"), widget not
    turned off, with a valid widget id. onebox_clients has no id column, so
    the pages are ordered by slug. */
async function loadFunnels() {
  const out = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await svc
      .from("onebox_clients")
      .select("slug, client_name, status, config, extras")
      .order("slug")
      .range(from, from + 999);
    if (error) throw new Error(`onebox_clients: ${error.message}`);
    for (const r of data ?? []) {
      const cfg = r.config ?? {};
      const ex = r.extras ?? {};
      out.push({
        slug: r.slug,
        name: r.client_name ?? r.slug,
        status: r.status,
        b2b: ex.template === "b2b",
        widgetOff: !!ex.igWidgetOff,
        id: widgetId(cfg.igWidget || cfg.elfsightId || ex.elfsightId || ""),
      });
    }
    if (!data || data.length < 1000) break;
  }
  return out;
}

/** Newest ig_snapshots.taken_at per slug (paginated by id — Supabase caps a
    select at 1,000 rows). */
async function loadNewestSnapshots() {
  const newest = new Map();
  for (let from = 0; ; from += 1000) {
    const { data, error } = await svc
      .from("ig_snapshots")
      .select("slug, taken_at")
      .order("id")
      .range(from, from + 999);
    if (error) throw new Error(`ig_snapshots: ${error.message}`);
    for (const r of data ?? []) {
      const cur = newest.get(r.slug);
      if (!cur || r.taken_at > cur) newest.set(r.slug, r.taken_at);
    }
    if (!data || data.length < 1000) break;
  }
  return newest;
}

const daysBetween = (a, b) => Math.round((Date.parse(b) - Date.parse(a)) / 864e5);

/* ---------- local page server (file:// pages don't run the platform script) ---------- */
function widgetPage(id) {
  return `<!doctype html><html><head><meta charset="utf-8"><title>ig ${id}</title></head><body>` +
    `<script src="https://static.elfsight.com/platform/platform.js"></script>` +
    `<div class="elfsight-app-${id}"></div></body></html>`;
}
const server = createServer((req, res) => {
  const m = (req.url ?? "").match(/^\/w\/([a-f0-9-]{36})$/);
  if (!m) {
    res.writeHead(404);
    res.end();
    return;
  }
  res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
  res.end(widgetPage(m[1]));
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const PORT = server.address().port;

/* Runs INSIDE the page: every <img> (and CSS background image) that is an
   Elfsight-proxied or Instagram-CDN post image, walking shadow roots
   recursively (new-schema widgets render inside es-embed-root's shadow
   DOM). Avatars (s150x150, Instagram's profile-picture path) are skipped;
   dedupe on the FULL src; DOM order; up to 12. */
const EXTRACT = (max) => {
  const out = [];
  const seen = new Set();
  const isPost = (src) =>
    /^https:\/\/(phosphor\.utils\.elfsightcdn\.com\/\?url=|[^/]*cdninstagram\.com\/)/i.test(src) &&
    !/s150x150/i.test(src) &&
    !/t51\.2885-19/i.test(src);
  const push = (src) => {
    if (!src || seen.has(src) || !isPost(src)) return;
    seen.add(src);
    out.push(src);
  };
  const walk = (root) => {
    for (const el of root.querySelectorAll("*")) {
      if (el.tagName === "IMG") push(el.currentSrc || el.src || el.getAttribute("src") || "");
      const bg = getComputedStyle(el).backgroundImage || "";
      const m = bg.match(/url\(["']?(https?:[^"')]+)["']?\)/);
      if (m) push(m[1]);
      if (el.shadowRoot) walk(el.shadowRoot);
    }
  };
  walk(document);
  return out.slice(0, max);
};

async function renderWidget(browser, id) {
  const page = await browser.newPage({ viewport: { width: 1280, height: 3000 } });
  try {
    await page.goto(`http://127.0.0.1:${PORT}/w/${id}`, { waitUntil: "domcontentloaded", timeout: 30_000 });
    const deadline = Date.now() + WIDGET_TIMEOUT_MS;
    let imgs = [];
    while (Date.now() < deadline) {
      imgs = await page.evaluate(EXTRACT, MAX_IMAGES);
      if (imgs.length >= MIN_IMAGES) break;
      await sleep(POLL_MS);
    }
    if (imgs.length >= MIN_IMAGES && imgs.length < MAX_IMAGES) {
      // one more poll so the rest of the grid can finish loading
      await sleep(POLL_MS);
      const more = await page.evaluate(EXTRACT, MAX_IMAGES);
      if (more.length > imgs.length) imgs = more;
    }
    return imgs;
  } finally {
    await page.close().catch(() => {});
  }
}

/** Follows redirects, 20 s timeout, must come back as an image. */
async function download(src) {
  const r = await fetch(src, { redirect: "follow", signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS) });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  const type = r.headers.get("content-type") ?? "";
  if (!type.startsWith("image/")) throw new Error(`not an image (${type || "no content-type"})`);
  const buf = Buffer.from(await r.arrayBuffer());
  if (!buf.length) throw new Error("empty body");
  return buf;
}

async function snapshotFunnel(browser, f) {
  const t0 = Date.now();
  const [imgs, profile] = await Promise.all([renderWidget(browser, f.id), elfsightProfile(f.id)]);
  if (!imgs.length) throw new Error("no post images rendered within 60 s");

  const bodies = [];
  for (const src of imgs) {
    try {
      bodies.push(await download(src));
    } catch (e) {
      console.log(`    skip image ${src.slice(0, 80)}… — ${e.message}`);
    }
  }
  if (!bodies.length) throw new Error(`rendered ${imgs.length} images but none could be downloaded`);

  const postsCount = profile?.postsCount ?? null;
  const followers = profile?.followers ?? null;
  const ms = Date.now() - t0;
  if (DRY) {
    return { n: bodies.length, rendered: imgs.length, postsCount, followers, ms, urls: imgs };
  }

  const urls = [];
  for (let n = 0; n < bodies.length; n++) {
    const path = `${f.slug}/${TODAY}/${n}.jpg`;
    const { error } = await svc.storage.from(BUCKET).upload(path, bodies[n], { upsert: true, contentType: "image/jpeg" });
    if (error) throw new Error(`upload ${path}: ${error.message}`);
    urls.push(svc.storage.from(BUCKET).getPublicUrl(path).data.publicUrl);
  }

  // Replace, never duplicate: one row per (slug, day).
  const { error: delErr } = await svc.from("ig_snapshots").delete().eq("slug", f.slug).eq("taken_at", TODAY);
  if (delErr) throw new Error(`delete old row: ${delErr.message}`);
  const { error: insErr } = await svc.from("ig_snapshots").insert({
    slug: f.slug,
    taken_at: TODAY,
    imgs: urls,
    posts_count: postsCount,
    followers,
    source: SOURCE,
  });
  if (insErr) throw new Error(`insert: ${insErr.message}`);
  return { n: urls.length, rendered: imgs.length, postsCount, followers, ms: Date.now() - t0, urls };
}

/* ---------- main ---------- */
const fmtCount = (v) => (v == null ? "posts ?" : `${v} posts`);
let exitCode = 0;
let browser;
try {
  const [funnels, newest] = await Promise.all([loadFunnels(), loadNewestSnapshots()]);

  let queue = funnels;
  if (ONLY_SLUG) {
    queue = funnels.filter((f) => f.slug === ONLY_SLUG);
    if (!queue.length) throw new Error(`no one-box client with slug "${ONLY_SLUG}"`);
  }

  const skipped = [];
  const todo = [];
  let overLimit = 0;
  for (const f of queue) {
    let why = null;
    if (f.status !== "live") why = `status is "${f.status}"`;
    else if (f.b2b) why = "B2B funnel";
    else if (!f.id) why = "no Instagram widget id";
    else if (f.widgetOff) why = "widget is turned off";
    else if (!FORCE && newest.has(f.slug) && daysBetween(newest.get(f.slug), TODAY) < MIN_AGE_DAYS) {
      why = `snapshot from ${newest.get(f.slug)} is < ${MIN_AGE_DAYS} days old (use --force)`;
    }
    if (why) skipped.push({ f, why });
    else if (todo.length < LIMIT) todo.push(f);
    else overLimit++;
  }

  if (ONLY_SLUG) for (const s of skipped) console.log(`${s.f.slug} · skipped — ${s.why}`);
  console.log(
    `${DRY ? "[dry run] " : ""}${todo.length} funnel(s) to snapshot, ${skipped.length} skipped` +
      (overLimit ? `, ${overLimit} left out by --limit ${LIMIT}` : "") +
      ` · ${TODAY}`,
  );

  if (todo.length) {
    try {
      browser = await chromium.launch({ headless: true });
    } catch (e) {
      const msg = String(e?.message ?? e);
      if (/Executable doesn't exist|playwright install/i.test(msg)) {
        console.error(`Chromium for Playwright is not installed. Run:\n  ${INSTALL}`);
        process.exit(1);
      }
      throw e;
    }

    let ok = 0;
    let failed = 0;
    for (const f of todo) {
      try {
        const r = await snapshotFunnel(browser, f);
        ok++;
        console.log(`${f.slug} · ${r.n} images · ${fmtCount(r.postsCount)} · ${r.ms} ms`);
        if (DRY) for (const u of r.urls) console.log(`    ${u.length > 110 ? u.slice(0, 110) + "…" : u}`);
      } catch (e) {
        failed++;
        console.log(`${f.slug} · FAILED · ${e?.message ?? e}`);
      }
    }
    console.log(`\nSummary: ${ok} ok, ${failed} failed, ${skipped.length} skipped${DRY ? " (dry run — nothing written)" : ""}`);
    if (todo.length && ok === 0) exitCode = 1;
  } else {
    console.log("Nothing to do — every funnel was skipped (run again with --force to snapshot anyway).");
  }
} catch (e) {
  console.error(`Error: ${e?.message ?? e}`);
  exitCode = 1;
} finally {
  if (browser) await browser.close().catch(() => {});
  server.close();
}
process.exit(exitCode);
