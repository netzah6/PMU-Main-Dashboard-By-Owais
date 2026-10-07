"use client";
import { Check } from "lucide-react";
import { cn } from "@/lib/utils";

// Boolean onboarding steps. Marked/done = green for all of them; unmarked = white.
const DONE = { color: "#15803d", bg: "#dcfce7", border: "#86efac", dot: "#16a34a" };
const TOGGLE_STEPS: { key: string; label: string }[] = [
  { key: "Launch Call",          label: "Launch Call" },
  { key: "A2P Verified",         label: "A2P" },
  { key: "FB Group",             label: "FB Group" },
  { key: "Sync Schedule",        label: "Sync Schedule" },
  { key: "UNSUBSCRIBE Removed",  label: "Unsubscribe Removed" },
  { key: "Agreement",            label: "Agreement Signed" },
  { key: "AI Agent Access",      label: "AI Access" },
  { key: "GMB",                  label: "GMB" },
];

interface StepTrackerProps {
  data: Record<string, unknown>;
  canEdit: boolean;
  onChange?: (stepIndex: number, key: string, value: boolean | string) => void;
  /* Live truth from the one-box funnel (owner, 2026-10-08): true = widget
     configured and showing, false = not, null/undefined = no one-box
     funnel (or still loading) — the manual dropdown is gone. */
  igOn?: boolean | null;
}

function isComplete(val: unknown): boolean {
  if (val === true || val === "true" || val === "TRUE" || val === "1" || val === "yes" || val === "YES") return true;
  if (typeof val === "number" && val !== 0) return true;
  return false;
}

export function StepTracker({ data, canEdit, onChange, igOn }: StepTrackerProps) {
  const ig: "On" | "Off" | "" = igOn === true ? "On" : igOn === false ? "Off" : "";
  const completed = TOGGLE_STEPS.filter(({ key }) => isComplete(data[key])).length + (ig === "On" ? 1 : 0);
  const total = TOGGLE_STEPS.length + 1; // toggle steps + Instagram Widget

  return (
    <div className="space-y-2.5">
      <div className="flex items-center justify-between">
        <h4 className="text-sm font-semibold text-[#1e2a3a]">Onboarding</h4>
        <span className="text-xs font-semibold text-[#0e8f88]">{completed}/{total}</span>
      </div>

      {/* Progress bar */}
      <div className="w-full bg-[#e4ebf2] rounded-full h-1.5">
        <div
          className="h-1.5 rounded-full transition-all duration-500"
          style={{ width: `${(completed / total) * 100}%`, background: "linear-gradient(90deg, #15B7AE, #10b981)" }}
        />
      </div>

      {/* Compact toggle chips (2 columns) */}
      <div className="grid grid-cols-2 gap-1.5">
        {TOGGLE_STEPS.map((step, i) => {
          const { key, label } = step;
          const done = isComplete(data[key]);
          return (
            <button
              key={key}
              type="button"
              disabled={!canEdit}
              onClick={() => onChange?.(i, key, !done)}
              title={done ? "Done — click to undo" : "Click to mark done"}
              className={cn(
                "flex items-center gap-1.5 px-2 py-1.5 rounded-lg border text-xs font-medium text-left transition-colors",
                !done && "bg-white border-[#e4ebf2] text-[#697a91] hover:bg-[#f1f5f9]",
                canEdit ? "cursor-pointer" : "cursor-default"
              )}
              style={done ? { background: DONE.bg, borderColor: DONE.border, color: DONE.color } : undefined}
            >
              <span
                className={cn(
                  "w-4 h-4 rounded-full flex items-center justify-center flex-shrink-0",
                  !done && "bg-[#e4ebf2] border border-[#d7e0ea]"
                )}
                style={done ? { background: DONE.dot } : undefined}
              >
                {done && <Check size={10} className="text-white" />}
              </span>
              <span className="truncate">{label}</span>
            </button>
          );
        })}

        {/* Instagram Widget — read-only, mirrors the one-box funnel: a widget
            is either configured there or it isn't (turn it on/off from the
            Funnels tab / the CPD card, never here). */}
        <div
          title="Mirrors the one-box funnel — manage the widget from the Funnels tab"
          className="flex items-center gap-1.5 px-2 py-1.5 rounded-lg border text-xs font-medium"
          style={
            ig === "On" ? { background: DONE.bg, borderColor: DONE.border, color: DONE.color }
              : ig === "Off" ? { background: "#fff1f2", borderColor: "#fecdd3", color: "#be123c" }
              : { background: "#ffffff", borderColor: "#e4ebf2", color: "#697a91" }
          }
        >
          <span
            className="w-4 h-4 rounded-full flex items-center justify-center flex-shrink-0"
            style={ig === "On" ? { background: DONE.dot } : { background: "#e4ebf2" }}
          >
            {ig === "On" && <Check size={10} className="text-white" />}
          </span>
          <span className="truncate">Instagram Widget{ig === "" ? " · no one-box" : ig === "Off" ? " · off" : ""}</span>
        </div>
      </div>
    </div>
  );
}
