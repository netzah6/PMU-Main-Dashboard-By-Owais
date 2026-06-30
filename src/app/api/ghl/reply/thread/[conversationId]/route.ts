import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { getReplyAccount, getThread } from "@/lib/ghl-conversations";

export const maxDuration = 60;

export async function GET(
  _req: Request,
  { params }: { params: { conversationId: string } }
) {
  const supabase = createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const acct = await getReplyAccount();
  if (!acct) return NextResponse.json({ error: "Account not found" }, { status: 404 });

  const messages = await getThread(acct, params.conversationId);
  return NextResponse.json({ messages });
}
