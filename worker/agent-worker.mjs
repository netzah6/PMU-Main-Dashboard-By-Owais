#!/usr/bin/env node
// PMU AI agent — browser worker for the Mac Mini.
//
// Every 30 s it asks the dashboard for the next APPROVED task, then has
// Claude Code do it in a real Chrome (Playwright MCP, its own signed-in
// profile) on the same GoHighLevel screens a teammate uses, screenshots the
// result, and reports back. The dashboard then texts the owner.
//
//   node agent-worker.mjs login   → opens the worker's Chrome to sign in to GHL + Gmail once (then Cmd+Q)
//   node agent-worker.mjs once    → do at most one task, then exit (testing)
//   node agent-worker.mjs         → run forever (launchd keeps it alive)
//
// Config: ~/.pmu-agent/.env  (DASHBOARD_URL, AGENT_WORKER_SECRET)

import { spawn, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, readlinkSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir, hostname } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const HOME = join(homedir(), ".pmu-agent");
const PROFILE = join(HOME, "chrome-profile");
const RUNS = join(HOME, "runs");
const TASK_TIMEOUT_MS = 45 * 60_000; // the dashboard re-queues after 50 min (batched setup cards, 10/21/2026)
const POLL_MS = 30_000;
mkdirSync(RUNS, { recursive: true });

