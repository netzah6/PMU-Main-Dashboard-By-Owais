import Link from "next/link";
import { redirect } from "next/navigation";
import { chatWithContact, loadApp } from "@/lib/client-app";

/* From Bookings: "chat with this client" (owner, 11/12/2026). Finds her chat
   with that lead and opens it. Only her own leads — the lookup checks the
   lead is on file under this client. */
export default async function ClientAppChatWith({ params }: { params: { token: string; contactId: string } }) {
  const app = await loadApp(params.token);
  if (!app) return null;
  const chat = await chatWithContact(params.token, params.contactId).catch(() => null);
  if (chat?.id) redirect(`/m/${params.token}/chats/${chat.id}?from=bookings&c=${encodeURIComponent(params.contactId)}`);
  return (
    <div className="rounded-2xl border border-[#e4ebf2] bg-white p-5 text-center">
      <p className="text-sm font-bold text-[#1c2b3a]">{chat?.name ? `No chat with ${chat.name} yet.` : "This chat isn\u2019t available."}</p>
      <Link href={`/m/${params.token}/bookings`} className="mt-2 inline-block text-sm font-semibold text-[#0e8f88]">Back to bookings</Link>
    </div>
  );
}
