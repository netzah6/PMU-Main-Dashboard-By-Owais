import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { StartClient } from "./StartClient";

/* Public start page for the onboarding funnel (11/26/2026): the client types
   name + email and is sent to their own signing link. Only "ppa" for now. */

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Sign your Scope of Service — PMU Bookings On Demand",
  robots: { index: false, follow: false, nocache: true },
  referrer: "no-referrer",
};

export default function StartPage({ params, searchParams }: { params: { program: string }; searchParams: { email?: string; name?: string } }) {
  if (params.program !== "ppa") notFound();
  return <StartClient program="ppa" email={String(searchParams.email ?? "").slice(0, 200)} name={String(searchParams.name ?? "").slice(0, 120)} />;
}
