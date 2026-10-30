"use client";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { Loader2, Play, Check, X, Search, Plus, ExternalLink } from "lucide-react";
import { cn } from "@/lib/utils";
import { useUser } from "@/lib/hooks/useUser";

// Instagram (owner 2026-10-30): our account follows every client and keeps
// engaging with them through the Mac Mini — slowly, like a person. This page
// decides who gets visited (Engage / VIP / Paused / Do not engage + why),
// holds the comment ideas waiting for a yes, and shows what was done.

type Status = "engage" | "vip" | "paused" | "blocked";
type Client = {
  username: string; slug: string | null; client_name: string | null; status: Status; note: string | null;
  followed_at: string | null; follows_us: boolean | null; last_engaged_at: string | null; last_action: string | null; last_error: string | null;
};
type Action = {
  id: string; username: string; kind: "follow" | "story_view" | "like" | "comment" | "story_reply"; text: string | null; post_url: string | null;
  context: string | null; status: string; note: string | null; created_at: string; done_at: string | null;
};
type Run = { id: string; status: string; result: string | null; created_at: string; executed_at: string | null; screenshots: Array<{ name: string; url: string }> | null };
type Payload = {
  settings: { enabled: boolean; startedAt: string | null; approveComments: boolean; pausedReason?: string | null };
  week: number; quota: number; nextRun: string;
  clients: Client[]; drafts: Action[]; recent: Action[]; runs: Run[];
};

const STATUS: Record<Status, { label: string; cls: string }> = {
  engage: { label: "Engage", cls: "bg-[#e6f7f5] text-[#0e8f88]" },
  vip: { label: "⭐ VIP", cls: "bg-[#fff4d6] text-[#a16207]" },
  paused: { label: "Paused", cls: "bg-[#eef2f7] text-[#64748b]" },
  blocked: { label: "Do not engage", cls: "bg-[#fde8ee] text-[#e11d48]" },
};
type Filter = "all" | Status | "notfollowed";
const FILTERS: Array<{ key: Filter; label: string; test: (c: Client) => boolean }> = [
  { key: "all", label: "All", test: () => true },
  { key: "engage", label: "Engage", test: (c) => c.status === "engage" },
  { key: "vip", label: "⭐ VIP", test: (c) => c.status === "vip" },
  { key: "paused", label: "Paused", test: (c) => c.status === "paused" },
  { key: "blocked", label: "Do not engage", test: (c) => c.status === "blocked" },
  { key: "notfollowed", label: "Not followed yet", test: (c) => !c.followed_at && (c.status === "engage" || c.status === "vip") },
];
const KIND: Record<Action["kind"], string> = { follow: "Followed", story_view: "Watched stories", like: "Liked a post", comment: "Commented", story_reply: "Replied to a story" };
const usDate = (iso?: string | null) => (iso ? new Date(iso).toLocaleDateString("en-US", { month: "2-digit", day: "2-digit", year: "numeric", timeZone: "America/Los_Angeles" }) : "—");
const ig = (u: string) => `https://www.instagram.com/${u}/`;

