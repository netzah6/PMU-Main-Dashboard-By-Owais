import { NextRequest, NextResponse } from "next/server";
import { getAuth } from "@/lib/ppa";
import { answersFromMainContact } from "@/lib/survey-answers";

// GET ?contactId= → the onboarding survey's Business Hours / Years in
// Business, live from the client's main-account contact (the Clients
// Master sheet has no columns for them).
export async function GET(req: NextRequest) {
  if (!(await getAuth())) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const contactId = String(req.nextUrl.searchParams.get("contactId") ?? "").trim();
  if (!/^[A-Za-z0-9]{10,40}$/.test(contactId)) return NextResponse.json({ answers: {} });
  return NextResponse.json({ answers: await answersFromMainContact(contactId, {}) });
}
