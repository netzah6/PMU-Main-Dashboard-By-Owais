import Link from "next/link";
import { loadApp, loadChats, loadThread } from "@/lib/client-app";

/* One chat, oldest to newest, like a messaging app. Read-only in the demo:
   nobody may send a text to a lead from a link alone — replying arrives
   together with the real sign-in. */
export default async function ClientAppThread({ params }: { params: { token: string; id: string } }) {
  const app = await loadApp(params.token);
  if (!app) return null;
  // The name comes from her chat list, never from the address bar.
  const [data, list] = await Promise.all([loadThread(params.token, params.id), loadChats(params.token)]);
  const name = list?.chats.find((c) => c.id === params.id)?.name ?? "Chat";
  const back = `/m/${params.token}/chats`;
  if (!data) {
    return (
      <div className="rounded-2xl border border-[#e4ebf2] bg-white p-5 text-center">
        <p className="text-sm font-bold text-[#1c2b3a]">This chat isn&apos;t available.</p>
        <Link href={back} className="mt-2 inline-block text-sm font-semibold text-[#0e8f88]">Back to chats</Link>
      </div>
    );
  }
  const { messages, tz } = data;
  const dayOf = (iso: string | null) => (iso ? new Date(iso).toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric", timeZone: tz }) : "");
  const timeOf = (iso: string | null) => (iso ? new Date(iso).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", timeZone: tz }) : "");
  let lastDay = "";
  return (
    <div className="space-y-2">
      <div className="sticky top-[60px] z-[5] -mx-3 flex items-center gap-2 border-b border-[#e4ebf2] bg-[#f3f7fb]/95 px-3 py-2 backdrop-blur">
        <Link href={back} className="rounded-full bg-white px-3 py-1 text-sm font-semibold text-[#0e8f88] border border-[#e4ebf2]">‹ Chats</Link>
        <p className="min-w-0 flex-1 truncate text-sm font-bold text-[#1c2b3a]">{name}</p>
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
