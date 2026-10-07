import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase/server";

export const fetchCache = "force-no-store";

/* Photo upload for the public info-request form, authorized by the same
   per-client token. Images land in the public intake-uploads bucket; the
   form then submits the returned URLs as its photo answers. */
export async function POST(req: NextRequest, { params }: { params: { token: string } }) {
  const token = params.token;
  if (!/^[a-f0-9]{32}$/.test(token)) return NextResponse.json({ error: "bad link" }, { status: 404 });
  const svc = createServiceClient();
  const { data: client } = await svc
    .from("onebox_clients")
    .select("slug")
    .eq("extras->>intakeToken", token)
    .maybeSingle();
  if (!client) return NextResponse.json({ error: "bad link" }, { status: 404 });

  const form = await req.formData().catch(() => null);
  const file = form?.get("file");
  if (!(file instanceof File)) return NextResponse.json({ error: "file required" }, { status: 400 });
  if (!/^image\//.test(file.type)) return NextResponse.json({ error: "images only" }, { status: 400 });
  if (file.size > 8 * 1024 * 1024) return NextResponse.json({ error: "image too large (max 8MB)" }, { status: 400 });

  const ext = (file.type.split("/")[1] || "jpg").replace(/[^a-z0-9]/gi, "").slice(0, 5) || "jpg";
  const path = `${client.slug}/${Date.now()}-${crypto.randomUUID().slice(0, 8)}.${ext}`;
  const buf = Buffer.from(await file.arrayBuffer());
  const { error } = await svc.storage.from("intake-uploads").upload(path, buf, { contentType: file.type });
  if (error) return NextResponse.json({ error: "upload failed — try again" }, { status: 502 });
  const { data: pub } = svc.storage.from("intake-uploads").getPublicUrl(path);
  return NextResponse.json({ ok: true, url: pub.publicUrl });
}
