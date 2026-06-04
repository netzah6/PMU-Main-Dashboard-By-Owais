"use client";
import { Check } from "lucide-react";
import { cn } from "@/lib/utils";

// These map directly to field names in the clients_master data
const STEPS: { key: string; label: string }[] = [
  { key: "Launch Call",     label: "Launch Call" },
  { key: "A2P Verified",    label: "A2P Verified" },
  { key: "FB Group",        label: "FB Group" },
  { key: "Group Call",      label: "Group Call" },
  { key: "Sync Schedule",   label: "Sync Schedule" },
  { key: "Instagram Widget",label: "Instagram Widget" },
  { key: "Agreement",       label: "Agreement Signed" },
];

interface StepTrackerProps {
  data: Record<string, unknown>;
  canEdit: boolean;
  onChange?: (stepIndex: number, key: string, value: boolean) => void;
}

function isComplete(val: unknown): boolean {
  if (val === true || val === "true" || val === "TRUE" || val === "1" || val === "yes" || val === "YES") return true;
  if (typeof val === "number" && val !== 0) return true;
  return false;
}

export function StepTracker({ data, canEdit, onChange }: StepTrackerProps) {
  const completedCount = STEPS.filter(({ key }) => isComplete(data[key])).length;

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <h4 className="text-sm font-semibold text-slate-200">7-Step Progress</h4>
        <span className="text-xs font-semibold text-teal-400">{completedCount}/7 complete</span>
      </div>

      {/* Progress bar */}
      <div className="w-full bg-slate-700 rounded-full h-2">
        <div
          className="h-2 rounded-full transition-all duration-500"
          style={{
            width: `${(completedCount / 7) * 100}%`,
            background: "linear-gradient(90deg, #00B4A6, #10b981)",
          }}
        />
      </div>

      {/* Steps grid */}
      <div className="grid grid-cols-1 gap-1.5">
        {STEPS.map(({ key, label }, i) => {
          const done = isComplete(data[key]);
          return (
            <label
              key={key}
              className={cn(
                "flex items-center gap-3 px-3 py-2.5 rounded-lg border cursor-pointer select-none transition-colors",
                done
                  ? "bg-teal-900/20 border-teal-700/60 hover:bg-teal-900/30"
                  : "bg-slate-800/40 border-slate-700/50 hover:bg-slate-700/40",
                !canEdit && "pointer-events-none"
              )}
            >
              {canEdit ? (
                <input
                  type="checkbox"
                  checked={done}
                  onChange={(e) => onChange?.(i, key, e.target.checked)}
                  className="w-4 h-4 rounded accent-teal-500 flex-shrink-0"
                />
              ) : (
                <div className={cn(
                  "w-5 h-5 rounded-full flex items-center justify-center flex-shrink-0",
                  done ? "bg-teal-500" : "bg-slate-700 border border-slate-600"
                )}>
                  {done && <Check size={11} className="text-white" />}
                </div>
              )}
              <span className={cn("text-xs font-medium", done ? "text-teal-200" : "text-slate-400")}>
                Step {i + 1}: {label}
              </span>
            </label>
          );
        })}
      </div>
    </div>
  );
}
