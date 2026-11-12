"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { CalendarDays, Home, MessageCircle, Receipt, Users } from "lucide-react";

/* Bottom tabs of the client app — fixed, thumb-sized, above the phone's
   home-bar (safe-area inset). */
export function TabBar({ base }: { base: string }) {
  const path = usePathname() ?? "";
  const tabs = [
    { href: base, label: "Home", Icon: Home, on: path === base || path === `${base}/` },
    { href: `${base}/chats`, label: "Chats", Icon: MessageCircle, on: path.startsWith(`${base}/chats`) },
    { href: `${base}/bookings`, label: "Bookings", Icon: CalendarDays, on: path.startsWith(`${base}/bookings`) },
    { href: `${base}/leads`, label: "Leads", Icon: Users, on: path.startsWith(`${base}/leads`) },
    { href: `${base}/billing`, label: "Billing", Icon: Receipt, on: path.startsWith(`${base}/billing`) },
  ];
  return (
    <nav className="fixed bottom-0 inset-x-0 z-20 border-t border-[#e4ebf2] bg-white/95 backdrop-blur"
      style={{ paddingBottom: "env(safe-area-inset-bottom)" }}>
      <ul className="mx-auto flex max-w-xl">
        {tabs.map(({ href, label, Icon, on }) => (
          <li key={href} className="flex-1">
            {/* Chats reads GoHighLevel live — load it when she opens it, not on every screen. */}
            <Link href={href} prefetch={label !== "Chats"}
              className={`flex flex-col items-center gap-0.5 py-2 text-[10.5px] font-semibold ${on ? "text-[#0e8f88]" : "text-[#8595a8]"}`}>
              <span className={`flex h-8 w-11 items-center justify-center rounded-full ${on ? "bg-[#e6f7f5]" : ""}`}>
                <Icon size={20} strokeWidth={on ? 2.4 : 2} />
              </span>
              {label}
            </Link>
          </li>
        ))}
      </ul>
    </nav>
  );
}
