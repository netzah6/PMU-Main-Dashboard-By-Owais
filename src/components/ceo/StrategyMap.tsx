"use client";
import { useEffect, useState } from "react";
import { ChevronDown, ChevronRight } from "lucide-react";

/* 🗺 Road to $225K (owner, 11/25/2026): the plan as a picture, because he
   "sees it and then forgets". 300 artists x $750 = $225K a month. The change:
   pay per appointment becomes the easy door (downsell after the upfront
   offer), only for brows under $400 and $20+ a day on ads. Mostly drawings,
   very few words (owner: "less text, more visual"). The short strip is always
   on screen; the drawings open on a click and the choice is remembered.
   Nothing here is live data: the numbers are the plan's own, set below. */

const ARTISTS = 300;
const GOAL = 225_000;
const DEPOSIT = 50; // kept from each lead's deposit
const FEE = 80; // paid by the artist per appointment
const PER_BOOKING = DEPOSIT + FEE;
// Paid bookings a month for one artist. 4 and 12 are what we saw in the last
// 30 days (11/25/2026 study: average at $20 a day, and the best artists).
const ROWS: Array<{ n: number; label: string; color: string }> = [
  { n: 4, label: "Average today", color: "#8595a8" },
  { n: 6, label: "Plan", color: "#B4236C" },
  { n: 7, label: "Plan", color: "#B4236C" },
  { n: 12, label: "Best artists today", color: "#0f8f88" },
];

const INK = "#1f3559";
const MUTED = "#697a91";
const RULE = "#e4ebf2";
const UP = "#0f8f88"; // pays upfront
const UP_SOFT = "#e6f7f5";
const PPA = "#B4236C"; // pay per appointment
const PPA_SOFT = "#F9E1EC";
const LATER = "#8595a8";
const OPEN_KEY = "pmu-ceo-road225-open";

const kUsd = (n: number) => `$${Math.round(n / 1000)}K`;
const usd = (n: number) => `$${n.toLocaleString("en-US")}`;

function Panel({ title, dashed, children }: { title: string; dashed?: boolean; children: React.ReactNode }) {
  return (
    <figure className={`mb-2.5 break-inside-avoid rounded-lg p-3 min-w-0 ${dashed ? "border-2 border-dashed border-[#b8c2cf]" : "border border-[#e4ebf2] bg-[#fbfdfe]"}`}>
      <figcaption className="text-[12px] font-semibold uppercase tracking-wide text-[#8595a8] mb-2">{title}</figcaption>
      {children}
    </figure>
  );
}

function Sum({ parts, total }: { parts: Array<[string, string]>; total: [string, string] }) {
  return (
    <div className="flex flex-wrap items-stretch gap-1.5">
      {parts.map(([big, small], i) => (
        <div key={small} className="flex items-stretch gap-1.5">
          {i > 0 && <span className="self-center text-[#8595a8] font-semibold">{small === "each" ? "×" : "+"}</span>}
          <div className="rounded-lg border border-[#e4ebf2] bg-white px-2.5 py-1">
            <b className="block text-[17px] leading-tight text-[#1f3559] tabular-nums">{big}</b>
            <span className="text-[11px] text-[#697a91]">{small}</span>
          </div>
        </div>
      ))}
      <span className="self-center text-[#8595a8] font-semibold">=</span>
      <div className="rounded-lg bg-[#1f3559] px-2.5 py-1">
        <b className="block text-[17px] leading-tight text-white tabular-nums">{total[0]}</b>
        <span className="text-[11px] text-white/75">{total[1]}</span>
      </div>
    </div>
  );
}

const SVG = "block w-full h-auto max-w-[420px] mx-auto";

function GoalDots() {
  return (
    <svg viewBox="0 0 300 144" className={SVG} role="img" aria-label="300 dots. Each dot is one artist.">
      <defs>
        <pattern id="road225-artist" width="12" height="12" patternUnits="userSpaceOnUse">
          <circle cx="6" cy="6" r="3.7" fill={INK} />
        </pattern>
      </defs>
      <rect width="300" height="144" fill="url(#road225-artist)" />
    </svg>
  );
}

