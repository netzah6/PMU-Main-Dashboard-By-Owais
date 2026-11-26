import type { Metadata } from "next";
import { SignClient } from "./SignClient";

/* Public signing page (no login, 11/26/2026): the client reads the agreement
   and signs it here — replaces the Canva → PDF → Go High Level upload. The
   secret token in the path is the only key; everything is checked on the
   server (/api/sign/<token>). */

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Sign your agreement — PMU Bookings On Demand",
  robots: { index: false, follow: false, nocache: true },
  referrer: "no-referrer",
};

export default function SignPage({ params }: { params: { token: string } }) {
  return <SignClient token={params.token} />;
}
