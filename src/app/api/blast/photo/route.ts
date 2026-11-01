import { NextRequest, NextResponse } from "next/server";
import { randomUUID } from "crypto";
import { createServiceClient } from "@/lib/supabase/server";
import { getAuth } from "@/lib/ppa";
import { BLAST_PHOTO_BUCKET, BLAST_PHOTO_PREFIX } from "@/lib/blast";

export const maxDuration = 30;

/* 📷 Photo for a text blast (owner, 11/01/2026: "an option to add a photo in
   a text blast"). The page shrinks the picture to a JPEG first; here it is
   kept in the public bucket under an unguessable name and the URL goes back
   to the page, which sends it with the blast. Nothing is texted here. */

// Carriers drop MMS past ~1 MB; the page sends ~150–400 KB.
const MAX_BYTES = 900_000;

const looksLikeImage = (b: Uint8Array) =>
  (b[0] === 0xff && b[1] === 0xd8) // JPEG
  || (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) // PNG
  || (b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46); // GIF

export async function POST(req: NextRequest) {
  const auth = await getAuth();
  if (!auth || (auth.role !== "admin" && auth.role !== "editor")) return NextResponse.json({ error: "Admins and coaches only" }, { status: 403 });
  const form = await req.formData().catch(() => null);
  const file = form?.get("file");
  if (!(file instanceof Blob) || file.size === 0) return NextResponse.json({ error: "No photo received" }, { status: 400 });
  if (file.size > MAX_BYTES) return NextResponse.json({ error: "That photo is too big for a text — try a smaller one" }, { status: 400 });
  const bytes = new Uint8Array(await file.arrayBuffer());
  if (!looksLikeImage(bytes)) return NextResponse.json({ error: "Use a JPG, PNG or GIF photo" }, { status: 400 });
  const ext = bytes[0] === 0xff ? "jpg" : bytes[0] === 0x89 ? "png" : "gif";
  const svc = createServiceClient();
  const path = `${BLAST_PHOTO_PREFIX}${new Date().toISOString().slice(0, 7)}/${randomUUID()}.${ext}`;
  const { error } = await svc.storage.from(BLAST_PHOTO_BUCKET).upload(path, bytes, {
    contentType: ext === "jpg" ? "image/jpeg" : `image/${ext}`, upsert: false, cacheControl: "31536000",
  });
  if (error) return NextResponse.json({ error: `Couldn't store the photo: ${error.message}` }, { status: 500 });
  return NextResponse.json({ url: svc.storage.from(BLAST_PHOTO_BUCKET).getPublicUrl(path).data.publicUrl });
}
