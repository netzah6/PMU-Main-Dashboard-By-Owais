"use client";
import { cn } from "@/lib/utils";

type Variant = "green" | "yellow" | "red" | "blue" | "gray" | "teal" | "purple";

const variantClasses: Record<Variant, string> = {
  green: "bg-emerald-900/50 text-emerald-300 border-emerald-700",
  yellow: "bg-amber-900/50 text-amber-300 border-amber-700",
  red: "bg-red-900/50 text-red-300 border-red-700",
  blue: "bg-blue-900/50 text-blue-300 border-blue-700",
  gray: "bg-slate-700/50 text-slate-300 border-slate-600",
  teal: "bg-teal-900/50 text-teal-300 border-teal-700",
  purple: "bg-purple-900/50 text-purple-300 border-purple-700",
};

export function statusVariant(status: string | undefined): Variant {
  if (!status) return "gray";
  const s = status.toLowerCase();
  if (s === "live" || s === "active") return "green";
  if (s === "paused") return "yellow";
  if (s === "lost" || s === "inactive" || s === "unsettled") return "red";
  if (s === "pending") return "blue";
  return "gray";
}

interface BadgeProps {
  children: React.ReactNode;
  variant?: Variant;
  className?: string;
}

export function Badge({ children, variant = "gray", className }: BadgeProps) {
  return (
    <span
      className={cn(
        "inline-flex items-center px-2 py-0.5 rounded text-xs font-medium border",
        variantClasses[variant],
        className
      )}
    >
      {children}
    </span>
  );
}
