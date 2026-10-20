#!/usr/bin/env node
// PMU AI agent — browser worker for the Mac Mini.
//
// Every 30 s it asks the dashboard for the next APPROVED task, then has
// Claude Code do it in a real Chrome (Playwright MCP, its own signed-in
// profile) on the same GoHighLevel screens a teammate uses, screenshots the
// result, and reports back. The dashboard then texts the owner.
//
//   node agent-worker.mjs login   → opens the worker's Chrome to sign in to GHL once
//   node agent-worker.mjs once    → do at most one task, then exit (testing)
//   node agent-worker.mjs         → run forever (launchd keeps it alive)
//
// Config: ~/.pmu-agent/.env  (DASHBOARD_URL, AGENT_WORKER_SECRET)

import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import { homedir, hostname } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const HOME = join(homedir(), ".pmu-agent");
const PROFILE = join(HOME, "chrome-profile");
const RUNS = join(HOME, "runs");
const TASK_TIMEOUT_MS = 20 * 60_000; // the dashboard re-queues after 25 min
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
async function selfUpdate() {
  if (Date.now() - lastUpdateCheck < 60 * 60_000) return;
  lastUpdateCheck = Date.now();
  try {
    const r = await fetch(SELF_URL, { signal: AbortSignal.timeout(20_000), headers: { "cache-control": "no-cache" } });
    if (!r.ok) return;
    const next = await r.text();
    const me = readFileSync(SELF_PATH, "utf8");
    if (next === me || next.length < 4000 || !next.includes("agent-worker") || !next.includes("selfUpdate")) return;
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
- NEVER send any message, email, text, or review request to anyone. Never touch billing, payment methods, or the agency settings.
- If the task is to produce a document (an export, a list, a report), save it in the current folder as .xlsx or .csv (or .pdf) and list it under "files" in your final JSON — the team downloads it from the dashboard and sends it themselves.
- SIGN-IN RECOVERY (owner, 10/19/2026 — do this yourself, do not stop): if GoHighLevel shows its login page, sign in with the saved credentials (Chrome pre-fills them; if the email field is empty use the account this Chrome's Gmail is signed in as — never invent a password; if there is no saved password, status "needs_teammate", summary "Mac Mini: no saved GoHighLevel password"). If it then asks to "Verify Security Code", open a NEW tab at https://mail.google.com/mail/u/0/#search/in%3Aanywhere+%22security+code%22 (this Chrome is signed in to the agent's mailbox; the code email usually lands in SPAM, which in:anywhere covers), open the NEWEST email from GoHighLevel / LeadConnector / HighLevel (sent within the last few minutes), read the 6-digit code, go back to the GoHighLevel tab, enter it, tick "trust this device / remember" if offered, and continue the task. If no code email appears after reloading the search 3 times a minute apart, status "needs_teammate", summary "Mac Mini: GoHighLevel security code never arrived". Never type the code anywhere except the GoHighLevel verification box.
- If you hit a CAPTCHA: stop, change nothing, status "needs_teammate", summary "Mac Mini hit a CAPTCHA on GoHighLevel".
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
  // cost the agent turns reading every screen (10/16/2026).
  const pwFile = join(dir, "playwright.json");
  writeFileSync(pwFile, JSON.stringify({ browser: { launchOptions: { args: ["--lang=en-US"] }, contextOptions: { locale: "en-US" } } }));
  const mcp = { mcpServers: { playwright: { command: "npx", args: ["-y", "@playwright/mcp@0.0.83", "--config", pwFile, "--browser", "chrome", "--user-data-dir", PROFILE, "--output-dir", dir, "--viewport-size", "1440x900"], env: { LANG: "en_US.UTF-8", LANGUAGE: "en_US" } } } };
  const mcpFile = join(dir, "mcp.json");
  writeFileSync(mcpFile, JSON.stringify(mcp));
  return new Promise((resolve) => {
    const child = spawn(CLAUDE, ["-p", prompt, "--mcp-config", mcpFile, "--strict-mcp-config", "--allowedTools", "mcp__playwright", "--output-format", "json", "--max-turns", "120"], { cwd: dir, stdio: ["ignore", "pipe", "pipe"] });
    let out = "", err = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      // Claude + the Playwright MCP sometimes ignore SIGTERM; a minute later
      // force it, so "close" always fires and the task is reported.
      setTimeout(() => { try { child.kill("SIGKILL"); } catch { /* gone */ } }, 60_000).unref();
    }, TASK_TIMEOUT_MS);
    child.on("close", (code) => { clearTimeout(timer); writeFileSync(join(dir, "claude-output.json"), out || err); resolve({ code, out, err }); });
  });
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
    : rep?.summary || (code === null ? "Timed out after 20 minutes — check the account by hand" : `The browser run did not finish (${(err || out).slice(-200).trim() || `exit ${code}`})`);

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
  for (;;) {
    try {
      await selfUpdate(); // idle only: never mid-task
      const { task } = await api("claim", { host: hostname() });
      if (task) await doTask(task);
      else if (once) { log("no task waiting"); return; }
      if (once && task) return;
    } catch (e) { log("error:", e.message); if (once) return; }
    await new Promise((r) => setTimeout(r, POLL_MS));
  }
}

if (process.argv[2] === "login") {
  // The same Chrome profile the worker uses — sign in once, tick
  // "remember this device", then quit Chrome.
  mkdirSync(PROFILE, { recursive: true });
  spawn("open", ["-na", "Google Chrome", "--args", `--user-data-dir=${PROFILE}`, "--lang=en-US", "https://app.gohighlevel.com/"], { stdio: "inherit" });
  console.log("Sign in to GoHighLevel in the Chrome window that opened, then QUIT that Chrome (Cmd+Q).");
} else {
  loop(process.argv[2] === "once");
}
