import { NextRequest, NextResponse } from "next/server";
import { getAuth } from "@/lib/ppa";
import { templateProblem } from "@/lib/blast-template";
import { TWIST_MAX_OCCASION, twistTemplate } from "@/lib/blast-twist";

export const maxDuration = 60;

/* ✨ AI twist: hands back up to three occasion versions of the blast message
   for the Message box. It only writes text — nothing is sent from here. */
export async function POST(req: NextRequest) {
  const auth = await getAuth();
  if (!auth || (auth.role !== "admin" && auth.role !== "editor")) return NextResponse.json({ error: "Admins and coaches only" }, { status: 403 });
  const body = (await req.json().catch(() => ({}))) as { template?: unknown; occasion?: unknown };
  const template = String(body.template ?? "").trim();
  const occasion = String(body.occasion ?? "").trim();
  if (!template) return NextResponse.json({ error: "Write the message first" }, { status: 400 });
  if (template.length > 1000) return NextResponse.json({ error: "That message is too long for a twist" }, { status: 400 });
  if (templateProblem(template)) return NextResponse.json({ error: "Fix the broken tag in the message first" }, { status: 400 });
  if (!occasion) return NextResponse.json({ error: "Type the occasion first — for example Black Friday" }, { status: 400 });
  if (occasion.length > TWIST_MAX_OCCASION) return NextResponse.json({ error: "Keep the occasion short — a few words" }, { status: 400 });
  try {
    return NextResponse.json({ options: await twistTemplate(template, occasion) });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "The AI couldn't write that — please try again" }, { status: 502 });
  }
}
