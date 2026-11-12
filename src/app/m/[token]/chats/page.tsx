import Link from "next/link";
import { loadApp, loadChats } from "@/lib/client-app";
import { FilterBox } from "@/components/client-app/FilterBox";

/* Chats: the client's own conversations with her leads, read live from her
   GoHighLevel account — newest first, tap to read the thread. */
function when(iso: string | null, tz: string) {
  if (!iso) return "";
  const d = new Date(iso);
  if (isNaN(d.getTime())) return "";
  const dayKey = (x: Date) => x.toLocaleDateString("en-US", { timeZone: tz });
  if (dayKey(d) === dayKey(new Date())) return d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", timeZone: tz });
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: tz });
}

export default async function ClientAppChats({ params }: { params: { token: string } }) {
  const app = await loadApp(params.token);
  if (!app) return null;
  const data = await loadChats(params.token);
  if (!data) {
    return (
      <div className="rounded-2xl border border-[#e4ebf2] bg-white p-5 text-center">
        <p className="text-sm font-bold text-[#1c2b3a]">Chats aren&apos;t available right now.</p>
        <p className="mt-1 text-sm text-[#7b8a9c]">Please try again in a minute.</p>
      </div>
    );
  }
  const { chats, tz } = data;
  return (
    <div className="space-y-3">
      <FilterBox target="chats-list" placeholder="Search a chat…" />
      <section id="chats-list" className="rounded-2xl border border-[#e4ebf2] bg-white px-2 py-1">
        {chats.length === 0 ? (
          <p className="px-2 py-3 text-sm text-[#7b8a9c]">No chats yet.</p>
        ) : (
          <ul>
            {chats.map((c) => (
              <li key={c.id} data-q={`${c.name} ${c.preview}`.toLowerCase()} className="border-b border-[#eef3f8] last:border-0">
                <Link href={`/m/${params.token}/chats/${c.id}`} prefetch={false}
                  className="flex items-center gap-3 rounded-xl px-2 py-2.5 active:bg-[#f3f7fb]">
                  <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-[#e6f7f5] text-sm font-bold text-[#0e8f88]">
                    {c.name.replace(/[^\p{L}]/gu, "").slice(0, 1).toUpperCase() || "?"}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="flex items-baseline gap-2">
                      <span className={`truncate text-sm text-[#1c2b3a] ${c.unread > 0 ? "font-extrabold" : "font-semibold"}`}>{c.name}</span>
                      <span className="ml-auto shrink-0 text-[11px] text-[#7b8a9c]">{when(c.at, tz)}</span>
                    </span>
                    <span className="flex items-center gap-2">
                      <span className={`truncate text-xs ${c.unread > 0 ? "font-semibold text-[#1c2b3a]" : "text-[#7b8a9c]"}`}>
                        {!c.fromLead && c.preview ? "You: " : ""}{c.preview || "(no text)"}
                      </span>
                      {c.unread > 0 && (
                        <span className="ml-auto shrink-0 rounded-full bg-[#15B7AE] px-1.5 py-0.5 text-[10px] font-bold text-white">{c.unread}</span>
                      )}
                    </span>
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
