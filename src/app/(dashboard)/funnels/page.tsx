"use client";
import { useCallback, useEffect, useState } from "react";
import { useUser } from "@/lib/hooks/useUser";
import { Loader2, RefreshCw, Plus, ExternalLink, Stethoscope, Check, X, Save } from "lucide-react";
import { cn } from "@/lib/utils";

// Funnels — the one-box funnels hosted on Vercel: which client has one,
// its live URL, health, leads and bookings. Content itself is edited in
// each sub-account's GHL custom values; this tab manages existence,
// status and the per-client extras (Fanbasis block, widget, pixel).

type Funnel = {
  slug: string; locationId: string; clientName: string; status: string;
  cvSyncedAt: string | null; url: string;
  hasCalendar: boolean; hasFanbasis: boolean; hasWidget: boolean; hasPixel: boolean;
  oldFunnelUrl: string;
  leads: number; booked: number; lastLeadAt: string | null;
};
type HealthCheck = { name: string; ok: boolean; note: string };

function ago(iso: string | null): string {
  if (!iso) return "never";
  const mins = Math.round((Date.now() - new Date(iso).getTime()) / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const h = Math.round(mins / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.round(h / 24)}d ago`;
}

function Dot({ ok, label }: { ok: boolean; label: string }) {
  return (
    <span className={cn("inline-flex items-center gap-1 text-[11px] font-medium rounded-full border px-2 py-0.5",
      ok ? "bg-[#e7f6ec] text-[#15803d] border-[#bfe3cd]" : "bg-[#fef2f2] text-[#b91c1c] border-[#fca5a5]")}>
      {ok ? <Check className="w-3 h-3" /> : <X className="w-3 h-3" />}{label}
    </span>
  );
}

export default function FunnelsPage() {
  const { role, loading: userLoading } = useUser();
  const [funnels, setFunnels] = useState<Funnel[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [health, setHealth] = useState<Record<string, HealthCheck[]>>({});
  const [showAdd, setShowAdd] = useState(false);
  const [addForm, setAddForm] = useState({ clientName: "", slug: "", locationId: "", oldFunnelUrl: "" });
  const [addNote, setAddNote] = useState<string | null>(null);
  const [extrasFor, setExtrasFor] = useState<string | null>(null);
  const [extrasForm, setExtrasForm] = useState({ fanbasisHtml: "", elfsightId: "", resultImgs: "", metaPixelId: "", oldFunnelUrl: "" });
  const [toast, setToast] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const r = await fetch("/api/onebox/admin");
      const j = await r.json();
      setFunnels(j.funnels ?? []);
    } finally { setLoading(false); }
  }, []);
  useEffect(() => { void load(); }, [load]);

  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 4000);
    return () => clearTimeout(t);
  }, [toast]);

  async function act(action: string, slug: string, extra: Record<string, string> = {}) {
    setBusy(`${action}:${slug}`);
    try {
      const r = await fetch("/api/onebox/admin", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action, slug, ...extra }),
      });
      const j = await r.json();
      if (action === "health") setHealth((h) => ({ ...h, [slug]: j.checks ?? [] }));
      else if (j.error) setToast(`Error: ${j.error}`);
      else setToast(action === "resync" ? "Synced from GHL ✓" : "Saved ✓");
      if (action !== "health") await load();
    } finally { setBusy(null); }
  }

  async function addFunnel() {
    setBusy("add");
    setAddNote(null);
    try {
      const r = await fetch("/api/onebox/admin", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "add", ...addForm }),
      });
      const j = await r.json();
      if (j.error) { setAddNote(`Error: ${j.error}`); return; }
      setAddNote(`Created ${j.url} — ${j.pixelNote}${j.calendarId ? "" : " · ⚠ no calendar id in custom values"}`);
      setAddForm({ clientName: "", slug: "", locationId: "", oldFunnelUrl: "" });
      await load();
    } finally { setBusy(null); }
  }

  if (userLoading) return <div className="p-8 text-[#697a91]"><Loader2 className="w-5 h-5 animate-spin" /></div>;
  if (role !== "admin") return <div className="p-8 text-[#697a91]">Admins only.</div>;

  return (
    <div className="p-4 md:p-6 max-w-[1200px] mx-auto">
      <div className="flex items-center justify-between mb-1">
        <h1 className="text-lg font-semibold text-[#1c2b3a]">🧪 One-Box Funnels</h1>
        <div className="flex gap-2">
          <button onClick={() => void load()} className="flex items-center gap-1.5 text-sm border border-[#e4ebf2] rounded-lg px-3 py-1.5 hover:bg-[#f6f9fc]">
            <RefreshCw className={cn("w-4 h-4", loading && "animate-spin")} /> Refresh
          </button>
          <button onClick={() => setShowAdd((s) => !s)} className="flex items-center gap-1.5 text-sm bg-[#0e9c9c] text-white rounded-lg px-3 py-1.5 hover:bg-[#0b8383]">
            <Plus className="w-4 h-4" /> Add client
          </button>
        </div>
      </div>
      <p className="text-xs text-[#697a91] mb-4">
        Funnel content is edited in each sub-account&apos;s GHL <b>custom values</b> (changes go live within ~5 minutes, or hit Sync now).
        This tab manages which funnels exist, their status, health and per-client extras.
      </p>

      {toast && <div className="mb-3 text-sm bg-[#e7f6ec] border border-[#bfe3cd] text-[#15803d] rounded-lg px-3 py-2">{toast}</div>}

      {showAdd && (
        <div className="mb-4 border border-[#e4ebf2] rounded-xl p-4 bg-white">
          <div className="font-medium text-sm mb-3 text-[#1c2b3a]">Add a client funnel</div>
          <div className="grid md:grid-cols-2 gap-3">
            <input placeholder="Client / business name" value={addForm.clientName}
              onChange={(e) => setAddForm((f) => ({ ...f, clientName: e.target.value, slug: f.slug || e.target.value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") }))}
              className="border border-[#e4ebf2] rounded-lg px-3 py-2 text-sm" />
            <input placeholder="Slug (URL path, e.g. pmu-by-ivan)" value={addForm.slug}
              onChange={(e) => setAddForm((f) => ({ ...f, slug: e.target.value }))}
              className="border border-[#e4ebf2] rounded-lg px-3 py-2 text-sm" />
            <input placeholder="GHL sub-account (location) ID" value={addForm.locationId}
              onChange={(e) => setAddForm((f) => ({ ...f, locationId: e.target.value }))}
              className="border border-[#e4ebf2] rounded-lg px-3 py-2 text-sm" />
            <input placeholder="Current funnel URL (for pixel harvest, optional)" value={addForm.oldFunnelUrl}
              onChange={(e) => setAddForm((f) => ({ ...f, oldFunnelUrl: e.target.value }))}
              className="border border-[#e4ebf2] rounded-lg px-3 py-2 text-sm" />
          </div>
          <div className="mt-3 flex items-center gap-3">
            <button onClick={() => void addFunnel()} disabled={busy === "add"}
              className="flex items-center gap-1.5 text-sm bg-[#0e9c9c] text-white rounded-lg px-4 py-2 hover:bg-[#0b8383] disabled:opacity-50">
              {busy === "add" ? <Loader2 className="w-4 h-4 animate-spin" /> : <Plus className="w-4 h-4" />} Create &amp; sync from GHL
            </button>
            {addNote && <span className="text-xs text-[#697a91]">{addNote}</span>}
          </div>
          <p className="text-[11px] text-[#697a91] mt-2">
            Created funnels start <b>paused</b> — add the Fanbasis block in Extras, run a health check, then flip to Live.
          </p>
        </div>
      )}

      {loading ? (
        <div className="p-10 text-center text-[#697a91]"><Loader2 className="w-5 h-5 animate-spin inline" /></div>
      ) : funnels.length === 0 ? (
        <div className="p-10 text-center text-[#697a91] text-sm">No funnels yet — add the first client.</div>
      ) : (
        <div className="space-y-3">
          {funnels.map((f) => (
            <div key={f.slug} className="border border-[#e4ebf2] rounded-xl bg-white p-4">
              <div className="flex flex-wrap items-center gap-3">
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="font-medium text-[#1c2b3a]">{f.clientName || f.slug}</span>
                    <span className={cn("text-[11px] font-semibold rounded-full px-2 py-0.5 border",
                      f.status === "live" ? "bg-[#e7f6ec] text-[#15803d] border-[#bfe3cd]" : "bg-[#fff3e6] text-[#c2410c] border-[#fdba74]")}>
                      {f.status.toUpperCase()}
                    </span>
                  </div>
                  <a href={f.url} target="_blank" rel="noopener" className="text-xs text-[#0e9c9c] hover:underline inline-flex items-center gap-1">
                    {f.url} <ExternalLink className="w-3 h-3" />
                  </a>
                  {f.oldFunnelUrl && (
                    <div className="text-[11px] text-[#697a91]">
                      redirect: <a href={f.oldFunnelUrl} target="_blank" rel="noopener" className="hover:underline">{f.oldFunnelUrl}</a>
                      {" → "}
                      <span className="text-[#0e9c9c]">{f.url}</span>
                    </div>
                  )}
                </div>
                <div className="flex-1" />
                <div className="text-right text-xs text-[#697a91]">
                  <div><b className="text-[#1c2b3a] text-sm">{f.leads}</b> leads · <b className="text-[#1c2b3a] text-sm">{f.booked}</b> booked</div>
                  <div>last lead {ago(f.lastLeadAt)} · synced {ago(f.cvSyncedAt)}</div>
                </div>
              </div>

              <div className="mt-3 flex flex-wrap items-center gap-1.5">
                <Dot ok={f.hasCalendar} label="calendar" />
                <Dot ok={f.hasFanbasis} label="fanbasis" />
                <Dot ok={f.hasWidget} label="results widget" />
                <Dot ok={f.hasPixel} label="pixel" />
                <div className="flex-1" />
                <button onClick={() => void act("resync", f.slug)} disabled={busy === `resync:${f.slug}`}
                  className="text-xs border border-[#e4ebf2] rounded-lg px-2.5 py-1 hover:bg-[#f6f9fc] inline-flex items-center gap-1">
                  {busy === `resync:${f.slug}` ? <Loader2 className="w-3 h-3 animate-spin" /> : <RefreshCw className="w-3 h-3" />} Sync now
                </button>
                <button onClick={() => void act("health", f.slug)} disabled={busy === `health:${f.slug}`}
                  className="text-xs border border-[#e4ebf2] rounded-lg px-2.5 py-1 hover:bg-[#f6f9fc] inline-flex items-center gap-1">
                  {busy === `health:${f.slug}` ? <Loader2 className="w-3 h-3 animate-spin" /> : <Stethoscope className="w-3 h-3" />} Health check
                </button>
                <button onClick={() => { setExtrasFor(extrasFor === f.slug ? null : f.slug); setExtrasForm({ fanbasisHtml: "", elfsightId: "", resultImgs: "", metaPixelId: "", oldFunnelUrl: "" }); }}
                  className="text-xs border border-[#e4ebf2] rounded-lg px-2.5 py-1 hover:bg-[#f6f9fc]">
                  Extras
                </button>
                <button onClick={() => void act("status", f.slug, { status: f.status === "live" ? "paused" : "live" })}
                  disabled={busy === `status:${f.slug}`}
                  className={cn("text-xs rounded-lg px-2.5 py-1 border font-medium",
                    f.status === "live" ? "border-[#fdba74] text-[#c2410c] hover:bg-[#fff3e6]" : "border-[#bfe3cd] text-[#15803d] hover:bg-[#e7f6ec]")}>
                  {f.status === "live" ? "Pause" : "Go live"}
                </button>
              </div>

              {health[f.slug] && (
                <div className="mt-3 border-t border-[#eef2f6] pt-2 grid md:grid-cols-2 gap-1">
                  {health[f.slug].map((c) => (
                    <div key={c.name} className="text-xs flex items-center gap-2">
                      {c.ok ? <Check className="w-3.5 h-3.5 text-[#15803d]" /> : <X className="w-3.5 h-3.5 text-[#b91c1c]" />}
                      <span className="text-[#1c2b3a]">{c.name}</span>
                      <span className="text-[#697a91]">— {c.note}</span>
                    </div>
                  ))}
                </div>
              )}

              {extrasFor === f.slug && (
                <div className="mt-3 border-t border-[#eef2f6] pt-3 grid gap-2">
                  <p className="text-[11px] text-[#697a91]">
                    Leave a field empty to keep its current value. Instagram widget accepts the Elfsight ID, the elf.site link, or the whole embed code.
                  </p>
                  <textarea placeholder="Fanbasis checkout block (paste the whole custom-code block from the client's -last-step page)"
                    value={extrasForm.fanbasisHtml} onChange={(e) => setExtrasForm((x) => ({ ...x, fanbasisHtml: e.target.value }))}
                    rows={3} className="border border-[#e4ebf2] rounded-lg px-3 py-2 text-xs font-mono" />
                  <div className="grid md:grid-cols-3 gap-2">
                    <input placeholder="Instagram widget (Elfsight ID / link / code)" value={extrasForm.elfsightId}
                      onChange={(e) => setExtrasForm((x) => ({ ...x, elfsightId: e.target.value }))}
                      className="border border-[#e4ebf2] rounded-lg px-3 py-2 text-xs" />
                    <input placeholder="Result image URLs, comma-separated" value={extrasForm.resultImgs}
                      onChange={(e) => setExtrasForm((x) => ({ ...x, resultImgs: e.target.value }))}
                      className="border border-[#e4ebf2] rounded-lg px-3 py-2 text-xs" />
                    <input placeholder="Meta pixel ID" value={extrasForm.metaPixelId}
                      onChange={(e) => setExtrasForm((x) => ({ ...x, metaPixelId: e.target.value }))}
                      className="border border-[#e4ebf2] rounded-lg px-3 py-2 text-xs" />
                  </div>
                  <input placeholder="Old funnel URL this one replaces (shows the redirect from → to line)"
                    value={extrasForm.oldFunnelUrl}
                    onChange={(e) => setExtrasForm((x) => ({ ...x, oldFunnelUrl: e.target.value }))}
                    className="border border-[#e4ebf2] rounded-lg px-3 py-2 text-xs" />
                  <div>
                    <button onClick={() => {
                      const payload: Record<string, string> = {};
                      if (extrasForm.fanbasisHtml.trim()) payload.fanbasisHtml = extrasForm.fanbasisHtml;
                      if (extrasForm.elfsightId.trim()) payload.elfsightId = extrasForm.elfsightId;
                      if (extrasForm.resultImgs.trim()) payload.resultImgs = extrasForm.resultImgs;
                      if (extrasForm.metaPixelId.trim()) payload.metaPixelId = extrasForm.metaPixelId;
                      if (extrasForm.oldFunnelUrl.trim()) payload.oldFunnelUrl = extrasForm.oldFunnelUrl;
                      void act("extras", f.slug, payload);
                      setExtrasFor(null);
                    }} disabled={busy === `extras:${f.slug}`}
                      className="flex items-center gap-1.5 text-xs bg-[#0e9c9c] text-white rounded-lg px-3 py-1.5 hover:bg-[#0b8383]">
                      <Save className="w-3.5 h-3.5" /> Save extras
                    </button>
                  </div>
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
