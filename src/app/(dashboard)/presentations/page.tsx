"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { Camera, Check, Copy, ExternalLink, Loader2 } from "lucide-react";
import { useUser } from "@/lib/hooks/useUser";
import { cn } from "@/lib/utils";
import { PhotoCropper } from "@/components/presentations/PhotoCropper";

/* 🎬 Presentations (owner, 11/26/2026): one place where a Client Success
   Coach finds every deck and tool she shows on a client call, with one line
   on when to use it — and where she uploads her profile picture once. The
   Launch Call decks read that picture (and her email) when they are opened
   from here, through the ?coach=<name> on each link. */

type Profile = { slug: string; name: string; email: string; photo: string | null; phone?: string | null };

// The decks live on the public booking domain so the link works on any screen.
const BASE = "https://book.pmu-care.com";

const DECKS: Array<{ icon: string; name: string; path: string; when: string; what: string; personal?: boolean }> = [
  {
    icon: "⚡", name: "Quick Start Call", path: "/deck/quick-start",
    when: "Right after the setter closes a pay-per-appointment artist (brows under $400).",
    what: "Show what they get, connect their Facebook, fill the onboarding form. One call.",
  },
  {
    icon: "🚀", name: "Launch Call · Standard", path: "/deck/launch", personal: true,
    when: "Just before the ads go live, for clients on the standard program.",
    what: "The client journey, the 7 steps, what to expect, the Facebook group, questions, go live.",
  },
  {
    icon: "🚀", name: "Launch Call · Pay Per Appointment", path: "/deck/launch-ppa", personal: true,
    when: "Just before the ads go live, for pay-per-appointment clients.",
    what: "Same slides. Calling the leads is shown as optional, to maximize their results.",
  },
  {
    icon: "🧮", name: "ROI Calculator", path: "/roi-calculator",
    when: "On a strategy call, when a client could grow with a bigger ad budget.",
    what: "Move the ad spend and show the extra bookings and money it can bring.",
  },
];

function Avatar({ p, size }: { p: Profile; size: number }) {
  return p.photo
    // eslint-disable-next-line @next/next/no-img-element
    ? <img src={p.photo} alt="" width={size} height={size} className="shrink-0 rounded-2xl border border-[#e4ebf2] object-cover" style={{ width: size, height: size }} />
    : <div className="flex shrink-0 items-center justify-center rounded-2xl border border-dashed border-[#c9d5e2] bg-[#f4f7fa] font-bold text-[#8595a8]" style={{ width: size, height: size, fontSize: size * 0.4 }}>{(p.name[0] ?? "?").toUpperCase()}</div>;
}