function Doors() {
  const crowd: Array<[number, number]> = [];
  for (const y of [134, 112, 90]) for (const x of [209, 233, 257, 281]) crowd.push([x, y]);
  crowd.push([233, 68], [257, 68]);
  return (
    <svg viewBox="0 0 360 184" className={SVG} role="img"
      aria-label="Two doors. The upfront door is narrow and few artists come in. The pay per appointment door is wide and many artists come in.">
      <line x1="16" y1="150" x2="344" y2="150" stroke={INK} strokeWidth="3" strokeLinecap="round" />
      <path d="M50 150 V70 a22 22 0 0 1 44 0 V150" fill="#fff" stroke={UP} strokeWidth="4" strokeLinecap="round" strokeLinejoin="round" />
      <circle cx="72" cy="134" r="7" fill={UP} />
      <circle cx="72" cy="112" r="7" fill={UP} />
      <text x="72" y="174" textAnchor="middle" fontSize="14" fontWeight="700" fill={UP}>Upfront</text>
      <path d="M180 150 V95 a65 65 0 0 1 130 0 V150" fill="#fff" stroke={PPA} strokeWidth="4" strokeLinecap="round" strokeLinejoin="round" />
      {crowd.map(([x, y]) => <circle key={`${x}-${y}`} cx={x} cy={y} r="7" fill={PPA} />)}
      <text x="245" y="174" textAnchor="middle" fontSize="14" fontWeight="700" fill={PPA}>Pay per appointment</text>
    </svg>
  );
}

