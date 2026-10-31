import { NextRequest, NextResponse } from "next/server";
import { waitUntil } from "@vercel/functions";
import { MODAL_ID, SHORTCUT_ID, handleSubmission, isOwner, openTaskModal, tellOwner, verifySlack, type ModalMeta } from "@/lib/slack-agent";

export const maxDuration = 120;

// Slack's Interactivity URL for the "Send to AI Agent" message shortcut.
// Slack wants an answer within 3 s, so the slow part runs in waitUntil.
export async function POST(req: NextRequest) {
  const raw = await req.text();
  if (!verifySlack(raw, req.headers.get("x-slack-request-timestamp"), req.headers.get("x-slack-signature"))) {
    return NextResponse.json({ error: "bad signature" }, { status: 401 });
  }
  let p: any; // eslint-disable-line @typescript-eslint/no-explicit-any
  try { p = JSON.parse(new URLSearchParams(raw).get("payload") ?? "{}"); } catch { return new NextResponse(null, { status: 400 }); }

  if (p.type === "message_action" && p.callback_id === SHORTCUT_ID) {
    if (!isOwner(p.user?.id)) {
      waitUntil(tellOwner(p.response_url, "This button is only for Netzah."));
      return new NextResponse(null, { status: 200 });
    }
    const meta: ModalMeta = { c: p.channel?.id, ts: p.message?.ts, th: p.message?.thread_ts ?? "", ru: p.response_url };
    try { await openTaskModal(p.trigger_id, meta); } catch (e) {
      waitUntil(tellOwner(p.response_url, `🤖 Couldn't open the form: ${e instanceof Error ? e.message : String(e)}`));
    }
    return new NextResponse(null, { status: 200 });
  }

  if (p.type === "view_submission" && p.view?.callback_id === MODAL_ID) {
    if (!isOwner(p.user?.id)) return new NextResponse(null, { status: 200 });
    let meta: ModalMeta;
    try { meta = JSON.parse(p.view.private_metadata); } catch { return new NextResponse(null, { status: 200 }); }
    const v = p.view.state?.values ?? {};
    const client = String(v.client?.v?.value ?? "").trim();
    const note = String(v.note?.v?.value ?? "").trim().slice(0, 1500);
    waitUntil(tellOwner(meta.ru, "🤖 Reading the conversation… the task card will be ready in about a minute."));
    waitUntil(handleSubmission(meta, client, note, p.user?.name || "Netzah"));
    return new NextResponse(null, { status: 200 }); // closes the form
  }

  return new NextResponse(null, { status: 200 });
}
