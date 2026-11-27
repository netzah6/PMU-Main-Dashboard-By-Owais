import { redirect } from "next/navigation";

// CPD now lives inside Performance as an admin-only view (owner, 11/27/2026).
export default function CostPerDepositRedirect() {
  redirect("/performance?view=cpd");
}
