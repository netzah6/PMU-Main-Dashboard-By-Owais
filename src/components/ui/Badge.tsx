"use client";
import { cn } from "@/lib/utils";

type Variant = "green" | "yellow" | "red" | "blue" | "gray" | "teal" | "purple";

// Light status chips per the brand style guide
const variantClasses: Record<Variant, string> = {
  green: "bg-[#e6f7f5] text-[#0e8f88] border-[#a7e3df]",
  yellow: "bg-[#fff7ec] text-[#d97706] border-[#fcd9a8]",
  red: "bg-[#fde8ee] text-[#e11d48] border-[#f5c2cf]",
  blue: "bg-[#eef2ff] text-[#3a5a8c] border-[#c7d2fe]",
  gray: "bg-[#f1f5f9] text-[#64748b] border-[#d7e0ea]",
  teal: "bg-[#e6f7f5] text-[#0e8f88] border-[#a7e3df]",
  purple: "bg-[#f3e8ff] text-[#7e22ce] border-[#e3cffb]",
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
