"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { Eye, EyeOff, Loader2 } from "lucide-react";

export default function LoginPage() {
  const router = useRouter();
  const supabase = createClient();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError(null);

    const { error: authError } = await supabase.auth.signInWithPassword({
      email,
      password,
    });

    if (authError) {
      setError(authError.message);
      setLoading(false);
    } else {
      router.push("/");
      router.refresh();
    }
  }

  return (
    <div
      className="min-h-screen flex items-center justify-center p-4"
      style={{ background: "linear-gradient(160deg, #f2f6fa, #e6ecf3)" }}
    >
      <div className="w-full max-w-sm">
        {/* Logo */}
        <div className="flex flex-col items-center mb-8">
          <div
            className="w-14 h-14 rounded-2xl flex items-center justify-center mb-4 shadow-lg"
            style={{ background: "linear-gradient(135deg, #15B7AE, #34568a)" }}
          >
            <span className="text-white font-bold text-2xl">P</span>
          </div>
          <h1 className="text-xl font-bold text-[#1f3559]">PMU Bookings On Demand</h1>
          <p className="text-sm text-[#697a91] mt-1">Master Dashboard</p>
        </div>

        {/* Card */}
        <div className="bg-white border border-[#e4ebf2] rounded-2xl p-8 shadow-2xl">
          <h2 className="text-lg font-semibold text-[#1f3559] mb-6">Sign In</h2>

          <form onSubmit={handleSubmit} className="space-y-4">
            <div>
              <label className="block text-xs font-medium text-[#697a91] mb-1.5">
                Email Address
              </label>
              <input
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                required
                placeholder="you@pmu-bookings.com"
                className="w-full px-3 py-2.5 bg-[#eef2f7] border border-[#d7e0ea] rounded-lg text-sm text-[#1f3559] placeholder:text-[#8595a8] focus:outline-none focus:border-[#15B7AE] focus:ring-1 focus:ring-teal-500 transition-colors"
              />
            </div>

            <div>
              <label className="block text-xs font-medium text-[#697a91] mb-1.5">
                Password
              </label>
              <div className="relative">
                <input
                  type={showPassword ? "text" : "password"}
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  required
                  placeholder="••••••••"
                  className="w-full px-3 py-2.5 pr-10 bg-[#eef2f7] border border-[#d7e0ea] rounded-lg text-sm text-[#1f3559] placeholder:text-[#8595a8] focus:outline-none focus:border-[#15B7AE] focus:ring-1 focus:ring-teal-500 transition-colors"
                />
                <button
                  type="button"
                  onClick={() => setShowPassword(!showPassword)}
                  className="absolute right-3 top-1/2 -translate-y-1/2 text-[#697a91] hover:text-[#1e2a3a]"
                >
                  {showPassword ? <EyeOff size={15} /> : <Eye size={15} />}
                </button>
              </div>
            </div>

            {error && (
              <div className="px-3 py-2 bg-[#fde8ee] border border-[#f5c2cf] rounded-lg text-xs text-[#e11d48]">
                {error}
              </div>
            )}

            <button
              type="submit"
              disabled={loading}
              className="w-full py-2.5 rounded-lg font-medium text-sm text-[#1f3559] transition-all flex items-center justify-center gap-2 disabled:opacity-60"
              style={{ background: loading ? "#0e8f88" : "#15B7AE" }}
            >
              {loading ? (
                <>
                  <Loader2 size={15} className="animate-spin" />
                  Signing in…
                </>
              ) : (
                "Sign In"
              )}
            </button>
          </form>
        </div>
      </div>
    </div>
  );
}
