import { redirect } from "next/navigation";

// The Cleanup tools moved into the Onboarding tab (admin-only section) on
// 2026-09-29. Old bookmarks land there.
export default function CleanupRedirect() {
  redirect("/onboarding#cleanup");
}
