/* CloseBot sign-in recovery (owner, 11/10/2026: "yes" — let the AI Agent sign
   itself back in to CloseBot, like it already does for GoHighLevel). Until
   now every CloseBot task stopped at the sign-in page ("type nothing"), so the
   weekly check and the setup's CloseBot step failed whenever the session ran
   out. Chrome keeps the saved password; the agent only clicks Sign In and
   never types or sees a password. Google sign-in hangs on the Mini, so it
   must use the email + password boxes. The same words are in
   worker/agent-worker.mjs (closebotPrompt) — keep them in step. */
export const CLOSEBOT_SIGN_IN =
  `If CloseBot shows its sign-in page, sign in yourself (owner, 11/10/2026): Chrome fills the email and password boxes from its saved password — click the email/password Sign In button. Never use "Sign in with Google" (it hangs) and never type or make up a password. If the email or password box is empty, status "needs_teammate", summary "Mac Mini: no saved CloseBot password". If CloseBot then asks for a code, shows a CAPTCHA, or still shows the sign-in page, status "needs_teammate", summary "Mac Mini is not signed in to CloseBot". After signing in, open the page you needed again and carry on.`;
