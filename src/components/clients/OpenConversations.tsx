"use client";
import { useCallback, useEffect, useMemo, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { Loader2, Search, ExternalLink, MessageSquare } from "lucide-react";
import { cn } from "@/lib/utils";

// Leads who replied in the last 14 days and are still waiting on us — the
// conversations that could still turn into a deposit. Read by hand to spot
// what to improve; one click opens the thread in GHL.

type Row = {
  conversation_id: string;
  location_id: string;
  owner_key: string;
  owner_name: string | null;
  business: string | null;
  contact_id: string | null;
  lead_name: string;
  lead_phone: string | null;
  last_message_body: string | null;
  last_message_date: string;
  unread: number;
  already_deposited: boolean;
};

function ago(iso: string): string {
  const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 3600) return `${Math.max(1, Math.floor(s / 60))}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

/** The lead's thread inside the client's own sub-account. */
function chatUrl(locationId: string, conversationId: string) {
  return `https://app.gohighlevel.com/v2/location/${locationId}/conversations/conversations/${conversationId}`;
}

export function OpenConversations() {
  const [rows, setRows] = useState<Row[] | null>(null);
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const [client, setClient] = useState("all");
  const [showDeposited, setShowDeposited] = useState(false);
  const [loading, setLoading] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    const { data } = await createClient()
      .from("cpd_open_conversations")
      .select("*")
      .order("last_message_date", { ascending: false })
      .limit(1000);
    setRows((data as Row[]) ?? []);
    setLoading(false);
  }, []);

  // Only fetch once the box is actually opened — it is a big list.
  useEffect(() => { if (open && rows === null) load(); }, [open, rows, load]);

  const clients = useMemo(() => {
    const m = new Map<string, number>();
    for (const r of rows ?? []) {
      if (!showDeposited && r.already_deposited) continue;
      const k = r.owner_name || r.owner_key;
      m.set(k, (m.get(k) ?? 0) + 1);
    }
    return [...m.entries()].sort((a, b) => b[1] - a[1]);
  }, [rows, showDeposited]);

  const shown = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return (rows ?? []).filter((r) => {
      if (!showDeposited && r.already_deposited) return false;
      if (client !== "all" && (r.owner_name || r.owner_key) !== client) return false;
      if (!needle) return true;
      return `${r.lead_name} ${r.owner_name ?? ""} ${r.business ?? ""} ${r.last_message_body ?? ""}`
        .toLowerCase()
        .includes(needle);
    });
  }, [rows, q, client, showDeposited]);

  const openCount = (rows ?? []).filter((r) => showDeposited || !r.already_deposited).length;

  return (
    <div className="rounded-xl border border-[#cfe3f7] bg-[#f7fbff]">
      <button onClick={() => setOpen((o) => !o)} className="w-full flex items-center gap-2 px-4 py-2.5 text-left">
        <MessageSquare size={14} className="text-[#1d4ed8] shrink-0" />
        <span className="text-sm font-bold text-[#1d4ed8]">
          Leads who replied{rows ? ` · ${openCount}` : ""}
        </span>
        <span className="text-xs text-[#5b7aa8] hidden sm:inline">
          last 14 days, still waiting on us &mdash; open the chat and close them
        </span>
        <span className="ml-auto text-[#1d4ed8]">{open ? "▲" : "▼"}</span>
      </button>

      {open && (
        <div className="px-3 pb-3 space-y-2">
          <div className="flex flex-wrap items-center gap-2">
            <div className="relative flex-1 min-w-[180px]">
              <Search size={13} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-[#8595a8]" />
              <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search lead, client or message…"
                className="w-full pl-7 pr-3 py-1.5 rounded-lg border border-[#d7e0ea] bg-white text-sm text-[#1f3559] placeholder:text-[#8595a8] focus:outline-none focus:border-[#15B7AE]" />
            </div>
            <select value={client} onChange={(e) => setClient(e.target.value)}
              className="px-2 py-1.5 rounded-lg border border-[#d7e0ea] bg-white text-xs text-[#34568a] max-w-[240px]">
              <option value="all">All clients ({clients.length})</option>
              {clients.map(([name, n]) => <option key={name} value={name}>{name} ({n})</option>)}
            </select>
            <label className="flex items-center gap-1.5 text-xs text-[#34568a] whitespace-nowrap">
              <input type="checkbox" checked={showDeposited} onChange={(e) => setShowDeposited(e.target.checked)} />
              Include leads who already paid
            </label>
          </div>

          {loading ? (
            <div className="flex items-center gap-2 text-xs text-[#697a91] py-3"><Loader2 size={13} className="animate-spin" />Loading conversations…</div>
          ) : shown.length === 0 ? (
            <p className="text-xs text-[#8595a8] py-2">No replies waiting — everyone has been answered.</p>
          ) : (
            <ul className="space-y-1 max-h-[60vh] overflow-y-auto">
              {shown.map((r) => (
                <li key={r.conversation_id}
                  className={cn("rounded-lg border bg-white px-2.5 py-1.5",
                    r.already_deposited ? "border-[#c7edd4]" : "border-[#e4ebf2]")}>
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="text-[13px] font-semibold text-[#1f3559]">{r.lead_name}</span>
                    <span className="text-[11px] text-[#697a91] truncate">
                      {r.owner_name}{r.business ? ` · ${r.business}` : ""}
                    </span>
                    {r.already_deposited && (
                      <span className="px-1.5 py-0.5 rounded text-[10px] font-bold bg-[#e6f7ee] text-[#15803d] border border-[#c7edd4]">paid</span>
                    )}
                    {r.unread > 0 && (
                      <span className="px-1.5 py-0.5 rounded text-[10px] font-bold bg-[#fff7ec] text-[#b45309] border border-[#fcd9a8]">unread</span>
                    )}
                    <span className="ml-auto text-[11px] text-[#8595a8] whitespace-nowrap">{ago(r.last_message_date)}</span>
                    <a href={chatUrl(r.location_id, r.conversation_id)} target="_blank" rel="noopener noreferrer"
                      onClick={(e) => e.stopPropagation()}
                      className="flex items-center gap-1 px-2 py-0.5 rounded-lg text-[11px] font-semibold bg-[#e6f7f5] text-[#0e8f88] border border-[#a7e3df] hover:bg-[#d5f0ee] whitespace-nowrap">
                      Open chat <ExternalLink size={10} />
                    </a>
                  </div>
                  <p className="text-[12px] text-[#34568a] mt-0.5 line-clamp-2">“{r.last_message_body}”</p>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