function SalesPath() {
  return (
    <svg viewBox="0 0 360 584" className={SVG} role="img"
      aria-label="Ads, then appointment setter, then closer. The closer first offers pay upfront. If yes, upfront client. If no, and brows are under 400 dollars, the closer offers pay per appointment.">
      <g stroke={UP} strokeWidth="5" strokeLinecap="round">
        <line x1="100" y1="74" x2="100" y2="104" />
        <line x1="100" y1="174" x2="100" y2="204" />
        <line x1="100" y1="274" x2="100" y2="306" />
      </g>
      <g fill={UP}>
        <polygon points="92,104 108,104 100,115" />
        <polygon points="92,204 108,204 100,215" />
        <polygon points="92,306 108,306 100,317" />
      </g>

      {/* Ads */}
      <circle cx="100" cy="44" r="29" fill="#fff" stroke={UP} strokeWidth="4" />
      <polygon points="87,40 87,49 95,49 109,56 109,33 95,40" fill={UP} />
      <path d="M114 39 q5 5.5 0 11" fill="none" stroke={UP} strokeWidth="2.5" strokeLinecap="round" />
      <text x="146" y="50" fontSize="18" fontWeight="700" fill={INK}>Ads</text>

      {/* Appointment setter */}
      <circle cx="100" cy="144" r="29" fill="#fff" stroke={UP} strokeWidth="4" />
      <rect x="87" y="133" width="26" height="24" rx="4" fill="none" stroke={UP} strokeWidth="2.5" />
      <line x1="87" y1="141" x2="113" y2="141" stroke={UP} strokeWidth="2.5" />
      <line x1="94" y1="129" x2="94" y2="136" stroke={UP} strokeWidth="2.5" strokeLinecap="round" />
      <line x1="106" y1="129" x2="106" y2="136" stroke={UP} strokeWidth="2.5" strokeLinecap="round" />
      <path d="M94 149 l4 4 l8 -8" fill="none" stroke={UP} strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" />
      <text x="146" y="150" fontSize="18" fontWeight="700" fill={INK}>Appointment setter</text>

      {/* Closer */}
      <circle cx="100" cy="244" r="29" fill="#fff" stroke={UP} strokeWidth="4" />
      <rect x="84" y="235" width="21" height="18" rx="4" fill="none" stroke={UP} strokeWidth="2.5" />
      <polygon points="108,241 117,236 117,252 108,247" fill={UP} />
      <text x="146" y="250" fontSize="18" fontWeight="700" fill={INK}>Closer</text>

      {/* Offer 1 */}
      <rect x="16" y="320" width="204" height="64" rx="14" fill={UP} />
      <text x="32" y="344" fontSize="11" fontWeight="700" letterSpacing="1.4" fill="#fff">OFFER 1</text>
      <text x="32" y="369" fontSize="18" fontWeight="700" fill="#fff">Pay upfront</text>
      <line x1="220" y1="352" x2="260" y2="352" stroke={UP} strokeWidth="4" strokeLinecap="round" />
      <polygon points="259,345 259,359 270,352" fill={UP} />
      <text x="241" y="343" textAnchor="middle" fontSize="13" fontWeight="700" fill={UP}>yes</text>
      <circle cx="300" cy="352" r="27" fill={UP_SOFT} stroke={UP} strokeWidth="3" />
      <path d="M289 353 l8 8 l15 -17" fill="none" stroke={UP} strokeWidth="4" strokeLinecap="round" strokeLinejoin="round" />
      <text x="300" y="399" textAnchor="middle" fontSize="13" fontWeight="700" fill={UP}>Upfront</text>
      <text x="300" y="415" textAnchor="middle" fontSize="13" fontWeight="700" fill={UP}>client</text>

      {/* no, then the gate */}
      <line x1="100" y1="384" x2="100" y2="412" stroke={PPA} strokeWidth="5" strokeLinecap="round" />
      <text x="113" y="404" fontSize="13" fontWeight="700" fill={PPA}>no</text>
      <rect x="24" y="412" width="152" height="30" rx="15" fill="#fff" stroke={PPA} strokeWidth="2.5" />
      <text x="100" y="432" textAnchor="middle" fontSize="13" fontWeight="700" fill={PPA}>brows under $400</text>
      <line x1="100" y1="442" x2="100" y2="460" stroke={PPA} strokeWidth="5" strokeLinecap="round" />
      <polygon points="92,460 108,460 100,471" fill={PPA} />

      {/* Offer 2 */}
      <rect x="16" y="474" width="204" height="64" rx="14" fill={PPA} />
      <text x="32" y="498" fontSize="11" fontWeight="700" letterSpacing="1.4" fill="#fff">OFFER 2</text>
      <text x="32" y="523" fontSize="16" fontWeight="700" fill="#fff">Pay per appointment</text>
      <line x1="220" y1="506" x2="260" y2="506" stroke={PPA} strokeWidth="4" strokeLinecap="round" />
      <polygon points="259,499 259,513 270,506" fill={PPA} />
      <text x="241" y="497" textAnchor="middle" fontSize="13" fontWeight="700" fill={PPA}>yes</text>
      <circle cx="300" cy="506" r="27" fill={PPA_SOFT} stroke={PPA} strokeWidth="3" />
      <path d="M289 507 l8 8 l15 -17" fill="none" stroke={PPA} strokeWidth="4" strokeLinecap="round" strokeLinejoin="round" />
      <text x="300" y="553" textAnchor="middle" fontSize="13" fontWeight="700" fill={PPA}>Per-appointment</text>
      <text x="300" y="569" textAnchor="middle" fontSize="13" fontWeight="700" fill={PPA}>client</text>
    </svg>
  );
}

