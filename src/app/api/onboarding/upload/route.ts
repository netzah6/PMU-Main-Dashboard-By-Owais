import { NextRequest, NextResponse } from "next/server";
import { createClient, createServiceClient } from "@/lib/supabase/server";

export const maxDuration = 60;

// Image upload for the onboarding form (funnel logo, studio pictures,
// before/afters). Stored in the public "onboarding" bucket; the returned URL
// goes into the form field and, at claim time, into the GHL custom value the
// funnel renders.
const MAX_BYTES = 8 * 1024 * 1024;
const ALLOWED = new Set(["image/jpeg", "image/png", "image/webp", "image/gif", "image/svg+xml"]);

export async function POST(req: NextRequest) {
  const supabase = createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const form = await req.formData().catch(() => null);
  const file = form?.get("file");
  if (!(file instanceof File)) return NextResponse.json({ error: "No file" }, { status: 400 });
  if (!ALLOWED.has(file.type)) return NextResponse.json({ error: `Unsupported type ${file.type} — use JPG/PNG/WebP` }, { status: 400 });
  if (file.size > MAX_BYTES) return NextResponse.json({ error: "File too large (max 8 MB)" }, { status: 400 });

  const ext = (file.name.split(".").pop() ?? "jpg").toLowerCase().replace(/[^a-z0-9]/g, "") || "jpg";
  const path = `${new Date().toISOString().slice(0, 10)}/${crypto.randomUUID()}.${ext}`;

  const svc = createServiceClient();
  const { error } = await svc.storage.from("onboarding").upload(path, file, {
    contentType: file.type,
    cacheControl: "31536000",
  });
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  const { data } = svc.storage.from("onboarding").getPublicUrl(path);
  return NextResponse.json({ url: data.publicUrl });
}
