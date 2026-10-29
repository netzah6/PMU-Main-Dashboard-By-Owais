import { randomUUID } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { createClient, createServiceClient } from "@/lib/supabase/server";
import { stepByKey } from "@/lib/setup-runbook";

// How-to videos per setup step (supabase/setup-step-videos.sql).
//   GET                                   anyone signed in → { videos: StepVideo[] }
//   POST {action:"add", key, title, url}  admin — a link (Loom / YouTube / Vimeo / Drive) or an uploaded file's URL
//   POST {action:"upload", key, name}     admin — a signed URL the browser uploads the file to → { uploadUrl, url }
//   POST {action:"remove", id}            admin
//   POST {action:"move", id, dir:-1|1}    admin — reorder within the step

const BUCKET = "setup-videos";
export type StepVideo = { id: string; step_key: string; title: string; url: string; position: number };

async function who(): Promise<{ email: string; role: string } | null> {
  const supabase = createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return null;
  const svc = createServiceClient();
  const { data } = await svc.from("user_roles").select("role").eq("user_id", user.id).maybeSingle();
  return { email: user.email ?? user.id, role: String((data as { role?: string } | null)?.role ?? "") };
}

export async function GET() {
  if (!(await who())) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { data, error } = await createServiceClient().from("setup_step_videos")
    .select("id, step_key, title, url, position").order("step_key").order("position").order("created_at");
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ videos: data ?? [] });
}

export async function POST(req: NextRequest) {
  const u = await who();
  if (!u) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (u.role !== "admin") return NextResponse.json({ error: "Only an admin can change the videos" }, { status: 403 });
  const body = (await req.json().catch(() => ({}))) as { action?: string; key?: string; title?: string; url?: string; name?: string; id?: string; dir?: number };
  const svc = createServiceClient();

  if (body.action === "add") {
    const key = String(body.key ?? "");
    const title = String(body.title ?? "").trim().slice(0, 120);
    const url = String(body.url ?? "").trim();
    if (!stepByKey(key)) return NextResponse.json({ error: "Unknown step" }, { status: 400 });
    if (!title) return NextResponse.json({ error: "Give the video a short title" }, { status: 400 });
    if (!/^https:\/\/\S+$/i.test(url)) return NextResponse.json({ error: "Paste a full https:// link" }, { status: 400 });
    const { data: last } = await svc.from("setup_step_videos").select("position").eq("step_key", key).order("position", { ascending: false }).limit(1).maybeSingle();
    const position = ((last as { position?: number } | null)?.position ?? -1) + 1;
    const { data, error } = await svc.from("setup_step_videos").insert({ step_key: key, title, url, position, created_by: u.email }).select("id, step_key, title, url, position").single();
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    return NextResponse.json({ video: data });
  }

  if (body.action === "upload") {
    const key = String(body.key ?? "");
    if (!stepByKey(key)) return NextResponse.json({ error: "Unknown step" }, { status: 400 });
    const ext = (String(body.name ?? "").match(/\.(mp4|mov|webm)$/i)?.[1] ?? "mp4").toLowerCase();
    const path = `${key}/${randomUUID()}.${ext}`;
    const { data, error } = await svc.storage.from(BUCKET).createSignedUploadUrl(path);
    if (error || !data) return NextResponse.json({ error: error?.message ?? "Could not start the upload" }, { status: 500 });
    return NextResponse.json({ uploadUrl: data.signedUrl, token: data.token, path, url: svc.storage.from(BUCKET).getPublicUrl(path).data.publicUrl });
  }

  if (body.action === "remove") {
    const { data: row } = await svc.from("setup_step_videos").select("url").eq("id", String(body.id ?? "")).maybeSingle();
    const { error } = await svc.from("setup_step_videos").delete().eq("id", String(body.id ?? ""));
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    // An uploaded clip goes with its row; a pasted link is someone else's file.
    const prefix = svc.storage.from(BUCKET).getPublicUrl("").data.publicUrl;
    const url = String((row as { url?: string } | null)?.url ?? "");
    if (url.startsWith(prefix)) await svc.storage.from(BUCKET).remove([url.slice(prefix.length)]).catch(() => undefined);
    return NextResponse.json({ success: true });
  }

  if (body.action === "move") {
    const { data: row } = await svc.from("setup_step_videos").select("id, step_key").eq("id", String(body.id ?? "")).maybeSingle();
    if (!row) return NextResponse.json({ error: "Video not found" }, { status: 404 });
    const { data: list } = await svc.from("setup_step_videos").select("id").eq("step_key", (row as { step_key: string }).step_key).order("position").order("created_at");
    const ids = ((list ?? []) as Array<{ id: string }>).map((r) => r.id);
    const i = ids.indexOf((row as { id: string }).id), j = i + (body.dir === -1 ? -1 : 1);
    if (j < 0 || j >= ids.length) return NextResponse.json({ success: true });
    [ids[i], ids[j]] = [ids[j], ids[i]];
    await Promise.all(ids.map((id, position) => svc.from("setup_step_videos").update({ position }).eq("id", id)));
    return NextResponse.json({ success: true });
  }

  return NextResponse.json({ error: "Unknown action" }, { status: 400 });
}