function LaterRoad() {
  const dash = "6 6";
  return (
    <svg viewBox="0 0 360 100" className={SVG} role="img"
      aria-label="Later idea. Own ads, the artist signs up alone, we approve, pay per appointment starts.">
      <g stroke={LATER} strokeWidth="3" strokeLinecap="round" strokeDasharray={dash}>
        <line x1="74" y1="34" x2="102" y2="34" />
        <line x1="162" y1="34" x2="190" y2="34" />
        <line x1="250" y1="34" x2="278" y2="34" />
      </g>
      <g fill={LATER}>
        <polygon points="102,28 102,40 112,34" />
        <polygon points="190,28 190,40 200,34" />
        <polygon points="278,28 278,40 288,34" />
      </g>
      <circle cx="48" cy="34" r="22" fill="#fff" stroke={LATER} strokeWidth="3" strokeDasharray={dash} />
      <polygon points="38,31 38,38 44,38 55,43 55,26 44,31" fill={LATER} />
      <circle cx="136" cy="34" r="22" fill="#fff" stroke={LATER} strokeWidth="3" strokeDasharray={dash} />
      <rect x="129" y="22" width="14" height="24" rx="3" fill="none" stroke={LATER} strokeWidth="2.5" />
      <circle cx="136" cy="41" r="1.5" fill={LATER} />
      <circle cx="224" cy="34" r="22" fill="#fff" stroke={LATER} strokeWidth="3" strokeDasharray={dash} />
      <path d="M215 35 l6 6 l11 -13" fill="none" stroke={LATER} strokeWidth="3.5" strokeLinecap="round" strokeLinejoin="round" />
      <circle cx="312" cy="34" r="22" fill="#fff" stroke={PPA} strokeWidth="3" strokeDasharray={dash} />
      <rect x="302" y="25" width="20" height="18" rx="3" fill="none" stroke={PPA} strokeWidth="2.5" />
      <line x1="302" y1="31" x2="322" y2="31" stroke={PPA} strokeWidth="2.5" />
      <g fontSize="12.5" fontWeight="700" textAnchor="middle">
        <text x="48" y="76" fill={MUTED}>Own</text><text x="48" y="92" fill={MUTED}>ads</text>
        <text x="136" y="76" fill={MUTED}>Signs up</text><text x="136" y="92" fill={MUTED}>alone</text>
        <text x="224" y="76" fill={MUTED}>We</text><text x="224" y="92" fill={MUTED}>approve</text>
        <text x="312" y="76" fill={PPA}>Pay per</text><text x="312" y="92" fill={PPA}>appointment</text>
      </g>
    </svg>
  );
}

function MoneyRows() {
  const slots = Array.from({ length: 12 }, (_, i) => i);
  return (
    <svg viewBox={`0 0 360 ${ROWS.length * 60 - 12}`} className={SVG} role="img"
      aria-label={ROWS.map((r) => `${r.n} paid bookings a month gives ${kUsd(r.n * PER_BOOKING * ARTISTS)} with ${ARTISTS} artists`).join(". ")}>
      {ROWS.map((r, i) => {
        const y = i * 60;
        const each = r.n * PER_BOOKING;
        const total = each * ARTISTS;
        return (
          <g key={r.n}>
            <text x="12" y={y + 16} fontSize="14" fontWeight="700" fill={INK}>
              {r.n} a month<tspan dx="8" fontSize="12" fontWeight="500" fill={MUTED}>{r.label}</tspan>
            </text>
            <text x="286" y={y + 16} textAnchor="end" fontSize="12" fontWeight="500" fill={MUTED}>{usd(each)} each</text>
            <text x="348" y={y + 17} textAnchor="end" fontSize="18" fontWeight="700" fill={total >= GOAL ? r.color : MUTED}>{kUsd(total)}</text>
            {slots.map((s) => (
              <rect key={s} x={12 + 28 * s} y={y + 24} width="22" height="22" rx="5" fill={s < r.n ? r.color : RULE} />
            ))}
          </g>
        );
      })}
    </svg>
  );
}

function Chip({ children, tone = "plain" }: { children: React.ReactNode; tone?: "plain" | "up" | "ppa" | "idea" }) {
  const cls = {
    plain: "border border-[#e4ebf2] bg-white text-[#1f3559]",
    up: "bg-[#0f8f88] text-white",
    ppa: "bg-[#B4236C] text-white",
    idea: "border-2 border-dashed border-[#b8c2cf] text-[#697a91]",
  }[tone];
  return <span className={`inline-flex items-center rounded-full px-2.5 py-1 text-[12px] font-semibold whitespace-nowrap ${cls}`}>{children}</span>;
}
const Arrow = ({ label }: { label?: string }) => (
  <span className="text-[12px] font-semibold text-[#8595a8] whitespace-nowrap">{label ? `${label} →` : "→"}</span>
);

