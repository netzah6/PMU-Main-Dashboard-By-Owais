import { loadApp } from "@/lib/client-app";
import { loadSupport } from "@/lib/client-app-support";
import { SupportComposer } from "@/components/client-app/SupportComposer";

/* Support (owner, 11/12/2026): her client success coach — name and photo —
   the chat history with the team, and a box to write or record a voice note.
   Demo stage: what she sends from here is saved and shown, not yet passed on
   to the coach (see client-app-support). */
export default async function ClientAppSupport({ params }: { params: { token: string } }) {
  const app = await loadApp(params.token);
  if (!app) return null;
  const data = await loadSupport(params.token);
  if (!data) return null;
  const { coach, messages, tz } = data;
  const dayOf = (iso: string | null) => (iso ? new Date(iso).toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric", timeZone: tz }) : "");
  const timeOf = (iso: string | null) => (iso ? new Date(iso).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", timeZone: tz }) : "");
  let lastDay = "";
  return (
    <div className="space-y-2">
      <section className="flex items-center gap-3 rounded-2xl border border-[#bfe9e5] bg-white px-4 py-3">
        {coach?.photo ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={coach.photo} alt="" referrerPolicy="no-referrer" className="h-14 w-14 shrink-0 rounded-full object-cover" />
        ) : (
          <span className="flex h-14 w-14 shrink-0 items-center justify-center rounded-full bg-[#e6f7f5] text-xl font-extrabold text-[#0e8f88]">
            {(coach?.first ?? "P").slice(0, 1).toUpperCase()}
          </span>
        )}
        <div className="min-w-0">
          <p className="truncate text-base font-extrabold text-[#1c2b3a]">{coach?.name ?? "Your PMU Bookings team"}</p>
          <p className="text-xs font-semibold text-[#0e8f88]">{coach ? "Your client success coach" : "Here to help you"}</p>
        </div>
      </section>

      {messages.length === 0 ? (
        <p className="px-1 py-6 text-center text-sm text-[#7b8a9c]">
          {coach ? `Say hi to ${coach.first} — write a message or record a voice note.` : "Write a message or record a voice note."}
        </p>
      ) : (
        <ul className="space-y-1.5">
          {messages.map((m) => {
            const d = dayOf(m.at);
            const showDay = d && d !== lastDay;
            lastDay = d || lastDay;
            return (
              <li key={m.id}>
                {showDay && <p className="py-2 text-center text-[11px] font-semibold text-[#8595a8]">{d}</p>}
                <div className={`flex ${m.mine ? "justify-end" : "justify-start"}`}>
                  <div className={`max-w-[82%] rounded-2xl px-3 py-2 text-sm leading-snug ${
                    m.mine ? "rounded-br-md bg-[#15B7AE] text-white" : "rounded-bl-md border border-[#e4ebf2] bg-white text-[#1c2b3a]"}`}>
                    {!m.mine && m.by && <p className="pb-0.5 text-[11px] font-bold text-[#0e8f88]">{m.by}</p>}
                    {m.images.map((u) => (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img key={u} src={u} alt="Photo" loading="lazy" referrerPolicy="no-referrer" className="mb-1 max-h-64 w-auto rounded-xl" />
                    ))}
                    {m.audio.map((u) => <audio key={u} controls preload="none" src={u} className="mb-1 h-9 w-56 max-w-full" />)}
                    {m.transcript && <p className={`pb-0.5 text-xs italic ${m.mine ? "text-white/85" : "text-[#52627a]"}`}>&ldquo;{m.transcript}&rdquo;</p>}
                    {m.files > 0 && <p className={`text-xs italic ${m.mine ? "text-white/80" : "text-[#7b8a9c]"}`}>{m.files === 1 ? "Attachment" : `${m.files} attachments`}</p>}
                    {m.body && <p className="whitespace-pre-wrap break-words">{m.body}</p>}
                    <p className={`mt-0.5 text-right text-[10px] ${m.mine ? "text-white/75" : "text-[#9aa8b8]"}`}>{timeOf(m.at)}</p>
                  </div>
                </div>
              </li>
            );
          })}
        </ul>
      )}
      <SupportComposer token={params.token} coachFirst={coach?.first ?? null} count={messages.length} />
    </div>
  );
}
