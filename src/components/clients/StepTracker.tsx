"use client";
import { Check } from "lucide-react";
import { cn } from "@/lib/utils";

// Boolean onboarding steps — each with its own "done" color (per the sheet).
const TOGGLE_STEPS: { key: string; label: string; color: string; bg: string; border: string }[] = [
  { key: "Launch Call",          label: "Launch Call",         color: "#1f2937", bg: "#eef0f3", border: "#d4d8de" }, // black
  { key: "A2P Verified",         label: "A2P",                 color: "#1d4ed8", bg: "#e7edff", border: "#c2d2ff" }, // blue
  { key: "FB Group",             label: "FB Group",            color: "#7e22ce", bg: "#f3e8ff", border: "#e3cffb" }, // purple
  { key: "Sync Schedule",        label: "Sync Schedule",       color: "#0e8f88", bg: "#e6f7f5", border: "#a7e3df" }, // teal
  { key: "UNSUBSCRIBE Removed",  label: "Unsubscribe Removed", color: "#1d4ed8", bg: "#e7edff", border: "#c2d2ff" }, // blue
  { key: "Agreement",            label: "Agreement Signed",    color: "#1f2937", bg: "#eef0f3", border: "#d4d8de" }, // black
  { key: "AI Agent Access",      label: "AI Access",           color: "#d97706", bg: "#fff7ec", border: "#fcd9a8" }, // amber
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
  const total = TOGGLE_STEPS.length + 1; // 8

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
              style={done ? { background: step.bg, borderColor: step.border, color: step.color } : undefined}
            >
              <span
                className={cn(
                  "w-4 h-4 rounded-full flex items-center justify-center flex-shrink-0",
                  !done && "bg-[#e4ebf2] border border-[#d7e0ea]"
                )}
                style={done ? { background: step.color } : undefined}
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
            ig === "On" ? { background: "#fce7f3", borderColor: "#f9a8d4", color: "#be185d" }
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
