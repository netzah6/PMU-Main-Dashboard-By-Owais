"use client";
import { useEffect, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { Loader2 } from "lucide-react";
import type { EmailOtpType } from "@supabase/supabase-js";

// Invite / magic-link / recovery landing page. Supabase can return the session
// three different ways depending on flow config:
//   1. implicit  -> #access_token & #refresh_token in the URL HASH (server can't
//      read the hash, so this MUST be handled client-side)
//   2. PKCE      -> ?code in the query
//   3. OTP       -> ?token_hash & ?type in the query
// We handle all three here, set the session in the browser (cookies), then do a
// full-page redirect so middleware sees the new session on the next route.
export default function AuthCallbackPage() {
  const [message, setMessage] = useState("Finishing sign-in…");

  useEffect(() => {
    // Capture the URL BEFORE creating the client — the browser client's
    // detectSessionInUrl may otherwise consume and strip the hash first.
    const rawHash = window.location.hash.startsWith("#")
      ? window.location.hash.slice(1)
      : window.location.hash;
    const rawQuery = window.location.search;
    const supabase = createClient();

    (async () => {
      const hash = new URLSearchParams(rawHash);
      const query = new URLSearchParams(rawQuery);

      const next = query.get("next") || "/set-password";
      const fail = (e?: string) => {
        window.location.replace(`/login?error=${encodeURIComponent(e || "invite_link")}`);
      };

      const hashError = hash.get("error_description") || hash.get("error");
      if (hashError) return fail(hashError);

      const accessToken = hash.get("access_token");
      const refreshToken = hash.get("refresh_token");
      const code = query.get("code");
      const tokenHash = query.get("token_hash");
      const type = query.get("type") as EmailOtpType | null;

      try {
        if (accessToken && refreshToken) {
          const { error } = await supabase.auth.setSession({
            access_token: accessToken,
            refresh_token: refreshToken,
          });
          if (error) return fail(error.message);
        } else if (code) {
          const { error } = await supabase.auth.exchangeCodeForSession(code);
          if (error) return fail(error.message);
        } else if (tokenHash && type) {
          const { error } = await supabase.auth.verifyOtp({ type, token_hash: tokenHash });
          if (error) return fail(error.message);
        } else {
          // Nothing in the URL — maybe the client already auto-consumed the hash.
          const { data } = await supabase.auth.getSession();
          if (!data.session) return fail();
        }
      } catch (e) {
        return fail(String(e));
      }

      setMessage("Redirecting…");
      window.location.replace(next);
    })();
  }, []);

  return (
    <div className="min-h-screen flex flex-col items-center justify-center gap-3" style={{ background: "linear-gradient(160deg, #f2f6fa, #e6ecf3)" }}>
      <Loader2 size={22} className="animate-spin text-[#15B7AE]" />
      <p className="text-sm text-[#697a91]">{message}</p>
    </div>
  );
}
