import Link from "next/link";
import { JOURNEY_CLS, chatWithContact, loadApp, loadChats, loadThread } from "@/lib/client-app";

/* One chat, oldest to newest, like a messaging app. Read-only in the demo:
   nobody may send a text to a lead from a link alone — replying arrives
   together with the real sign-in. */
export default async function ClientAppThread({ params, searchParams }: { params: { token: string; id: string }; searchParams?: { c?: string; from?: string } }) {
  const app = await loadApp(params.token);
  if (!app) return null;
  // The name comes from her chat list, never from the address bar.
  const [data, list] = await Promise.all([loadThread(params.token, params.id), loadChats(params.token)]);
  const chat = list?.chats.find((c) => c.id === params.id);
  // Opened from Bookings: an older chat may not be in the recent list, so the name comes from the lead herself.
  const fromBookings = searchParams?.from === "bookings";
  const lead = !chat && searchParams?.c ? await chatWithContact(params.token, searchParams.c).catch(() => null) : null;
  const name = chat?.name ?? (lead?.id === params.id ? lead.name : null) ?? "Chat";
  const back = fromBookings ? `/m/${params.token}/bookings` : `/m/${params.token}/chats`;
  if (!data) {
    return (
      <div className="rounded-2xl border border-[#e4ebf2] bg-white p-5 text-center">
        <p className="text-sm font-bold text-[#1c2b3a]">This chat isn&apos;t available.</p>
        <Link href={back} className="mt-2 inline-block text-sm font-semibold text-[#0e8f88]">{fromBookings ? "Back to bookings" : "Back to chats"}</Link>
      </div>
    );
  }
  const { messages, tz } = data;
  const dayOf = (iso: string | null) => (iso ? new Date(iso).toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric", timeZone: tz }) : "");
  const timeOf = (iso: string | null) => (iso ? new Date(iso).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", timeZone: tz }) : "");
  let lastDay = "";
  return (
    <div className="space-y-2">
      <div className="sticky top-16 z-[5] -mx-3 flex items-center gap-2 border-b border-[#e4ebf2] bg-[#f3f7fb]/95 px-3 py-2 backdrop-blur">
        <Link href={back} className="rounded-full bg-white px-3 py-1 text-sm font-semibold text-[#0e8f88] border border-[#e4ebf2]">‹ {fromBookings ? "Bookings" : "Chats"}</Link>
        <p className="min-w-0 flex-1 truncate text-sm font-bold text-[#1c2b3a]">{name}</p>
        {chat?.journey && <span className={`max-w-[40%] shrink-0 truncate rounded px-1.5 py-0.5 text-[11px] font-semibold ${JOURNEY_CLS[chat.journey.tone]}`}>{chat.journey.label}</span>}
        {chat?.ai && (
          <span className={`shrink-0 rounded-full px-2 py-0.5 text-[11px] font-bold ${chat.ai === "on" ? "bg-[#e6f7ee] text-[#15803d]" : "bg-[#e9eef4] text-[#52627a]"}`}
            title={chat.ai === "on" ? "The AI assistant is answering this lead" : "The AI assistant is off for this lead"}>
            AI {chat.ai}
          </span>
        )}
      </div>
      {messages.length === 0 ? (
        <p className="px-1 py-3 text-sm text-[#7b8a9c]">No messages in this chat yet.</p>
      ) : (
        <ul className="space-y-1.5">
          {messages.map((m) => {
            const d = dayOf(m.at);
            const showDay = d && d !== lastDay;
            lastDay = d || lastDay;
            return (
              <li key={m.id}>
                {showDay && <p className="py-2 text-center text-[11px] font-semibold text-[#8595a8]">{d}</p>}
                <div className={`flex ${m.fromLead ? "justify-start" : "justify-end"}`}>
                  <div className={`max-w-[82%] rounded-2xl px-3 py-2 text-sm leading-snug ${
                    m.fromLead ? "rounded-bl-md bg-white text-[#1c2b3a] border border-[#e4ebf2]" : "rounded-br-md bg-[#15B7AE] text-white"}`}>
                    {m.images.map((u) => (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img key={u} src={u} alt="Photo" loading="lazy" referrerPolicy="no-referrer" className="mb-1 max-h-64 w-auto rounded-xl" />
                    ))}
                    {m.files > 0 && <p className={`text-xs italic ${m.fromLead ? "text-[#7b8a9c]" : "text-white/80"}`}>{m.files === 1 ? "Attachment" : `${m.files} attachments`}</p>}
                    {m.body && <p className="whitespace-pre-wrap break-words">{m.body}</p>}
                    <p className={`mt-0.5 text-right text-[10px] ${m.fromLead ? "text-[#9aa8b8]" : "text-white/75"}`}>{timeOf(m.at)}</p>
                  </div>
                </div>
              </li>
            );
          })}
        </ul>
      )}
      <p className="pt-2 text-center text-xs text-[#9aa8b8]">Replying from this app is coming next.</p>
    </div>
  );
}
