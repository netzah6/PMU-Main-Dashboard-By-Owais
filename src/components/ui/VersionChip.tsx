import { versionStyle } from "@/lib/version-style";

/* A program version mark (V3 / V2.3 / V1 …) in the ONE version palette
   (src/lib/version-style.ts) — the same on every tab (owner, 11/17/2026). */
export function VersionChip({ version, className = "" }: { version: string | null | undefined; className?: string }) {
  const v = String(version ?? "").replace(/[()]/g, "").trim();
  if (!v) return <span className="text-[#a6b3c4]">—</span>;
  const c = versionStyle(v);
  return (
    <span className={`inline-block px-1.5 py-px rounded text-[10px] font-bold border whitespace-nowrap ${className}`}
      style={{ background: c.bg, color: c.text, borderColor: c.border }}>{v}</span>
  );
}
