/* Thank-you page extras (owner, 11/25/2026): the team adds the artist's own
   touch to the thank-you step themselves — a short note, a website button,
   a picture, a video — from the Funnels tab, instead of asking the owner.
   Stored in onebox_clients.extras.tyExtra; the engine (public/onebox.js,
   slideDone) shows it under the "confirmed" card. Post-payment only, so it
   never changes what a visitor sees before paying. */

export type TyExtra = {
  note?: string;        // plain text, line breaks kept
  linkLabel?: string;   // button text, e.g. "Visit our website"
  linkUrl?: string;     // http(s) only
  img?: string;         // picture URL (https)
  video?: string;       // video file URL (https, mp4/mov/webm)
  by?: string;          // who saved it last
  at?: string;          // ISO, when
};

export const TY_LIMITS = { note: 600, linkLabel: 40, url: 500 };

const httpsUrl = (v: unknown): string => {
  const s = String(v ?? "").trim();
  if (!s) return "";
  try {
    const u = new URL(s);
    return u.protocol === "https:" || u.protocol === "http:" ? u.toString().slice(0, TY_LIMITS.url) : "";
  } catch {
    return "";
  }
};

/* Cleans what the dashboard sent. Returns an error string for a value that
   can't be saved, or the cleaned extras (null = everything empty → remove). */
export function cleanTyExtra(body: Record<string, unknown>): { error: string } | { value: TyExtra | null } {
  const note = String(body.tyNote ?? "").replace(/\r\n/g, "\n").trim();
  if (note.length > TY_LIMITS.note) return { error: `The note is too long (max ${TY_LIMITS.note} letters).` };
  const linkLabel = String(body.tyLinkLabel ?? "").trim().slice(0, TY_LIMITS.linkLabel);
  const rawLink = String(body.tyLinkUrl ?? "").trim();
  // "studio.com" typed without https:// still works.
  const linkUrl = httpsUrl(rawLink && !/^[a-z]+:\/\//i.test(rawLink) ? `https://${rawLink}` : rawLink);
  if (rawLink && !linkUrl) return { error: "The website link doesn't look right. Example: https://yourstudio.com" };
  const img = httpsUrl(body.tyImg);
  if (String(body.tyImg ?? "").trim() && !img) return { error: "The picture link doesn't look right." };
  const video = httpsUrl(body.tyVideo);
  if (String(body.tyVideo ?? "").trim() && !video) return { error: "The video link doesn't look right." };
  if (!note && !linkUrl && !img && !video) return { value: null };
  return { value: { ...(note ? { note } : {}), ...(linkUrl ? { linkUrl, linkLabel: linkLabel || "Visit our website" } : {}), ...(img ? { img } : {}), ...(video ? { video } : {}) } };
}

/* What the public page gets: content only, never who saved it. */
export function tyExtraForPage(t: TyExtra | undefined | null): string {
  if (!t) return "";
  const out: TyExtra = {};
  if (t.note) out.note = t.note;
  if (t.linkUrl) { out.linkUrl = t.linkUrl; out.linkLabel = t.linkLabel || "Visit our website"; }
  if (t.img) out.img = t.img;
  if (t.video) out.video = t.video;
  return Object.keys(out).length ? JSON.stringify(out) : "";
}