export default function InstagramPage() {
  const router = useRouter();
  const { role, loading: roleLoading } = useUser();
  useEffect(() => { if (!roleLoading && role !== "admin") router.replace("/clients"); }, [roleLoading, role, router]);

  const [data, setData] = useState<Payload | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [filter, setFilter] = useState<Filter>("all");
  const [q, setQ] = useState("");
  const [edits, setEdits] = useState<Record<string, string>>({});
  const [notes, setNotes] = useState<Record<string, string>>({});
  const [adding, setAdding] = useState<{ handle: string; name: string } | null>(null);

  const load = useCallback(async () => {
    setLoading(true); setError(null);
    try {
      const r = await fetch("/api/ig-engage");
      const j = await r.json();
      if (!r.ok) throw new Error(j.error ?? "Could not load");
      setData(j);
    } catch (e) { setError(e instanceof Error ? e.message : "Could not load"); }
    setLoading(false);
  }, []);
  useEffect(() => { if (role === "admin") load(); }, [role, load]);

  const post = useCallback(async (body: Record<string, unknown>, key: string, reload = true): Promise<boolean> => {
    setBusy(key); setError(null);
    try {
      const r = await fetch("/api/ig-engage", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j.error ?? "Failed");
      if (reload) await load();
      return true;
    } catch (e) { setError(e instanceof Error ? e.message : "Failed"); return false; }
    finally { setBusy(null); }
  }, [load]);

  const counts = useMemo(() => Object.fromEntries(FILTERS.map((f) => [f.key, (data?.clients ?? []).filter(f.test).length])) as Record<Filter, number>, [data]);
  const shown = useMemo(() => {
    const f = FILTERS.find((x) => x.key === filter)!;
    const s = q.trim().toLowerCase();
    return (data?.clients ?? []).filter(f.test).filter((c) => !s || c.username.includes(s) || (c.client_name ?? "").toLowerCase().includes(s));
  }, [data, filter, q]);
  const nameOf = useMemo(() => new Map((data?.clients ?? []).map((c) => [c.username, c.client_name ?? c.username])), [data]);
  const drafts = (data?.drafts ?? []).filter((d) => d.status === "draft");
  const approved = (data?.drafts ?? []).filter((d) => d.status === "approved");
  const followed = (data?.clients ?? []).filter((c) => c.followed_at).length;
  const followBack = (data?.clients ?? []).filter((c) => c.follows_us).length;

  if (roleLoading || role !== "admin") return null;
  const s = data?.settings;

  return (
    <div className="max-w-[1400px] mx-auto px-4 py-5 space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <h1 className="text-lg font-bold text-[#1f3559] mr-2">📸 Instagram</h1>
        <span className="text-sm text-[#64748b]">Our account follows and engages with every client through the Mac Mini — slowly, like a person.</span>
        {loading && <Loader2 className="w-4 h-4 animate-spin text-[#0e8f88]" />}
      </div>

      {error && <div className="rounded-lg border border-[#f5c2cf] bg-[#fde8ee] px-3 py-2 text-sm text-[#e11d48]">{error}</div>}
      {notice && <div className="rounded-lg border border-[#bfe8e3] bg-[#e6f7f5] px-3 py-2 text-sm text-[#0e8f88]">{notice}</div>}

      {data && s && (
        <div className="rounded-xl border border-[#d7e0ea] bg-white p-4 flex flex-wrap items-center gap-x-6 gap-y-3">
          <label className="inline-flex items-center gap-2 cursor-pointer text-sm font-semibold text-[#1f3559]">
            {busy === "enabled" ? <Loader2 className="w-4 h-4 animate-spin" /> :
              <input id="ige-enabled" type="checkbox" checked={s.enabled} className="accent-[#0e8f88] w-4 h-4"
                onChange={(e) => post({ action: "settings", enabled: e.target.checked }, "enabled")} />}
            {s.enabled ? "On" : "Off"}
          </label>
          <span className="text-sm text-[#64748b]">Warm-up week <b className="text-[#1f3559]">{data.week}</b> · <b className="text-[#1f3559]">{data.quota}</b> clients a day</span>
          <span className="text-sm text-[#64748b]">Next run: <b className="text-[#1f3559]">{data.nextRun}</b></span>
          <span className="text-sm text-[#64748b]">Following <b className="text-[#1f3559]">{followed}</b> · follow us back <b className="text-[#1f3559]">{followBack}</b></span>
          <label className="inline-flex items-center gap-2 cursor-pointer text-sm text-[#1f3559]" title="When on, every comment waits here for your yes before the Mac Mini posts it">
            {busy === "approve" ? <Loader2 className="w-4 h-4 animate-spin" /> :
              <input id="ige-approve" type="checkbox" checked={s.approveComments} className="accent-[#0e8f88]"
                onChange={(e) => post({ action: "settings", approveComments: e.target.checked }, "approve")} />}
            I approve comments first
          </label>
          <button onClick={async () => { if (await post({ action: "runNow" }, "run")) setNotice("Run sent to the Mac Mini — it starts within a minute."); }}
            disabled={!s.enabled || busy === "run"} title={s.enabled ? "Start today's run now instead of at its planned hour" : "Switch it on first"}
            className="ml-auto h-8 inline-flex items-center gap-1.5 rounded-lg bg-[#0e8f88] px-3 text-sm font-semibold text-white disabled:opacity-50">
            {busy === "run" ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Play className="w-3.5 h-3.5" />} Run today now
          </button>
          {s.pausedReason && <div className="w-full rounded-lg bg-[#fff7ec] border border-[#fcd9a8] px-3 py-1.5 text-sm text-[#b45309]">⚠ Switched off automatically — {s.pausedReason}. Wait a few days before turning it back on.</div>}
          {!s.startedAt && <div className="w-full text-xs text-[#64748b]">Before the first run: on the Mac Mini, sign in to Instagram as @pmubookings.ondemand in the AI Agent&apos;s Chrome (Terminal → node ~/.pmu-agent/agent-worker.mjs login → Instagram tab → tick &quot;Save login info&quot; → Cmd+Q).</div>}
        </div>
      )}

      {data && (drafts.length > 0 || approved.length > 0) && (
        <section className="space-y-2">
          <div className="flex items-center gap-2">
            <h2 className="text-sm font-bold text-[#1f3559]">Comments to approve <span className="text-[#64748b] font-normal">({drafts.length})</span></h2>
            {approved.length > 0 && <span className="text-xs text-[#64748b]">· {approved.length} approved, posting on the next run</span>}
            {drafts.length > 1 && (
              <button onClick={() => post({ action: "decide", ids: drafts.map((d) => d.id), decision: "approve" }, "all")} disabled={busy === "all"}
                className="ml-auto h-7 inline-flex items-center gap-1 rounded-full bg-[#0e8f88] px-3 text-xs font-semibold text-white disabled:opacity-60">
                {busy === "all" ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Check className="w-3.5 h-3.5" />} Approve all
              </button>
            )}
          </div>
          <div className="grid gap-2 md:grid-cols-2">
            {drafts.map((d) => (
              <div key={d.id} className="rounded-xl border border-[#d7e0ea] bg-white p-3 space-y-2">
                <div className="flex items-center gap-2 text-sm">
                  <b className="text-[#1f3559]">{nameOf.get(d.username)}</b>
                  <a href={d.post_url || ig(d.username)} target="_blank" rel="noreferrer" className="inline-flex items-center gap-0.5 text-[#0e8f88] text-xs">@{d.username} <ExternalLink className="w-3 h-3" /></a>
                  <span className="ml-auto text-xs text-[#a6b3c4]">{usDate(d.created_at)}</span>
                </div>
                {d.context && <div className="text-xs text-[#64748b]">Post: {d.context}</div>}
                <textarea id={`ige-draft-${d.id}`} rows={2} value={edits[d.id] ?? d.text ?? ""} onChange={(e) => setEdits((x) => ({ ...x, [d.id]: e.target.value }))}
                  className="w-full rounded-lg border border-[#d7e0ea] px-2 py-1.5 text-sm" />
                <div className="flex gap-2">
                  <button onClick={() => post({ action: "decide", id: d.id, decision: "approve", text: edits[d.id] ?? d.text }, `a:${d.id}`)} disabled={!!busy}
                    className="h-7 inline-flex items-center gap-1 rounded-full bg-[#0e8f88] px-3 text-xs font-semibold text-white disabled:opacity-60">
                    {busy === `a:${d.id}` ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Check className="w-3.5 h-3.5" />} Approve
                  </button>
                  <button onClick={() => post({ action: "decide", id: d.id, decision: "reject" }, `r:${d.id}`)} disabled={!!busy}
                    className="h-7 inline-flex items-center gap-1 rounded-full border border-[#d7e0ea] bg-white px-3 text-xs font-semibold text-[#64748b] disabled:opacity-60">
                    {busy === `r:${d.id}` ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <X className="w-3.5 h-3.5" />} Skip
                  </button>
                </div>
              </div>
            ))}
          </div>
        </section>
      )}

      {data && (
        <section className="space-y-2">
          <div className="flex flex-wrap items-center gap-1.5">
            <h2 className="text-sm font-bold text-[#1f3559] mr-2">Clients</h2>
            {FILTERS.map((f) => (
              <button key={f.key} onClick={() => setFilter(f.key)}
                className={cn("h-7 rounded-full px-3 text-xs font-semibold border", filter === f.key ? "bg-[#1f3559] border-[#1f3559] text-white" : "bg-white border-[#d7e0ea] text-[#1f3559] hover:border-[#1f3559]")}>
                {f.label} <span className="opacity-70">{counts[f.key]}</span>
              </button>
            ))}
            <div className="relative">
              <Search className="w-3.5 h-3.5 absolute left-2 top-2 text-[#a6b3c4]" />
              <input id="ige-search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Find a client"
                className="h-7 w-40 rounded-full border border-[#d7e0ea] bg-white pl-7 pr-2 text-xs" />
            </div>
            {adding === null ? (
              <button onClick={() => setAdding({ handle: "", name: "" })} className="h-7 inline-flex items-center gap-1 rounded-full border border-dashed border-[#0e8f88] px-3 text-xs font-semibold text-[#0e8f88]">
                <Plus className="w-3.5 h-3.5" /> Add account
              </button>
            ) : (
              <form className="inline-flex items-center gap-1" onSubmit={async (e) => { e.preventDefault(); if (await post({ action: "add", username: adding.handle, name: adding.name }, "add")) setAdding(null); }}>
                <input id="ige-add-handle" autoFocus value={adding.handle} onChange={(e) => setAdding({ ...adding, handle: e.target.value })} placeholder="@handle or link"
                  onKeyDown={(e) => { if (e.key === "Escape") setAdding(null); }} className="h-7 w-36 rounded-full border border-[#0e8f88] px-3 text-xs" />
                <input id="ige-add-name" value={adding.name} onChange={(e) => setAdding({ ...adding, name: e.target.value })} placeholder="Name (optional)"
                  className="h-7 w-36 rounded-full border border-[#d7e0ea] px-3 text-xs" />
                <button type="submit" disabled={busy === "add" || !adding.handle.trim()} className="h-7 inline-flex items-center gap-1 rounded-full bg-[#0e8f88] px-3 text-xs font-semibold text-white disabled:opacity-60">
                  {busy === "add" ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Plus className="w-3.5 h-3.5" />} Add
                </button>
              </form>
            )}
          </div>
          <div className="overflow-x-auto rounded-xl border border-[#d7e0ea] bg-white">
            <table className="w-full text-sm">
              <thead className="bg-[#f6f8fb] text-left text-xs text-[#64748b]">
                <tr>
                  <th className="px-3 py-2">Client</th><th className="px-3 py-2">Instagram</th><th className="px-3 py-2">Status</th>
                  <th className="px-3 py-2">Why / note</th><th className="px-3 py-2">We follow</th><th className="px-3 py-2">Follows us</th><th className="px-3 py-2">Last engaged</th>
                </tr>
              </thead>
              <tbody>
                {shown.map((c) => (
                  <tr key={c.username} className={cn("border-t border-[#eef2f7]", (c.status === "paused" || c.status === "blocked") && "opacity-70")}>
                    <td className="px-3 py-1.5 font-semibold text-[#1f3559]">{c.client_name ?? "—"}</td>
                    <td className="px-3 py-1.5"><a href={ig(c.username)} target="_blank" rel="noreferrer" className="text-[#0e8f88]">@{c.username}</a>
                      {c.last_error && <div className="text-xs text-[#e11d48]">{c.last_error}</div>}</td>
                    <td className="px-3 py-1.5">
                      <span className="inline-flex items-center gap-1">
                        <select id={`ige-status-${c.username}`} value={c.status} disabled={busy === `s:${c.username}`}
                          onChange={(e) => post({ action: "client", username: c.username, status: e.target.value }, `s:${c.username}`)}
                          className={cn("h-7 rounded-full px-2 text-xs font-semibold border-0", STATUS[c.status].cls)}>
                          {(Object.keys(STATUS) as Status[]).map((k) => <option key={k} value={k}>{STATUS[k].label}</option>)}
                        </select>
                        {busy === `s:${c.username}` && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
                      </span>
                    </td>
                    <td className="px-3 py-1.5">
                      <span className="inline-flex items-center gap-1">
                        <input id={`ige-note-${c.username}`} value={notes[c.username] ?? c.note ?? ""} placeholder={c.status === "blocked" || c.status === "paused" ? "Why?" : ""}
                          onChange={(e) => setNotes((x) => ({ ...x, [c.username]: e.target.value }))}
                          onBlur={() => { const v = notes[c.username]; if (v !== undefined && v !== (c.note ?? "")) post({ action: "client", username: c.username, note: v }, `n:${c.username}`); }}
                          className="h-7 w-52 rounded-lg border border-transparent hover:border-[#d7e0ea] focus:border-[#0e8f88] px-2 text-xs" />
                        {busy === `n:${c.username}` && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
                      </span>
                    </td>
                    <td className="px-3 py-1.5 text-xs">{c.followed_at ? <span className="text-[#15803d]">✓ {usDate(c.followed_at)}</span> : <span className="text-[#a6b3c4]">not yet</span>}</td>
                    <td className="px-3 py-1.5 text-xs">{c.follows_us == null ? <span className="text-[#a6b3c4]">—</span> : c.follows_us ? <span className="text-[#15803d]">✓ yes</span> : <span className="text-[#64748b]">no</span>}</td>
                    <td className="px-3 py-1.5 text-xs text-[#64748b]">{c.last_engaged_at ? `${usDate(c.last_engaged_at)} · ${c.last_action ?? ""}` : "—"}</td>
                  </tr>
                ))}
                {!shown.length && <tr><td colSpan={7} className="px-3 py-6 text-center text-sm text-[#a6b3c4]">No clients here</td></tr>}
              </tbody>
            </table>
          </div>
        </section>
      )}

      {data && (
        <section className="grid gap-4 md:grid-cols-2">
          <div className="space-y-2">
            <h2 className="text-sm font-bold text-[#1f3559]">What we did</h2>
            <div className="rounded-xl border border-[#d7e0ea] bg-white divide-y divide-[#eef2f7]">
              {data.recent.map((a) => (
                <div key={a.id} className="px-3 py-1.5 text-sm flex items-center gap-2">
                  <span className="text-xs text-[#a6b3c4] w-20 shrink-0">{usDate(a.done_at)}</span>
                  <span className="text-[#1f3559] font-semibold">{nameOf.get(a.username)}</span>
                  <span className="text-[#64748b]">{KIND[a.kind]}{a.text ? `: “${a.text}”` : ""}</span>
                  {a.post_url && <a href={a.post_url} target="_blank" rel="noreferrer" className="ml-auto text-[#0e8f88]"><ExternalLink className="w-3.5 h-3.5" /></a>}
                </div>
              ))}
              {!data.recent.length && <div className="px-3 py-6 text-center text-sm text-[#a6b3c4]">Nothing yet — the first run fills this in</div>}
            </div>
          </div>
          <div className="space-y-2">
            <h2 className="text-sm font-bold text-[#1f3559]">Mac Mini runs</h2>
            <div className="rounded-xl border border-[#d7e0ea] bg-white divide-y divide-[#eef2f7]">
              {data.runs.map((r) => (
                <div key={r.id} className="px-3 py-2 text-sm space-y-1">
                  <div className="flex items-center gap-2">
                    <span className="text-xs text-[#a6b3c4]">{usDate(r.created_at)}</span>
                    <span className={cn("text-xs font-semibold", r.status === "done" ? "text-[#15803d]" : r.status === "failed" || r.status === "needs_teammate" ? "text-[#e11d48]" : "text-[#0e8f88]")}>
                      {r.status === "queued_browser" ? "waiting" : r.status === "needs_teammate" ? "needs you" : r.status}
                    </span>
                    {(r.screenshots ?? []).map((sh) => <a key={sh.url} href={sh.url} target="_blank" rel="noreferrer" className="text-xs text-[#0e8f88] underline">{sh.name}</a>)}
                  </div>
                  {r.result && <div className="text-xs text-[#64748b] whitespace-pre-line line-clamp-4">{r.result}</div>}
                </div>
              ))}
              {!data.runs.length && <div className="px-3 py-6 text-center text-sm text-[#a6b3c4]">No runs yet</div>}
            </div>
          </div>
        </section>
      )}
    </div>
  );
}
