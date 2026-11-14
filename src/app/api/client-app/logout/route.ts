import { NextResponse } from "next/server";
import { clearSession } from "@/lib/client-app-auth";

/* Client app · sign out: forget this browser. */
export const dynamic = "force-dynamic";

export async function POST() {
  clearSession();
  return NextResponse.json({ ok: true });
}
