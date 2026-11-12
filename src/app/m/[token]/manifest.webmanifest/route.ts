import { NextResponse } from "next/server";

/* The client app's own install manifest: added to the home screen it opens
   THIS client's app full-screen (the root manifest belongs to the team
   dashboard and starts at /clients). Carries no client data — only the
   start address, which the person installing it already has. */
export function GET(_req: Request, { params }: { params: { token: string } }) {
  const token = /^[a-f0-9]{40,64}$/.test(params.token) ? params.token : "";
  const start = token ? `/m/${token}` : "/";
  return NextResponse.json({
    name: "PMU Bookings On Demand",
    short_name: "PMU Bookings",
    description: "Your bookings, leads and billing",
    id: start,
    start_url: start,
    scope: start,
    display: "standalone",
    orientation: "portrait",
    background_color: "#f3f7fb",
    theme_color: "#15B7AE",
    icons: [
      { src: "/icon", sizes: "512x512", type: "image/png", purpose: "any" },
      { src: "/apple-icon", sizes: "180x180", type: "image/png" },
    ],
  }, { headers: { "Content-Type": "application/manifest+json", "Cache-Control": "no-store" } });
}
