import { NextRequest, NextResponse } from "next/server";
import { randomUUID } from "crypto";
import { createServiceClient } from "@/lib/supabase/server";
import { getAuth } from "@/lib/ppa";
import {
  COACH_PHOTO_BUCKET, COACH_PHOTO_PREFIX, coachSlug, nameFromSlug, profileKey, readProfile, type CoachProfile,
} from "@/lib/coach-profile";

export const maxDuration = 30;

/* 🎬 Presentations tab — the coach's own profile picture.
   GET  → my profile (+ every coach's, for an admin).
   POST → a new picture (multipart "file"; an admin may add "slug" to set a
          coach's picture for her). The page crops it to a square JPEG first. */

const MAX_BYTES = 2_000_000;
const isJpegOrPng = (b: Uint8Array) =>
  (b[0] === 0xff && b[1] === 0xd8) || (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47);

type Svc = ReturnType<typeof createServiceClient>;
type Seat = { email: string; team_name: string | null };

const allowed = (role: string | null) => role === "admin" || role === "editor";

async function coachSeats(svc: Svc): Promise<Seat[]> {
  const { data } = await svc.from("user_roles").select("email, team_name, role").eq("role", "editor").order("email");
  return ((data ?? []) as Array<Seat & { role: string }>).filter((r) => coachSlug(r.email));
}

async function profileFor(svc: Svc, email: string, teamName?: string | null): Promise<CoachProfile> {
  const slug = coachSlug(email);
  const saved = await readProfile(svc, slug);
  return {
    slug,
    name: (teamName ?? "").trim().split(/\s+/)[0] || saved?.name || nameFromSlug(slug),
    email: email.toLowerCase(),
    photo: saved?.photo ?? null,
  };
}

export async function GET() {
  const auth = await getAuth();
  if (!auth || !allowed(auth.role)) return NextResponse.json({ error: "Admins and coaches only" }, { status: 403 });
  const svc = createServiceClient();
  const me = await profileFor(svc, auth.email ?? "");
  if (auth.role !== "admin") return NextResponse.json({ me, coaches: [] });
  const seats = await coachSeats(svc);
  const coaches = await Promise.all(seats.map((s) => profileFor(svc, s.email, s.team_name)));
  return NextResponse.json({ me, coaches });
}

export async function POST(req: NextRequest) {
  const auth = await getAuth();
  if (!auth || !allowed(auth.role)) return NextResponse.json({ error: "Admins and coaches only" }, { status: 403 });
  const form = await req.formData().catch(() => null);
  const file = form?.get("file");
  if (!(file instanceof Blob) || file.size === 0) return NextResponse.json({ error: "No picture received" }, { status: 400 });
  if (file.size > MAX_BYTES) return NextResponse.json({ error: "That picture is too big — try again" }, { status: 400 });
  const bytes = new Uint8Array(await file.arrayBuffer());
  if (!isJpegOrPng(bytes)) return NextResponse.json({ error: "Use a JPG or PNG picture" }, { status: 400 });

  const svc = createServiceClient();
  // Whose picture: mine — or, for an admin, the coach named in "slug".
  let email = auth.email ?? "";
  let teamName: string | null = null;
  const wanted = coachSlug(String(form?.get("slug") ?? ""));
  if (wanted && wanted !== coachSlug(email)) {
    if (auth.role !== "admin") return NextResponse.json({ error: "You can only change your own picture" }, { status: 403 });
    const seat = (await coachSeats(svc)).find((s) => coachSlug(s.email) === wanted);
    if (!seat) return NextResponse.json({ error: "No coach with that name" }, { status: 404 });
    email = seat.email; teamName = seat.team_name;
  }
  const before = await profileFor(svc, email, teamName);
  if (!before.slug) return NextResponse.json({ error: "No email on this account" }, { status: 400 });

  const ext = bytes[0] === 0xff ? "jpg" : "png";
  const path = `${COACH_PHOTO_PREFIX}${before.slug}-${randomUUID()}.${ext}`;
  const { error: upErr } = await svc.storage.from(COACH_PHOTO_BUCKET).upload(path, bytes, {
    contentType: ext === "jpg" ? "image/jpeg" : "image/png", upsert: false, cacheControl: "31536000",
  });
  if (upErr) return NextResponse.json({ error: `Couldn't store the picture: ${upErr.message}` }, { status: 500 });
  const photo = svc.storage.from(COACH_PHOTO_BUCKET).getPublicUrl(path).data.publicUrl;

  const profile: CoachProfile = { ...before, photo };
  const { error } = await svc.from("app_settings").upsert({
    key: profileKey(profile.slug), value: profile, updated_by: auth.email, updated_at: new Date().toISOString(),
  });
  if (error) {
    await svc.storage.from(COACH_PHOTO_BUCKET).remove([path]).catch(() => undefined);
    return NextResponse.json({ error: `Couldn't save the picture: ${error.message}` }, { status: 500 });
  }
  // The picture it replaces is no longer shown anywhere.
  const prefix = svc.storage.from(COACH_PHOTO_BUCKET).getPublicUrl("").data.publicUrl;
  if (before.photo && before.photo.startsWith(prefix + COACH_PHOTO_PREFIX)) {
    await svc.storage.from(COACH_PHOTO_BUCKET).remove([before.photo.slice(prefix.length)]).catch(() => undefined);
  }
  return NextResponse.json({ profile });
}
