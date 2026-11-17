import { userColor } from "@/lib/utils";

/* A team member's name in THEIR color — the same on every tab (owner,
   11/17/2026). Colors live in userColor() (src/lib/utils.ts). */

/** Solid chip: "Nicolas" on yellow, "Stephanie" on blue … */
export function TeamChip({ name, label, size = "sm", className = "" }: { name: string | null | undefined; label?: string; size?: "xs" | "sm"; className?: string }) {
  const n = String(name ?? "").trim();
  if (!n) return <span className="text-[#a6b3c4]">—</span>;
  const c = userColor(n)!;
  return (
    <span
      className={`inline-flex items-center rounded-full font-semibold border whitespace-nowrap ${size === "xs" ? "px-1.5 py-px text-[10px]" : "px-2 py-0.5 text-[11px]"} ${className}`}
      style={{ background: c.bg, color: c.text, borderColor: c.border }}
    >
      {label ?? n}
    </span>
  );
}

/** Plain text in the person's color (for "by X" lines and table cells). */
export function TeamName({ name, label, className = "" }: { name: string | null | undefined; label?: string; className?: string }) {
  const n = String(name ?? "").trim();
  if (!n) return null;
  return <span className={`font-semibold ${className}`} style={{ color: userColor(n)!.ink }}>{label ?? n}</span>;
}