const env = {};
const envFile = join(HOME, ".env");
if (existsSync(envFile)) for (const l of readFileSync(envFile, "utf8").split("\n")) {
  const m = l.match(/^([A-Z0-9_]+)=(.*)$/); if (m) env[m[1]] = m[2].trim().replace(/^["']|["']$/g, "");
}
const BASE = (env.DASHBOARD_URL || "https://pmu-main-dashboard-by-owais1.vercel.app").replace(/\/$/, "");
const SECRET = env.AGENT_WORKER_SECRET;
const CLAUDE = env.CLAUDE_BIN || "claude";
const log = (...a) => console.log(new Date().toISOString(), ...a);

// ── One Chrome profile, one cookie key (10/20/2026) ──────────────────────────
// GoHighLevel + Gmail sign-ins vanished "every few days". Root cause: Playwright
// launches Chrome with --use-mock-keychain (a fixed cookie-encryption key),
// while `agent-worker.mjs login` and any hand-opened Chrome encrypt with the
// real macOS Keychain key. On startup Chrome deletes every cookie it cannot
// decrypt, so each switch between the two wiped the whole jar (reproduced on a
// scratch profile: real→mock 1→0 cookies, mock→real 1→0, real→real 1→1). Now:
//  • the worker's Chrome keeps the default (real Keychain) key — see
//    PW_IGNORE_DEFAULT_ARGS — and the login command launches the very same
//    binary with the very same flags, so what a human signs in is what the
//    worker finds;
//  • a Chrome that someone left open on the profile no longer blocks every task
//    for hours: a fresh one (login in progress) makes the worker wait, an old
//    stray one is asked to quit (SIGTERM = Chrome's normal "session ended"
//    shutdown, never a kill);
//  • Chrome-level Google sign-in is switched off in the profile (web Gmail still
//    works), so Chrome's account reconcilor can never log the mailbox out.
const WORKER_VERSION = 3; // self-update refuses to downgrade below this
const CHROME_BIN = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const LOGIN_LOCK = join(HOME, "login.lock");
const CHROME_ARGS = ["--lang=en-US", "--no-first-run", "--no-default-browser-check", "--disable-sync", "--password-store=basic"];
// Dropped from Playwright's defaults: --use-mock-keychain (the cookie-key
// mismatch above) and --enable-automation (Google blocks sign-in on browsers
// that advertise automation; the agent's own sign-in recovery needs it off).
const PW_IGNORE_DEFAULT_ARGS = ["--use-mock-keychain", "--enable-automation"];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// pid of the Chrome that currently owns the profile (Chrome's SingletonLock is a
// symlink to "<host>-<pid>"), or 0 when the profile is free.
function chromePidOnProfile() {
  try {
    const pid = Number(readlinkSync(join(PROFILE, "SingletonLock")).split("-").pop());
    if (!pid) return 0;
    const cmd = spawnSync("ps", ["-o", "command=", "-p", String(pid)], { encoding: "utf8" }).stdout || "";
    return cmd.includes("Google Chrome") && cmd.includes(PROFILE) ? pid : 0;
  } catch { return 0; }
}
function processAgeMs(pid) {
  const et = (spawnSync("ps", ["-o", "etime=", "-p", String(pid)], { encoding: "utf8" }).stdout || "").trim(); // [[dd-]hh:]mm:ss
  if (!et) return 0;
  const [days, hms] = et.includes("-") ? et.split("-") : ["0", et];
  const parts = hms.split(":").map(Number); while (parts.length < 3) parts.unshift(0);
  return (((Number(days) * 24 + parts[0]) * 60 + parts[1]) * 60 + parts[2]) * 1000;
}
function alive(pid) { try { process.kill(pid, 0); return true; } catch { return false; } }
async function waitForExit(pid, ms) {
  const until = Date.now() + ms;
  while (alive(pid)) { if (Date.now() > until) return false; await sleep(500); }
  return true;
}
function loginInProgress() {
  try { return Date.now() - statSync(LOGIN_LOCK).mtimeMs < 2 * 60 * 60_000; } catch { return false; } // a lock older than 2 h is stale
}
// True when a task may start. Never claims a task while a human may be signing
// in; quits a forgotten Chrome instead of failing tasks for hours (10/17 lost a
// whole day to "Browser is already in use").
async function profileReady() {
  const pid = chromePidOnProfile();
  if (!pid) { hardenProfile(); return true; }
  if (loginInProgress() || processAgeMs(pid) < 10 * 60_000) {
    log(`waiting: Chrome pid ${pid} has the worker profile open (sign-in in progress?) — quit it with Cmd+Q when done`);
    return false;
  }
  log(`stray Chrome pid ${pid} holds the worker profile — asking it to quit`);
  try { process.kill(pid, "SIGTERM"); } catch { /* already gone */ }
  if (!(await waitForExit(pid, 20_000))) { log(`Chrome pid ${pid} did not quit — tasks wait`); return false; }
  hardenProfile();
  return true;
}
// Only touched while no Chrome has the profile open. Turns Chrome-level Google
// sign-in off (signin.allowed_on_next_startup — Chrome copies it into
// signin.allowed on its next start), clears the "didn't shut down correctly"
// restore bubble, and keeps the profile folder private (cookies live in it).
function hardenProfile() {
  try { chmodSync(PROFILE, 0o700); } catch { /* fine */ }
  const prefFile = join(PROFILE, "Default", "Preferences");
  if (!existsSync(prefFile)) return;
  try {
    const p = JSON.parse(readFileSync(prefFile, "utf8"));
    const changes = [];
    p.signin ??= {};
    if (p.signin.allowed_on_next_startup !== false) { p.signin.allowed_on_next_startup = false; changes.push("Chrome sign-in off"); }
    p.profile ??= {};
    if (p.profile.exit_type && p.profile.exit_type !== "Normal") { changes.push(`exit_type ${p.profile.exit_type} → Normal`); p.profile.exit_type = "Normal"; }
    if (changes.length) { writeFileSync(prefFile + ".tmp", JSON.stringify(p)); renameSync(prefFile + ".tmp", prefFile); log("profile:", changes.join(", ")); }
  } catch (e) { log("profile hardening skipped —", e.message); }
}

// ── Self-healing (10/19/2026) ────────────────────────────────────────────────
// The worker sat alive-but-stuck for 16 h (no claim, no exit), so launchd's
// KeepAlive never kicked in. Rules now: every dashboard call has a hard
// timeout; a task that outlives its budget is SIGKILLed; and a watchdog
// exits the process when nothing has succeeded for a while — launchd then
// restarts it within seconds. While a task runs, a ping keeps the
// dashboard's "Mac Mini" pill green.
const API_TIMEOUT_MS = 30_000;
const IDLE_EXIT_MS = 15 * 60_000;   // no successful dashboard call for 15 min → restart
const TASK_HARD_MS = TASK_TIMEOUT_MS + 5 * 60_000; // task still alive 5 min past its budget → restart
let lastOk = Date.now();
let taskStartedAt = 0;

async function api(path, body) {
  const r = await fetch(`${BASE}/api/agent/worker/${path}`, {
    method: "POST", headers: { Authorization: `Bearer ${SECRET}`, "Content-Type": "application/json" }, body: JSON.stringify(body),
    signal: AbortSignal.timeout(API_TIMEOUT_MS),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`${path}: HTTP ${r.status} ${j.error ?? ""}`);
  lastOk = Date.now();
  return j;
}

// ── Self-update (owner, 10/19/2026: "no manual work on the Mini") ───────────
// Once an hour, while idle, fetch the worker script from the dashboard repo's
// main branch; if it changed and parses, swap it in and exit — launchd
// restarts the new one within seconds. Nobody has to touch the Mini again.
const SELF_URL = env.WORKER_UPDATE_URL || "https://raw.githubusercontent.com/netzah6/PMU-Main-Dashboard-By-Owais/main/worker/agent-worker.mjs";
const SELF_PATH = fileURLToPath(import.meta.url);
let lastUpdateCheck = 0;
let warnedOldRemote = false;
async function selfUpdate() {
  if (Date.now() - lastUpdateCheck < 60 * 60_000) return;
  lastUpdateCheck = Date.now();
  try {
    const r = await fetch(SELF_URL, { signal: AbortSignal.timeout(20_000), headers: { "cache-control": "no-cache" } });
    if (!r.ok) return;
    const next = await r.text();
    const me = readFileSync(SELF_PATH, "utf8");
    if (next === me || next.length < 4000 || !next.includes("agent-worker") || !next.includes("selfUpdate")) return;
    const remoteVersion = Number((next.match(/WORKER_VERSION = (\d+)/) || [])[1] || 0);
    if (remoteVersion < WORKER_VERSION) {
      if (!warnedOldRemote) log(`self-update: repo copy is v${remoteVersion || "?"}, this Mini runs v${WORKER_VERSION} — keeping local until worker/agent-worker.mjs on main is updated`);
      warnedOldRemote = true; return;
    }
    const tmp = join(HOME, "agent-worker.next.mjs");
    writeFileSync(tmp, next);
    if (spawnSync(process.execPath, ["--check", tmp]).status !== 0) { log("self-update: new script failed syntax check — kept current"); return; }
    renameSync(tmp, SELF_PATH);
    log("self-update: new worker installed — restarting");
    setTimeout(() => process.exit(0), 200); // launchd KeepAlive restarts it
  } catch (e) { log("self-update: skipped —", e.message); }
}

function die(reason) {
  log(`watchdog: ${reason} — exiting so launchd restarts the worker`);
  setTimeout(() => process.exit(1), 200);
}
setInterval(() => {
  if (taskStartedAt && Date.now() - taskStartedAt > TASK_HARD_MS) die("task ran past its hard limit");
  if (!taskStartedAt && Date.now() - lastOk > IDLE_EXIT_MS) die("no successful dashboard call in 15 min");
}, 60_000).unref();
process.on("unhandledRejection", (e) => die(`unhandled rejection: ${e instanceof Error ? e.message : e}`));
process.on("uncaughtException", (e) => die(`uncaught exception: ${e instanceof Error ? e.message : e}`));

function promptFor(t) {
  return `You are the PMU Bookings On Demand agency's back-office assistant. A manager APPROVED the task below. Do it in GoHighLevel using the browser tools, exactly like a careful teammate would, then report.

CLIENT: ${t.contact_name}${t.business_name ? ` (${t.business_name})` : ""}
SUB-ACCOUNT (location id): ${t.location_id}
Start here: https://app.gohighlevel.com/v2/location/${t.location_id}/dashboard

WHAT THE CLIENT ASKED / WHO ASKED:
"""
${t.client_message}
"""

THE APPROVED TASK — do these, in order:
${t.steps.map((s, i) => `${i + 1}. ${s}`).join("\n")}
${t.notes && !t.steps.includes(t.notes) ? `\nNotes: ${t.notes}\n` : ""}
RULES (never break these):
- Work ONLY inside sub-account ${t.location_id}. If the page shows a different account, switch to it or stop.
- Do only what the task says. Never delete anything unless the task explicitly says to delete it.
- NEVER send any message, email, text, or review request to anyone — with ONE exception: a message to GoHighLevel's own support chat when THE APPROVED TASK above explicitly tells you to send it (CNAM removal). Never touch billing, payment methods, or the agency settings.
- If the task is to produce a document (an export, a list, a report), save it in the current folder as .xlsx or .csv (or .pdf) and list it under "files" in your final JSON — the team downloads it from the dashboard and sends it themselves.
- SIGN-IN RECOVERY (owner, 10/19/2026 — do this yourself, do not stop): if GoHighLevel shows its login page, sign in with the saved credentials (Chrome pre-fills them; if the email field is empty use the account this Chrome's Gmail is signed in as — never invent a password; if there is no saved password, status "needs_teammate", summary "Mac Mini: no saved GoHighLevel password"). If it then asks to "Verify Security Code", open a NEW tab at https://mail.google.com/mail/u/0/#search/in%3Aanywhere+%22security+code%22 (this Chrome is signed in to the agent's mailbox; the code email usually lands in SPAM, which in:anywhere covers), open the NEWEST email from GoHighLevel / LeadConnector / HighLevel (sent within the last few minutes), read the 6-digit code, go back to the GoHighLevel tab, enter it, tick "trust this device / remember" if offered, and continue the task. If no code email appears after reloading the search 3 times a minute apart, status "needs_teammate", summary "Mac Mini: GoHighLevel security code never arrived". Never type the code anywhere except the GoHighLevel verification box.
- If you hit a CAPTCHA: stop, change nothing, status "needs_teammate", summary "Mac Mini hit a CAPTCHA on GoHighLevel".
- ALREADY DONE = DONE (owner 10/21/2026): if what the task asks for is already true on the screen (a switch already in the wanted state, a value already set, a thing already created), change nothing, take the proof screenshot and report status "done" with "already …" in the summary. Never report needs_teammate for a goal that is already met.
- If the task is unclear, risky, or the screen doesn't match what you expect: change nothing, status "needs_teammate", and explain why in one sentence.
- Calendars: GoHighLevel sets availability per staff member (calendar → Availability → the staff member → Weekly hours / Custom schedule). After saving, reload the page and confirm the new values are really there.

PROOF (required):
- Before changing anything, take a screenshot of the relevant settings screen and save it with filename "before-1.png".
- After saving, reload the page, check the change stuck, and take screenshot(s) "after-1.png" (and "after-2.png" etc. if needed) clearly showing the result.

When finished, reply with ONLY this JSON (no other text):
{"status":"done" | "failed" | "needs_teammate","summary":"<one plain sentence: what you did or why not>","steps":["<short line per thing you did, with before → after values>"],"screenshots":[{"file":"before-1.png","name":"Before: <what it shows>"},{"file":"after-1.png","name":"After: <what it shows>"}],"files":[{"file":"<name>.xlsx","name":"<what it is>"}]}   ("files" only when the task produced a document; else [])`;
}

function runClaude(prompt, dir) {
  // Browser always in English (US): GHL screens came up in Spanish, which
  // cost the agent turns reading every screen (10/16/2026). Same CHROME_ARGS
  // 200 turns (was 120): a snapshot load on Clean New Account 79 ran out of
  // turns while waiting for GHL to apply it (10/21/2026). The 20-min timeout
  // below is still the hard stop.
  // as the login command, and the real-Keychain cookie key (see top of file).
  const pwFile = join(dir, "playwright.json");
  writeFileSync(pwFile, JSON.stringify({ browser: { launchOptions: { args: CHROME_ARGS, ignoreDefaultArgs: PW_IGNORE_DEFAULT_ARGS }, contextOptions: { locale: "en-US" } } }));
  const mcp = { mcpServers: { playwright: { command: "npx", args: ["-y", "@playwright/mcp@0.0.83", "--config", pwFile, "--browser", "chrome", "--user-data-dir", PROFILE, "--output-dir", dir, "--viewport-size", "1440x900"], env: { LANG: "en_US.UTF-8", LANGUAGE: "en_US" } } } };
  const mcpFile = join(dir, "mcp.json");
  writeFileSync(mcpFile, JSON.stringify(mcp));
  return new Promise((resolve) => {
    const child = spawn(CLAUDE, ["-p", prompt, "--mcp-config", mcpFile, "--strict-mcp-config", "--allowedTools", "mcp__playwright", "--output-format", "json", "--max-turns", "400"], { cwd: dir, stdio: ["ignore", "pipe", "pipe"] });
    let out = "", err = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      // Claude + the Playwright MCP sometimes ignore SIGTERM; a minute later
      // force it, so "close" always fires and the task is reported.
      setTimeout(() => { try { child.kill("SIGKILL"); } catch { /* gone */ } }, 60_000).unref();
    }, TASK_TIMEOUT_MS);
    child.on("close", async (code) => {
      clearTimeout(timer); writeFileSync(join(dir, "claude-output.json"), out || err);
      await chromeGone(); // the MCP leaves Chrome to shut itself down; never start the next task on top of it
      resolve({ code, out, err });
    });
  });
}
// Wait (≤60 s) for the task's Chrome to leave the profile; nudge it with SIGTERM
// after 20 s. Chrome commits cookies every 30 s and on a normal quit, so a task
// that signed in minutes ago has long been saved by now.
async function chromeGone() {
  const pid = chromePidOnProfile();
  if (!pid) return;
  if (await waitForExit(pid, 20_000)) return;
  log(`Chrome pid ${pid} still open after the task — asking it to quit`);
  try { process.kill(pid, "SIGTERM"); } catch { /* gone */ }
  if (!(await waitForExit(pid, 40_000))) log(`Chrome pid ${pid} did not quit; the next poll will retry`);
}

function parseReport(out) {
  let text = out;
  try { const j = JSON.parse(out); text = String(j.result ?? ""); } catch { /* raw text */ }
  const m = text.match(/\{[\s\S]*"status"[\s\S]*\}/);
  if (!m) return null;
  try { return JSON.parse(m[0]); } catch { return null; }
}

async function doTask(t) {
  const dir = join(RUNS, `${new Date().toISOString().replace(/[:.]/g, "-")}-${t.id.slice(0, 8)}`);
  mkdirSync(dir, { recursive: true });
  log(`task ${t.id} — ${t.contact_name}: ${t.summary}`);
  taskStartedAt = Date.now();
  // Heartbeat while Claude works, so the dashboard knows the Mini is alive
  // mid-task (the claim ping only happens between tasks).
  const ping = setInterval(() => { api("ping", { host: hostname(), task: t.id }).catch(() => {}); }, 60_000);
  let code, out, err;
  try { ({ code, out, err } = await runClaude(promptFor(t), dir)); }
  finally { clearInterval(ping); taskStartedAt = 0; }
  const rep = parseReport(out);
  // Claude Code signed out / lost its session on the Mini: the owner must
  // re-sign in by hand, so say that instead of a vague "did not finish".
  const needsSignIn = !rep && /not logged in|please run \/login|authentication|invalid api key|unauthorized|oauth token/i.test(err || out);
  const status = needsSignIn ? "needs_teammate" : ["done", "failed", "needs_teammate"].includes(rep?.status) ? rep.status : "failed";
  const summary = needsSignIn
    ? "The Mac Mini's Claude is signed out — open Claude on the Mini, sign in again, and the task will retry"
    : rep?.summary || (code === null ? "Timed out after 45 minutes — check the account by hand" : `The browser run did not finish (${(err || out).slice(-200).trim() || `exit ${code}`})`);

  // Upload the screenshots it named, else any image it saved.
  const named = Array.isArray(rep?.screenshots) ? rep.screenshots : [];
  const images = readdirSync(dir).filter((f) => /\.(png|jpe?g)$/i.test(f));
  const list = named.length ? named.filter((s) => images.includes(s.file)) : images.sort().map((f) => ({ file: f, name: f.replace(/\.(png|jpe?g)$/i, "") }));
  const screenshots = [];
  for (const s of list.slice(0, 10)) {
    try {
      const { url } = await api("upload", { id: t.id, name: s.name, base64: readFileSync(join(dir, s.file)).toString("base64") });
      screenshots.push({ name: s.name, url });
    } catch (e) { log("upload failed", s.file, e.message); }
  }
  // Documents the task produced (named in the report, else any xlsx/csv/pdf it saved).
  const docFiles = readdirSync(dir).filter((f) => /\.(xlsx|csv|pdf|docx|txt)$/i.test(f));
  const namedDocs = Array.isArray(rep?.files) ? rep.files.filter((f) => docFiles.includes(f.file)) : [];
  const docList = namedDocs.length ? namedDocs : docFiles.map((f) => ({ file: f, name: f }));
  const files = [];
  for (const f of docList.slice(0, 10)) {
    try {
      const { url, bytes } = await api("upload", { id: t.id, kind: "file", name: f.file, base64: readFileSync(join(dir, f.file)).toString("base64") });
      files.push({ name: f.name || f.file, url, bytes });
    } catch (e) { log("file upload failed", f.file, e.message); }
  }
  await api("finish", { id: t.id, status, summary, steps: Array.isArray(rep?.steps) ? rep.steps : [], screenshots, files });
  log(`task ${t.id} → ${status} (${screenshots.length} screenshots, ${files.length} files)`);
}

async function loop(once) {
  if (!SECRET) { console.error(`Missing AGENT_WORKER_SECRET in ${envFile}`); process.exit(1); }
  log(`worker on ${hostname()} → ${BASE}`);
  let firstClaim = true;
  for (;;) {
    try {
      await selfUpdate(); // idle only: never mid-task
      if (!(await profileReady())) {
        await api("ping", { host: hostname() }); // still alive, just waiting for Chrome to be quit
        if (once) { log("profile busy"); return; }
      } else {
        // First claim after a (re)start: hand back any task the previous
        // process left "running" (watchdog / self-update / crash) right away.
        const { task } = await api("claim", { host: hostname(), ...(firstClaim ? { recover: true } : {}) });
        firstClaim = false;
        if (task) await doTask(task);
        else if (once) { log("no task waiting"); return; }
        if (once && task) return;
      }
    } catch (e) { log("error:", e.message); if (once) return; }
    await new Promise((r) => setTimeout(r, POLL_MS));
  }
}

if (process.argv[2] === "login") {
  // The worker's own Chrome: same binary, same profile, same flags (real macOS
  // Keychain key), so the worker reads exactly the cookies you create here.
  // login.lock keeps the worker from starting a task under your window.
  mkdirSync(PROFILE, { recursive: true });
  const finish = () => { try { unlinkSync(LOGIN_LOCK); } catch { /* gone */ } console.log("Chrome quit — the worker will pick up tasks again within a minute."); };
  const existing = chromePidOnProfile();
  if (existing) {
    writeFileSync(LOGIN_LOCK, String(existing));
    console.log(`A Chrome window (pid ${existing}) already has the worker's profile open. Sign in THERE, then quit it with Cmd+Q.`);
    waitForExit(existing, 2 * 60 * 60_000).then(finish);
  } else {
    writeFileSync(LOGIN_LOCK, String(process.pid));
    const chrome = spawn(CHROME_BIN, [`--user-data-dir=${PROFILE}`, ...CHROME_ARGS, "https://app.gohighlevel.com/", "https://mail.google.com/"], { stdio: "ignore" });
    console.log([
      "Chrome opened with the worker's profile (two tabs).",
      "  1. GoHighLevel tab: sign in as the agent; if it asks for a security code, read it from the Gmail tab; tick \"remember/trust this device\" if offered.",
      "  2. Gmail tab: make sure the agent's mailbox is signed in (the worker reads future security codes there).",
      "  3. Wait about a minute, then QUIT Chrome with Cmd+Q (not just the red button). Leave this window until it says done.",
    ].join("\n"));
    chrome.on("exit", finish);
  }
} else {
  loop(process.argv[2] === "once");
}