export function StrategyMap({ defaultOpen = false }: { defaultOpen?: boolean }) {
  const [open, setOpen] = useState(defaultOpen);
  useEffect(() => {
    try {
      const v = localStorage.getItem(OPEN_KEY);
      if (v != null) setOpen(v === "1");
    } catch { /* private window: keep the default */ }
  }, []);
  const toggle = () => setOpen((v) => {
    try { localStorage.setItem(OPEN_KEY, v ? "0" : "1"); } catch { /* ignore */ }
    return !v;
  });
  const need = (n: number) => Math.ceil(GOAL / (n * PER_BOOKING));

  return (
    <section className="rounded-xl border border-[#e4ebf2] bg-white px-3 py-3 space-y-2.5" style={{ boxShadow: "var(--shadow-sm)" }}>
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
        <h2 className="text-sm font-semibold text-[#1f3559]">🗺 Road to {kUsd(GOAL)} a month</h2>
        <Sum parts={[[String(ARTISTS), "artists"], [usd(GOAL / ARTISTS), "each"]]} total={[kUsd(GOAL), "a month"]} />
      </div>

      {/* Always on screen: the sales path in one line, and who can join */}
      <div className="flex flex-wrap items-center gap-x-1.5 gap-y-1.5">
        <Chip>Ads</Chip><Arrow />
        <Chip>Setter</Chip><Arrow />
        <Chip>Closer</Chip><Arrow />
        <Chip tone="up">1 · Pay upfront</Chip><Arrow label="no" />
        <Chip tone="ppa">2 · Pay per appointment</Chip>
      </div>
      <div className="flex flex-wrap items-center gap-1.5">
        <span className="text-[12px] font-semibold uppercase tracking-wide text-[#8595a8]">Who can join</span>
        <Chip>Brows under $400</Chip>
        <Chip>$20+ a day on ads</Chip>
        <Chip tone="idea">Idea: AI answers the leads</Chip>
      </div>

      <button onClick={toggle} aria-expanded={open}
        className="inline-flex items-center gap-1 text-[12px] font-semibold text-[#0f8f88] hover:underline focus:outline-none focus-visible:ring-2 focus-visible:ring-[#15B7AE] rounded">
        {open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
        {open ? "Hide the picture" : "See the picture"}
      </button>

      {open && (
        <div className="columns-1 md:columns-2 xl:columns-3 gap-2.5">
          <Panel title={`The goal: ${ARTISTS} artists`}><GoalDots /></Panel>
          <Panel title="The big change: an easy door"><Doors /></Panel>
          <Panel title="The sales path"><SalesPath /></Panel>
          <Panel title="Pay per appointment: the money">
            <div className="mb-3">
              <Sum parts={[[usd(DEPOSIT), "deposit"], [usd(FEE), "fee"]]} total={[usd(PER_BOOKING), "a booking"]} />
            </div>
            <MoneyRows />
            <p className="mt-2 text-[12px] text-[#697a91]">
              <b className="text-[#1f3559]">{ARTISTS} artists.</b> One square is one paid booking a month.
              Goal {kUsd(GOAL)}: {ROWS[1].n} a month needs {need(ROWS[1].n)} artists, {ROWS[2].n} a month needs {need(ROWS[2].n)}.
            </p>
          </Panel>
          <Panel title="Why the AI idea: paid bookings from 100 leads" dashed>
            {[["AI answers", 5, PPA], ["Artist calls", 2, LATER]].map(([label, n, color]) => (
              <div key={label as string} className="grid grid-cols-[6rem_1fr_1.25rem] items-center gap-2 text-[13px] text-[#1f3559] mb-1.5 last:mb-0">
                <span>{label}</span>
                <div className="h-3 rounded-full bg-[#eef2f6]"><div className="h-3 rounded-full" style={{ width: `${((n as number) / 5) * 100}%`, background: color as string }} /></div>
                <b className="text-right tabular-nums">{n}</b>
              </div>
            ))}
          </Panel>
          <Panel title="Later idea: a road with no calls" dashed><LaterRoad /></Panel>
        </div>
      )}
    </section>
  );
}
