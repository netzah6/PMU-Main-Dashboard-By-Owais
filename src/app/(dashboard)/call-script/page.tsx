"use client";
import { useState } from "react";
import { Check, Copy, ExternalLink } from "lucide-react";
import { cn } from "@/lib/utils";

/* 📞 Call Script (owner, 11/27/2026): the appointment setter's discovery-call
   script on one page. It opens the same for every artist, then splits in two
   on the price of her first brow session: under $400 → Quick Start Call with
   the client success coach (pay per appointment), $400 or more → Demo Call.
   The script itself is one static page (public/team/discovery-call-script.html,
   behind the dashboard login) so its wording can change without touching this
   tab; it is shown here in a frame, full height. */

const SCRIPT = "/team/discovery-call-script.html";

export default function CallScriptPage() {
  const [copied, setCopied] = useState(false);

  // The link a team member opens: this tab, so it asks for their own login.
  const copy = async () => {
    const link = `${window.location.origin}/call-script`;
    try {
      await navigator.clipboard.writeText(link);
    } catch {
      window.prompt("Copy this link", link);
    }
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex flex-wrap items-center gap-2 border-b border-[#e4ebf2] bg-white px-4 py-2">
        <h1 className="mr-auto text-sm font-bold tracking-tight text-[#1f3559]">📞 Discovery Call Script</h1>
        <button
          onClick={copy}
          className={cn(
            "inline-flex items-center gap-1.5 rounded-lg border px-3 py-1.5 text-sm font-semibold",
            copied ? "border-[#bbf7d0] bg-[#f0fdf4] text-[#15803d]" : "border-[#e4ebf2] text-[#4a5a6e] hover:bg-[#f4f7fa]",
          )}
        >
          {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
          {copied ? "Copied" : "Copy link for the team"}
        </button>
        <a
          href={SCRIPT}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex items-center gap-1.5 rounded-lg bg-[#1f3559] px-3 py-1.5 text-sm font-semibold text-white hover:bg-[#16284a]"
        >
          <ExternalLink className="h-3.5 w-3.5" />
          Open full screen
        </a>
      </div>
      <iframe src={SCRIPT} title="Discovery Call Script" className="min-h-0 w-full flex-1 border-0 bg-white" />
    </div>
  );
}
