import { loadProfit } from "@/lib/client-app-profit";
import { ProfitBoard } from "@/components/client-app/ProfitBoard";

/* Profit (owner, 11/12/2026): what the clients we sent are worth to her, month
   by month, minus the expenses she adds. One big number, detail under it. */
export default async function ClientAppProfit({ params }: { params: { token: string } }) {
  const data = await loadProfit(params.token);
  if (!data) return null; // the layout shows the "not available" card
  return <ProfitBoard token={params.token} data={data} />;
}
