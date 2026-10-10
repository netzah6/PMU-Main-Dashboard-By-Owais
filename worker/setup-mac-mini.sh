#!/bin/bash
# One-time setup of the AI agent's browser worker on the Mac Mini.
# Run from this folder:  bash setup-mac-mini.sh
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
APP="$HOME/.pmu-agent"
PLIST="$HOME/Library/LaunchAgents/com.pmu.agent-worker.plist"

need() { command -v "$1" >/dev/null 2>&1 || { echo "✗ $1 is not installed — $2"; exit 1; }; }
need node   "install Node 20+ from https://nodejs.org"
need claude "install Claude Code (npm install -g @anthropic-ai/claude-code), then run 'claude' once and sign in"
[ -d "/Applications/Google Chrome.app" ] || { echo "✗ Google Chrome is not installed"; exit 1; }

mkdir -p "$APP/runs"
cp "$HERE/agent-worker.mjs" "$APP/agent-worker.mjs"

if [ ! -f "$APP/.env" ]; then
  SECRET="$(openssl rand -hex 32)"
  printf 'DASHBOARD_URL=https://pmu-main-dashboard-by-owais1.vercel.app\nAGENT_WORKER_SECRET=%s\n' "$SECRET" > "$APP/.env"
  chmod 600 "$APP/.env"
  echo
  echo "▶ New worker key created. Add it to Vercel (project pmu-main-dashboard-by-owais1 →"
  echo "  Settings → Environment Variables) as AGENT_WORKER_SECRET, then redeploy:"
  echo
  echo "  $SECRET"
  echo
fi

cat > "$PLIST" <<PL
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>com.pmu.agent-worker</string>
  <key>ProgramArguments</key><array><string>$(command -v node)</string><string>$APP/agent-worker.mjs</string></array>
  <key>EnvironmentVariables</key><dict><key>PATH</key><string>$(dirname "$(command -v node)"):$(dirname "$(command -v claude)"):/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin</string></dict>
  <key>WorkingDirectory</key><string>$APP</string>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>$APP/worker.log</string>
  <key>StandardErrorPath</key><string>$APP/worker.log</string>
</dict></plist>
PL

echo "✓ Installed. Next:"
echo "  1. node $APP/agent-worker.mjs login     (sign in to GoHighLevel in the window, then Cmd+Q)"
echo "  2. node $APP/agent-worker.mjs once      (test: does one approved task, if any)"
echo "  3. launchctl load -w $PLIST             (start it for good — it restarts by itself)"
echo "  Log: $APP/worker.log"
