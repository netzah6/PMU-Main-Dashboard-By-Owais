"use client";
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { Eye, EyeOff, Loader2 } from "lucide-react";

export default function SetPasswordPage() {
  const router = useRouter();
  const supabase = createClient();
  const [email, setEmail] = useState<string | null>(null);
  const [checking, setChecking] = useState(true);
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [show, setShow] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // The invite callback establishes a session before redirecting here. If there
  // is none (link expired or opened directly), send them to sign in.
  useEffect(() => {
    supabase.auth.getUser().then(({ data }) => {
      if (!data.user) {
        router.replace("/login");
        return;
      }
      setEmail(data.user.email ?? null);
      setChecking(false);
    });
  }, [router, supabase]);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    if (password.length < 8) {
      setError("Password must be at least 8 characters.");
      return;
    }
    if (password !== confirm) {
      setError("Passwords do not match.");
      return;
    }
    setLoading(true);
    const { error: updateError } = await supabase.auth.updateUser({ password });
    if (updateError) {
      setError(updateError.message);
      setLoading(false);
      return;
    }
    router.push("/clients");
    router.refresh();
  }

  if (checking) {
    return (
      <div className="min-h-screen flex items-center justify-center" style={{ background: "linear-gradient(160deg, #f2f6fa, #e6ecf3)" }}>
        <Loader2 size={22} className="animate-spin text-[#15B7AE]" />
      </div>
    );
  }

  return (
    <div className="min-h-screen flex items-center justify-center p-4" style={{ background: "linear-gradient(160deg, #f2f6fa, #e6ecf3)" }}>
      <div className="w-full max-w-sm">
        <div className="flex flex-col items-center mb-8">
          <div className="w-14 h-14 rounded-2xl flex items-center justify-center mb-4 shadow-lg" style={{ background: "linear-gradient(135deg, #15B7AE, #34568a)" }}>
            <span className="text-white font-bold text-2xl">P</span>
          </div>
          <h1 className="text-xl font-bold text-[#1f3559]">Welcome to the team</h1>
          <p className="text-sm text-[#697a91] mt-1">Set a password to finish setting up your account</p>
        </div>

        <div className="bg-white border border-[#e4ebf2] rounded-2xl p-8 shadow-2xl">
          {email && (
            <div className="mb-5 px-3 py-2 bg-[#eef2f7] border border-[#d7e0ea] rounded-lg text-xs text-[#34568a]">
              Signing in as <span className="font-semibold text-[#1f3559]">{email}</span>
            </div>
          )}

          <form onSubmit={handleSubmit} className="space-y-4">
            <div>
              <label className="block text-xs font-medium text-[#697a91] mb-1.5">New Password</label>
              <div className="relative">
                <input
                  type={show ? "text" : "password"}
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  required
                  placeholder="At least 8 characters"
                  className="w-full px-3 py-2.5 pr-10 bg-[#eef2f7] border border-[#d7e0ea] rounded-lg text-sm text-[#1f3559] placeholder:text-[#8595a8] focus:outline-none focus:border-[#15B7AE] focus:ring-1 focus:ring-teal-500 transition-colors"
                />
                <button type="button" onClick={() => setShow(!show)} className="absolute right-3 top-1/2 -translate-y-1/2 text-[#697a91] hover:text-[#1e2a3a]">
                  {show ? <EyeOff size={15} /> : <Eye size={15} />}
                </button>
              </div>
            </div>

            <div>
              <label className="block text-xs font-medium text-[#697a91] mb-1.5">Confirm Password</label>
              <input
                type={show ? "text" : "password"}
                value={confirm}
                onChange={(e) => setConfirm(e.target.value)}
                required
                placeholder="Re-enter password"
                className="w-full px-3 py-2.5 bg-[#eef2f7] border border-[#d7e0ea] rounded-lg text-sm text-[#1f3559] placeholder:text-[#8595a8] focus:outline-none focus:border-[#15B7AE] focus:ring-1 focus:ring-teal-500 transition-colors"
              />
            </div>

            {error && (
              <div className="px-3 py-2 bg-[#fde8ee] border border-[#f5c2cf] rounded-lg text-xs text-[#e11d48]">{error}</div>
            )}

            <button
              type="submit"
              disabled={loading}
              className="w-full py-2.5 rounded-lg font-medium text-sm text-[#1f3559] transition-all flex items-center justify-center gap-2 disabled:opacity-60"
              style={{ background: loading ? "#0e8f88" : "#15B7AE" }}
            >
              {loading ? (<><Loader2 size={15} className="animate-spin" />Saving…</>) : "Set Password & Continue"}
            </button>
          </form>
        </div>
      </div>
    </div>
  );
}
