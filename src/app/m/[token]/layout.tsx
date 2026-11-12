import type { Metadata, Viewport } from "next";
import { loadApp } from "@/lib/client-app";
import { TabBar } from "@/components/client-app/TabBar";

/* Client app shell (owner, 11/11/2026): header, the page, bottom tabs. Added
   to the phone's home screen it opens full-screen like an app — its own
   manifest (start_url = this client's app), not the team dashboard's. */

export const dynamic = "force-dynamic";
export const maxDuration = 60;

export function generateMetadata({ params }: { params: { token: string } }): Metadata {
  return {
    title: "PMU Bookings",
    applicationName: "PMU Bookings",
    manifest: `/m/${params.token}/manifest.webmanifest`,
    appleWebApp: { capable: true, statusBarStyle: "default", title: "PMU Bookings" },
    robots: { index: false, follow: false },
    referrer: "no-referrer", // the link is the key during the demo
  };
}
export const viewport: Viewport = { width: "device-width", initialScale: 1, viewportFit: "cover", themeColor: "#15B7AE" };

export default async function ClientAppLayout({ children, params }: { children: React.ReactNode; params: { token: string } }) {
  const app = await loadApp(params.token);
  if (!app) {
    return (
      <div className="min-h-screen bg-[#f3f7fb] px-4 py-16">
        <div className="mx-auto max-w-sm rounded-2xl border border-[#e4ebf2] bg-white p-6 text-center">
          <p className="text-base font-bold text-[#1c2b3a]">This app link isn&apos;t available.</p>
          <p className="mt-1 text-sm text-[#7b8a9c]">Please ask your success coach for a new one.</p>
        </div>
      </div>
    );
  }
  const v = app.view;
  return (
    <div className="min-h-screen bg-[#f3f7fb]">
      <header className="sticky top-0 z-10 bg-[#15B7AE] text-white" style={{ paddingTop: "env(safe-area-inset-top)" }}>
        <div className="mx-auto flex max-w-xl items-center gap-3 px-4 py-3">
          {/* Her own logo (the one on her funnel) and her name — it is HER app. */}
          {app.logo ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={app.logo} alt="" referrerPolicy="no-referrer" className="h-10 w-10 shrink-0 rounded-full bg-white object-contain p-0.5" />
          ) : (
            <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-white/25 text-base font-extrabold">
              {(v.business || v.ownerName).replace(/[^\p{L}]/gu, "").slice(0, 1).toUpperCase() || "P"}
            </span>
          )}
          <div className="min-w-0">
            <p className="truncate text-base font-bold leading-tight">{v.business || v.ownerName}</p>
            {v.business && v.ownerName && <p className="truncate text-xs font-semibold text-white/85">{v.ownerName}</p>}
          </div>
          {/* Our own mark, top right (owner, 11/11/2026). */}
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src="/brand-logo.png" alt="PMU Bookings On Demand" title="PMU Bookings On Demand"
            className="ml-auto h-10 w-12 shrink-0 rounded-xl bg-white object-contain px-1.5 py-1" />
        </div>
      </header>
      <main className="mx-auto max-w-xl px-3 pt-3" style={{ paddingBottom: "calc(env(safe-area-inset-bottom) + 84px)" }}>
        {children}
      </main>
      <TabBar base={`/m/${params.token}`} />
    </div>
  );
}
