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

const IG_KEY = "Instagram Widget";

interface StepTrackerProps {
  data: Record<string, unknown>;
  canEdit: boolean;
  onChange?: (stepIndex: number, key: string, value: boolean | string) => void;
}

function isComplete(val: unknown): boolean {
  if (val === true || val === "true" || val === "TRUE" || val === "1" || val === "yes" || val === "YES") return true;
  if (typeof val === "number" && val !== 0) return true;
  return false;
}

function igState(val: unknown): "On" | "Not good enough" | "" {
  const s = String(val ?? "").trim().toLowerCase();
  if (s === "on" || s === "true" || s === "yes" || s === "1") return "On";
  if (s.includes("not good")) return "Not good enough";
  return "";
}

export function StepTracker({ data, canEdit, onChange }: StepTrackerProps) {
  const ig = igState(data[IG_KEY]);
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

        {/* Instagram Widget — compact, sits next to AI Access */}
        <div
          className="flex flex-col gap-0.5 px-2 py-1 rounded-lg border"
          style={
            ig === "On" ? { background: DONE.bg, borderColor: DONE.border, color: DONE.color }
              : ig === "Not good enough" ? { background: "#fff7ec", borderColor: "#fcd9a8", color: "#d97706" }
              : { background: "#ffffff", borderColor: "#e4ebf2", color: "#697a91" }
          }
        >
          <span className="text-[10px] font-medium leading-tight truncate">Instagram Widget</span>
          <select
            value={ig}
            disabled={!canEdit}
            onChange={(e) => onChange?.(TOGGLE_STEPS.length, IG_KEY, e.target.value)}
            className="w-full text-[11px] rounded border border-[#d7e0ea] bg-white px-1 py-0.5 text-[#1f3559] focus:outline-none focus:border-[#15B7AE] disabled:opacity-70"
          >
            <option value="">—</option>
            <option value="On">On</option>
            <option value="Not good enough">Not good enough</option>
          </select>
        </div>
      </div>
    </div>
  );
}
