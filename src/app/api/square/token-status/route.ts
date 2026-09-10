import { NextResponse } from "next/server";
import { getAuth } from "@/lib/ppa";
import { squareConfigured, getTokenStatus, SUBSCRIPTION_WRITE_SCOPES } from "@/lib/square";

// What the Square token may do. Read-only and admin-only: it reports the
// token's own permissions so we can tell, before building pause/resume, whether
// the token can do it — without anyone pasting the secret anywhere.
export async function GET() {
  const auth = await getAuth();
  if (!auth) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (auth.role !== "admin") return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  if (!squareConfigured()) {
    return NextResponse.json({ error: "SQUARE_ACCESS_TOKEN is not set in this environment." }, { status: 503 });
  }
  try {
    const status = await getTokenStatus();
    return NextResponse.json({
      ...status,
      requiredForSubscriptionWrites: SUBSCRIPTION_WRITE_SCOPES,
      canPauseResume: status.missingForSubscriptionWrites.length === 0,
    });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "Failed" }, { status: 502 });
  }
}
