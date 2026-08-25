"use client";
import { useEffect, useState } from "react";
import { createClient } from "@/lib/supabase/client";

// Green when the ad data (CPL workbook sync) is from TODAY, red when it's
// from any past day — so a stalled sync is impossible to miss (the CPL
// tables sat frozen Aug 20-25 with nobody noticing). Days compared in
// Pacific time, matching the sheet's ~4:49 AM PT daily refresh.
export function DataFreshness() {
  const [syncedAt, setSyncedAt] = useState<string | null>(null);
  useEffect(() => {
    createClient().from("data_freshness").select("synced_at").eq("key", "cpl").single()
      .then(({ data }) => setSyncedAt(data?.synced_at ?? null));
  }, []);
  if (!syncedAt) return null;
  const d = new Date(syncedAt);
  const day = (x: Date) => x.toLocaleDateString("en-US", { timeZone: "America/Los_Angeles" });
  const fresh = day(d) === day(new Date());
  const when = d.toLocaleString("en-US", {
    timeZone: "America/Los_Angeles",
    month: "short", day: "numeric", hour: "numeric", minute: "2-digit",
  });
  return (
    <span
      title={fresh
        ? "The ad data (CPL/spend) synced from the Google Sheet today."
        : "The ad data has NOT refreshed today — numbers may be stale. The sync runs daily at 5:00 AM Pacific."}
      className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-xs font-semibold border ${
        fresh
          ? "bg-[#e6f7ee] text-[#15803d] border-[#86efac]"
          : "bg-[#fde8ee] text-[#be123c] border-[#f5c2cf]"
      }`}
    >
      <span className={`w-1.5 h-1.5 rounded-full ${fresh ? "bg-[#22c55e]" : "bg-[#e11d48]"}`} />
      {fresh ? `Data updated today ${when.split(", ")[1] ?? when}` : `⚠ Data from ${when} — not refreshed today`}
    </span>
  );
}