export default function PresentationsPage() {
  const { role, loading: roleLoading } = useUser();
  const [me, setMe] = useState<Profile | null>(null);
  const [coaches, setCoaches] = useState<Profile[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [copied, setCopied] = useState("");
  const [pick, setPick] = useState<{ file: File; who: Profile } | null>(null);
  const [showCoaches, setShowCoaches] = useState(false);
  const [openAs, setOpenAs] = useState("");
  const fileRef = useRef<HTMLInputElement>(null);
  const target = useRef<Profile | null>(null);

  const load = useCallback(async () => {
    try {
      const r = await fetch("/api/presentations", { cache: "no-store" });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error ?? "Couldn't load");
      setMe(j.me); setCoaches(j.coaches ?? []); setError("");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't load");
    } finally { setLoading(false); }
  }, []);
  useEffect(() => { load(); }, [load]);

  const choose = (who: Profile) => { target.current = who; fileRef.current?.click(); };
  const save = async (jpeg: Blob) => {
    if (!pick) return;
    const fd = new FormData();
    fd.append("file", jpeg, "picture.jpg");
    if (me && pick.who.slug !== me.slug) fd.append("slug", pick.who.slug);
    const r = await fetch("/api/presentations", { method: "POST", body: fd });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j.error ?? "Couldn't save the picture");
    setPick(null);
    await load();
  };

  /* Whose picture, email and phone the Launch Call shows. A coach always opens
     her own. Someone who is not a coach (the owner) has no picture of their own
     there, so they pick which coach to open it as — the first one by default.
     (11/26/2026: the owner opened his own link and saw no picture.) */
  const presenters = coaches.length ? [...coaches, ...(me?.photo ? [me] : [])] : [];
  const presenter = presenters.find((c) => c.slug === openAs) ?? presenters[0] ?? me;
  const linkFor = (d: (typeof DECKS)[number]) => `${BASE}${d.path}${d.personal && presenter?.slug ? `?coach=${presenter.slug}` : ""}`;
  const copy = async (url: string) => {
    try { await navigator.clipboard.writeText(url); setCopied(url); setTimeout(() => setCopied(""), 1800); } catch { /* clipboard blocked: the Open button still works */ }
  };

  if (roleLoading) return <div className="flex h-full items-center justify-center"><Loader2 className="animate-spin text-[#15B7AE]" /></div>;
  if (role !== "admin" && role !== "editor") return <div className="p-8 text-sm text-[#697a91]">Admins and coaches only.</div>;

  return (
    <div className="mx-auto max-w-3xl p-3 md:p-4">
      <div className="mb-4 flex flex-wrap items-baseline gap-2">
        <h1 className="text-lg font-bold text-[#1f3559]">🎬 Presentations</h1>
        <span className="text-xs text-[#8595a8]">your decks and tools for client calls</span>
      </div>
      {error && <div className="mb-3 rounded-lg border border-[#fecaca] bg-[#fef2f2] px-3 py-2 text-sm text-[#b91c1c]">{error}</div>}
      <input ref={fileRef} type="file" accept="image/*" className="hidden"
        onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ""; if (f && target.current) setPick({ file: f, who: target.current }); }} />

      {loading ? (
        <div className="flex justify-center py-10"><Loader2 className="animate-spin text-[#15B7AE]" /></div>
      ) : (
        <>
          {me && (
            <div className="mb-4 flex items-center gap-3 rounded-xl border border-[#e4ebf2] bg-white p-3">
              <Avatar p={me} size={72} />
              <div className="min-w-0 flex-1">
                <div className="text-sm font-semibold text-[#1c2b3a]">Your picture</div>
                <div className="mt-0.5 text-xs text-[#4a5a6e]">
                  {me.photo ? "Clients see it on the intro slide of your Launch Call." : "Add one — clients see it on the intro slide of your Launch Call."}
                </div>
                {role === "editor" && coaches.length === 0 && (
                  <div className="mt-0.5 truncate text-xs text-[#8595a8]">Your contact slide: {me.email}{me.phone ? ` · ${me.phone}` : ""}</div>
                )}
              </div>
              <button onClick={() => choose(me)} className="inline-flex shrink-0 items-center gap-1.5 rounded-lg bg-[#15B7AE] px-3 py-1.5 text-sm font-semibold text-white hover:bg-[#0e8f88]">
                <Camera className="h-3.5 w-3.5" />{me.photo ? "Change" : "Upload"}
              </button>
            </div>
          )}

          {presenters.length > 0 && (
            <div className="mb-3 flex flex-wrap items-center gap-2">
              <span className="text-xs font-semibold text-[#4a5a6e]">Open the Launch Call as:</span>
              {presenters.map((c) => (
                <button key={c.slug} onClick={() => setOpenAs(c.slug)}
                  className={cn("inline-flex items-center gap-1.5 rounded-full border py-0.5 pl-0.5 pr-3 text-sm font-semibold",
                    presenter?.slug === c.slug ? "border-[#15B7AE] bg-[#effaf9] text-[#0e8f88]" : "border-[#e4ebf2] bg-white text-[#4a5a6e] hover:bg-[#f4f7fa]")}>
                  <Avatar p={c} size={26} />{c.slug === me?.slug ? "Me" : c.name}
                </button>
              ))}
            </div>
          )}

          <div className="grid gap-3 sm:grid-cols-2">
            {DECKS.map((d) => {
              const url = linkFor(d);
              return (
                <div key={d.path} className="flex flex-col rounded-xl border border-[#e4ebf2] bg-white p-3">
                  <div className="text-sm font-bold text-[#1f3559]">{d.icon} {d.name}</div>
                  <div className="mt-1.5 text-xs text-[#4a5a6e]"><span className="font-semibold text-[#0e8f88]">When: </span>{d.when}</div>
                  <div className="mt-1 text-xs text-[#4a5a6e]"><span className="font-semibold text-[#0e8f88]">What: </span>{d.what}</div>
                  <div className="mt-auto flex gap-2 pt-3">
                    <a href={url} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1.5 rounded-lg bg-[#1f3559] px-3 py-1.5 text-sm font-semibold text-white hover:bg-[#16284a]">
                      <ExternalLink className="h-3.5 w-3.5" />Open
                    </a>
                    <button onClick={() => copy(url)} className={cn("inline-flex items-center gap-1.5 rounded-lg border px-3 py-1.5 text-sm font-semibold", copied === url ? "border-[#bbf7d0] bg-[#f0fdf4] text-[#15803d]" : "border-[#e4ebf2] text-[#4a5a6e] hover:bg-[#f4f7fa]")}>
                      {copied === url ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}{copied === url ? "Copied" : "Copy link"}
                    </button>
                  </div>
                </div>
              );
            })}
          </div>

          {role === "admin" && coaches.length > 0 && (
            <div className="mt-4 rounded-xl border border-[#e4ebf2] bg-white">
              <button onClick={() => setShowCoaches((o) => !o)} className="flex w-full items-center gap-2 px-3 py-2.5 text-left">
                <span className="text-sm font-semibold text-[#1f3559]">Coach pictures</span>
                <span className="text-xs text-[#8595a8]">{coaches.filter((c) => c.photo).length} of {coaches.length} added</span>
                <span className="ml-auto text-xs text-[#697a91]">{showCoaches ? "▲" : "▼"}</span>
              </button>
              {showCoaches && coaches.map((c) => (
                <div key={c.slug} className="flex items-center gap-3 border-t border-[#eef3f8] px-3 py-2.5">
                  <Avatar p={c} size={44} />
                  <div className="min-w-0 flex-1">
                    <div className="text-sm font-semibold text-[#1c2b3a]">{c.name}</div>
                    <div className="truncate text-xs text-[#8595a8]">{c.email}{c.phone ? ` · ${c.phone}` : ""}</div>
                  </div>
                  <button onClick={() => choose(c)} className="inline-flex shrink-0 items-center gap-1.5 rounded-lg border border-[#e4ebf2] px-2.5 py-1 text-xs font-semibold text-[#0e8f88] hover:bg-[#effaf9]">
                    <Camera className="h-3 w-3" />{c.photo ? "Change" : "Upload"}
                  </button>
                </div>
              ))}
            </div>
          )}
        </>
      )}

      {pick && <PhotoCropper file={pick.file} who={pick.who.name} onCancel={() => setPick(null)} onSave={save} />}
    </div>
  );
}
