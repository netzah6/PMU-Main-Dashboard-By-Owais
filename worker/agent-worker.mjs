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

import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { homedir, hostname } from "node:os";
import { join } from "node:path";

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

async function api(path, body) {
  const r = await fetch(`${BASE}/api/agent/worker/${path}`, {
    method: "POST", headers: { Authorization: `Bearer ${SECRET}`, "Content-Type": "application/json" }, body: JSON.stringify(body),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`${path}: HTTP ${r.status} ${j.error ?? ""}`);
  return j;
}

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
- If you hit a login page, a security code, or a CAPTCHA: stop, change nothing, status "failed", summary "Mac Mini needs to be signed in to GoHighLevel again".
- If the task is unclear, risky, or the screen doesn't match what you expect: change nothing, status "needs_teammate", and explain why in one sentence.
- Calendars: GoHighLevel sets availability per staff member (calendar → Availability → the staff member → Weekly hours / Custom schedule). After saving, reload the page and confirm the new values are really there.

PROOF (required):
- Before changing anything, take a screenshot of the relevant settings screen and save it with filename "before-1.png".
- After saving, reload the page, check the change stuck, and take screenshot(s) "after-1.png" (and "after-2.png" etc. if needed) clearly showing the result.

When finished, reply with ONLY this JSON (no other text):
{"status":"done" | "failed" | "needs_teammate","summary":"<one plain sentence: what you did or why not>","steps":["<short line per thing you did, with before → after values>"],"screenshots":[{"file":"before-1.png","name":"Before: <what it shows>"},{"file":"after-1.png","name":"After: <what it shows>"}]}`;
}

function runClaude(prompt, dir) {
  const mcp = { mcpServers: { playwright: { command: "npx", args: ["-y", "@playwright/mcp@0.0.83", "--browser", "chrome", "--user-data-dir", PROFILE, "--output-dir", dir, "--viewport-size", "1440x900"] } } };
  const mcpFile = join(dir, "mcp.json");
  writeFileSync(mcpFile, JSON.stringify(mcp));
  return new Promise((resolve) => {
    const child = spawn(CLAUDE, ["-p", prompt, "--mcp-config", mcpFile, "--strict-mcp-config", "--allowedTools", "mcp__playwright", "--output-format", "json", "--max-turns", "120"], { cwd: dir, stdio: ["ignore", "pipe", "pipe"] });
    let out = "", err = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    const timer = setTimeout(() => { child.kill("SIGTERM"); }, TASK_TIMEOUT_MS);
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
  const { code, out, err } = await runClaude(promptFor(t), dir);
  const rep = parseReport(out);
  const status = ["done", "failed", "needs_teammate"].includes(rep?.status) ? rep.status : "failed";
  const summary = rep?.summary || (code === null ? "Timed out after 20 minutes — check the account by hand" : `The browser run did not finish (${(err || out).slice(-200).trim() || `exit ${code}`})`);

  // Upload the screenshots it named, else any image it saved.
  const named = Array.isArray(rep?.screenshots) ? rep.screenshots : [];
  const files = readdirSync(dir).filter((f) => /\.(png|jpe?g)$/i.test(f));
  const list = named.length ? named.filter((s) => files.includes(s.file)) : files.sort().map((f) => ({ file: f, name: f.replace(/\.(png|jpe?g)$/i, "") }));
  const screenshots = [];
  for (const s of list.slice(0, 10)) {
    try {
      const { url } = await api("upload", { id: t.id, name: s.name, base64: readFileSync(join(dir, s.file)).toString("base64") });
      screenshots.push({ name: s.name, url });
    } catch (e) { log("upload failed", s.file, e.message); }
  }
  await api("finish", { id: t.id, status, summary, steps: Array.isArray(rep?.steps) ? rep.steps : [], screenshots });
  log(`task ${t.id} → ${status} (${screenshots.length} screenshots)`);
}

async function loop(once) {
  if (!SECRET) { console.error(`Missing AGENT_WORKER_SECRET in ${envFile}`); process.exit(1); }
  log(`worker on ${hostname()} → ${BASE}`);
  for (;;) {
    try {
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
  spawn("open", ["-na", "Google Chrome", "--args", `--user-data-dir=${PROFILE}`, "https://app.gohighlevel.com/"], { stdio: "inherit" });
  console.log("Sign in to GoHighLevel in the Chrome window that opened, then QUIT that Chrome (Cmd+Q).");
} else {
  loop(process.argv[2] === "once");
}
