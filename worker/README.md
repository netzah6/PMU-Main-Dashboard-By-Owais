# AI agent — Mac Mini browser worker

Approved agent cards (status `queued_browser`) are done here, in a real Chrome
signed in to GoHighLevel, with screenshots sent back to the card and to the
owner's phone. The dashboard never texts clients.

## One-time setup (on the Mac Mini)
1. System Settings → Energy: *Prevent automatic sleeping when the display is off*,
   *Start up automatically after a power failure*, *Wake for network access*.
2. Install Node 20+, Google Chrome, and Claude Code (`npm i -g @anthropic-ai/claude-code`);
   run `claude` once and sign in.
3. Put this `worker/` folder on the Mac Mini and run `bash setup-mac-mini.sh`.
   It prints a new key → add it in Vercel as `AGENT_WORKER_SECRET` and redeploy.
4. `node ~/.pmu-agent/agent-worker.mjs login` → sign in to GoHighLevel with the
   **AI Agent** agency user (tick "remember this device"), then quit that Chrome.
5. `node ~/.pmu-agent/agent-worker.mjs once` → test on one approved card.
6. `launchctl load -w ~/Library/LaunchAgents/com.pmu.agent-worker.plist` → runs for good.

The AI tab's 🕵️ Agent panel shows "Mac Mini online" once it checks in.
Each run's files (screenshots, Claude output) are in `~/.pmu-agent/runs/`.

## Security (run `bash security-check.sh` — it only reports, changes nothing)
- FileVault on, firewall on, no automatic login, password right after the screen locks.
- Remote Login and Screen Sharing off unless you use them.
- macOS kept up to date; the Mac is used ONLY for the agent (no personal email/browsing).
- The GoHighLevel user (aiagent@pmu-bookings.com) has no Conversations, Marketing, Payments,
  Phone or Agency-settings access — and can be switched off in GHL in seconds.
- `~/.pmu-agent/.env` (the worker key) stays private (mode 600); never paste it into a chat.
