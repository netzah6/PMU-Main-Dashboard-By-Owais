import { createClient } from "@/lib/supabase/server";
import { redirect } from "next/navigation";
import { headers } from "next/headers";
import { DashboardShell } from "@/components/layout/DashboardShell";

// A "va" may open only these two tabs. Enforced here rather than in middleware:
// middleware runs on every request (pages, assets, api), so a role lookup there
// meant a DB round trip per request and took the whole dashboard down with
// MIDDLEWARE_INVOCATION_TIMEOUT. This runs once per page render instead.
const VA_PAGES = ["/clients", "/onboarding"];

export default async function DashboardLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const supabase = createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    redirect("/login");
  }

  const { data: roleRow } = await supabase
    .from("user_roles")
    .select("role")
    .eq("user_id", user.id)
    .single();

  if (roleRow?.role === "va") {
    const path = headers().get("x-pathname") ?? "";
    const allowed = VA_PAGES.some((a) => path === a || path.startsWith(a + "/"));
    if (!allowed) redirect("/clients");
  }

  return (
    <DashboardShell userEmail={user.email}>
      {children}
    </DashboardShell>
  );
}
