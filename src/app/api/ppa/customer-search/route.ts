import { NextRequest, NextResponse } from "next/server";
import { getAuth } from "@/lib/ppa";
import { listAllCustomers, searchCustomersByEmail, squareConfigured } from "@/lib/square";

// Admin search over Square customers, for manually linking a PPS client to
// the right profile from the drill-down. Substring match over the cached bulk
// list (name/email/company/phone), plus an exact-email search for profiles
// the capped list might miss.
export async function GET(req: NextRequest) {
  const auth = await getAuth();
  if (!auth) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (auth.role !== "admin") return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  if (!squareConfigured()) return NextResponse.json({ error: "Square is not configured." }, { status: 503 });

  const q = (req.nextUrl.searchParams.get("q") ?? "").trim().toLowerCase();
  if (q.length < 3) return NextResponse.json({ customers: [] });

  const { customers } = await listAllCustomers();
  const digits = q.replace(/\D/g, "");
  const hit = (c: { name: string; email: string | null; phone?: string | null; company?: string | null }) => {
    const blob = `${c.name} ${c.email ?? ""} ${c.company ?? ""}`.toLowerCase();
    if (blob.includes(q)) return true;
    if (digits.length >= 4 && String(c.phone ?? "").replace(/\D/g, "").includes(digits)) return true;
    return false;
  };
  const results = customers.filter(hit).slice(0, 10);

  // Exact-email search catches profiles beyond the bulk-list cap.
  if (q.includes("@") && !results.some((c) => (c.email ?? "").toLowerCase() === q)) {
    const extra = await searchCustomersByEmail(q).catch(() => []);
    for (const c of extra) if (!results.some((r) => r.id === c.id)) results.push(c);
  }

  return NextResponse.json({
    customers: results.slice(0, 10).map((c) => ({
      id: c.id, name: c.name, email: c.email, phone: c.phone ?? null, company: c.company ?? null,
    })),
  });
}
