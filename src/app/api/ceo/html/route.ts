import { NextResponse } from "next/server";
import { getAuth } from "@/lib/ppa";
import { CEO_HTML_B64 } from "@/lib/ceo/page-html";

// Serves the CEO dashboard page to admins only. It's a route (not a public/
// file) precisely so the sheet IDs and financials inside it sit behind login.
export async function GET() {
  const auth = await getAuth();
  if (!auth) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (auth.role !== "admin") return NextResponse.json({ error: "Admins only" }, { status: 403 });
  return new NextResponse(Buffer.from(CEO_HTML_B64, "base64").toString("utf8"), {
    headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" },
  });
}
