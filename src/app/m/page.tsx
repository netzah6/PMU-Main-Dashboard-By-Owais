import type { Metadata, Viewport } from "next";
import { SignInForm } from "@/components/client-app/SignInForm";

/* The front door of the client app: sign in with a phone number and a texted
   code (owner, 11/14/2026). Beta: only the clients the owner named can get a
   code; everyone else sees the same screen and nothing is sent. */
export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "PMU Bookings · Sign in", robots: { index: false, follow: false } };
export const viewport: Viewport = { width: "device-width", initialScale: 1, viewportFit: "cover", themeColor: "#15B7AE" };

export default function ClientAppSignIn() {
  return (
    <div className="min-h-screen bg-[#f3f7fb]">
      <header className="bg-[#15B7AE] text-white" style={{ paddingTop: "env(safe-area-inset-top)" }}>
        <div className="mx-auto flex max-w-sm items-center gap-3 px-4 py-4">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src="/brand-logo.png" alt="" className="h-10 w-12 shrink-0 rounded-xl bg-white object-contain px-1.5 py-1" />
          <p className="text-base font-bold">PMU Bookings On Demand</p>
        </div>
      </header>
      <main className="mx-auto max-w-sm px-4 py-8">
        <h1 className="text-2xl font-extrabold text-[#1c2b3a]">Sign in</h1>
        <p className="mb-4 mt-1 text-sm text-[#7b8a9c]">Your bookings, chats and billing in one place.</p>
        <div className="rounded-2xl border border-[#e4ebf2] bg-white p-4"><SignInForm /></div>
      </main>
    </div>
  );
}
