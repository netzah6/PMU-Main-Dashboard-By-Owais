import { NextRequest } from "next/server";
import { createServiceClient } from "@/lib/supabase/server";

// The saved engine a frozen funnel keeps running (/onebox-frozen/v129.js).
// Written once by the Freeze button and never changed, so the CDN keeps it for
// a year and only a cold edge reaches the database. Public, like onebox.js:
// funnel visitors load it, and the middleware matcher skips this path.
export const dynamic = "force-dynamic";
export const fetchCache = "force-no-store";

export async function GET(_req: NextRequest, { params }: { params: { file: string } }) {
  const m = /^v(\d{1,6})\.js$/.exec(params.file);
  const missing = () => new Response("Not found", { status: 404, headers: { "Cache-Control": "no-store" } });
  if (!m) return missing();
  const { data } = await createServiceClient()
    .from("onebox_engine_copies").select("body").eq("version", Number(m[1])).maybeSingle();
  if (!data) return missing();
  return new Response(data.body as string, {
    headers: {
      "Content-Type": "application/javascript; charset=utf-8",
      "Cache-Control": "public, max-age=31536000, s-maxage=31536000, immutable",
    },
  });
}
