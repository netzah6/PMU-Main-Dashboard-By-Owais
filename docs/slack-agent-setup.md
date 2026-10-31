# "Send to AI Agent" Slack button — one-time setup (owner)

1. https://api.slack.com/apps → **Create New App** → **From a manifest** → pick the workspace → paste `docs/slack-agent-manifest.json` → Create.
2. **Install to Workspace** → Allow (you install it, so the user token is yours).
3. Copy these into Vercel → Project → Settings → Environment Variables (Production), then redeploy:
   - `SLACK_SIGNING_SECRET` — Basic Information → App Credentials → Signing Secret
   - `SLACK_BOT_TOKEN` — OAuth & Permissions → Bot User OAuth Token (`xoxb-…`)
   - `SLACK_USER_TOKEN` — OAuth & Permissions → User OAuth Token (`xoxp-…`)
   - `SLACK_OWNER_USER_ID` — your Slack member ID (Slack → your profile → ⋮ → Copy member ID)
4. Test: in any DM, hover a message → ⋮ (More actions) → **Send to AI Agent**.

Only `SLACK_OWNER_USER_ID` can use it; anyone else who clicks it gets "only for Netzah". Replies are ephemeral (only you see them); nothing is posted to anyone.
