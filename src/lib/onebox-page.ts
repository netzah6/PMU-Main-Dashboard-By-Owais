import { parseFaqs, buildFanbasisBlock } from "@/lib/onebox";
import { signLogoUrl } from "@/lib/logo-sign";
import { arrangeFeed, type IgFeed, type IgPicks } from "@/lib/ig-arrange";
import type { GReviews } from "@/lib/g-reviews";

// What a one-box funnel page is made of: the config the engine reads, the FAQs,
// the checkout block, the title. Built here for the funnel route (every visit)
// and for the Freeze button (once), so a frozen page is exactly what visitors
// were seeing at the click.

export type OneboxRow = {
  slug: string;
  location_id: string;
  client_name: string;
  status: string;
  cv_synced_at: string | null;
  /* Freeze screen (owner, 11/04/2026): the saved engine version this funnel
     stays on. Set = no split tests, no (V1) switch, saved engine file. */
  frozen_engine?: number | null;
  /* What visitors saw at the click: see FrozenPage below. */
  frozen_page?: FrozenPage | null;
  config: Record<string, string>;
  extras: {
    faqs?: { q: string; a: string }[];
    fanbasisHtml?: string;
    elfsightId?: string;
    resultImgs?: string;
    metaPixelId?: string;
    /* "video" = this client's calendar slot is a video consultation, not an
       in-studio visit — the engine reframes its wording (Brows By Kali). */
    consultMode?: string;
    freeBooking?: boolean;
    bigOffer?: boolean;
    /* "b2b" = the agency's own artist-acquisition funnel: config lives in
       extras.b2b (the CV sync must never overwrite it) and the page runs
       the dedicated onebox-b2b.js engine — no Fanbasis, booking a free
       discovery call is the conversion. */
    template?: string;
    b2b?: Record<string, string>;
    /* Dashboard payment routing (see src/lib/payment-router.ts): the funnel
       never reads these, but the type mirrors the admin route's Extras so
       the two declarations stay in sync. */
    paymentRouter?: "yes" | "no";
    fanbasisHookUrl?: string;
    /* Dashboard IG-widget controls (CPD tab): igWidgetOff hides the live
       Elfsight feed entirely (e.g. the account shows another business);
       igFrozen serves igSnapshot's self-hosted copies of the posts that
       were live when the funnel converted — new IG posts stop changing
       the page. Both reversible from the Cost/Deposit analysis box. */
    igWidgetOff?: boolean;
    igFrozen?: boolean;
    igSnapshot?: { imgs: string[]; at: string };
    /* A/B #4 (owner, 10/26/2026): a Grid copy of the client's Elfsight
       widget (3 columns × 2 rows on phones). When set, visitors flip a
       coin between the live widget (a) and this one (b). */
    igGridWidget?: string;
    /* In-house feed (10/26/2026): the latest snapshot of the client's posts
       and profile, written by /api/cron/ig-fetch; the engine renders it as
       a 3 × 2 grid (side b of A/B #4, and every frozen funnel). */
    igFeed?: IgFeed;
    igPicks?: IgPicks;
    gReviews?: GReviews;
    gWidgetOff?: boolean;
  };
};

/* The agency template's six FAQs, each with its educational video. Used
   when a funnel has no custom "OB - FAQs" value; `v` = video, `p` = poster.
   10/31/2026: the GHL library originals were 4K, up to 260 MB each — these
   are the same videos re-encoded at 720p (3–10 MB, fast start) and hosted
   in the public "onboarding" bucket. */
const FAQ_MEDIA = "https://rtmiakhhohhfaqghieri.supabase.co/storage/v1/object/public/onboarding/faq/default/";
const vid = (n: number) => `${FAQ_MEDIA}pmu-faq-${n}.mp4`;
const poster = (n: number) => `${FAQ_MEDIA}pmu-faq-${n}.jpg`;
const DEFAULT_FAQS = [
  {
    q: "What is permanent makeup❓",
    a: "Permanent makeup is a beauty treatment that gently enhances your natural features — like your brows, eyeliner, or lips — so you can wake up looking polished every day without the hassle of applying makeup.",
    v: vid(1), p: poster(1),
  },
  {
    q: "Is permanent makeup the same as tattooing❓",
    a: "No. Permanent makeup is a much softer and more natural technique. Unlike traditional tattoos, the colors are designed to fade gradually over time, keeping the look fresh and allowing adjustments as your style changes.",
    v: vid(2), p: poster(2),
  },
  {
    q: "Is it painless, or does it cause discomfort❓",
    a: "Clients are pleasantly surprised at how comfortable the process is. A numbing cream is used to make the treatment as easy and relaxing as possible. Many say it feels more like light scratching than anything else.",
    v: vid(3), p: poster(3),
  },
  {
    q: "How long does the procedure take to complete❓",
    a: "The session usually takes 1.5–3 hours, which includes consultation, shaping, color selection, and the procedure itself. It's an unhurried, detailed process to make sure you leave with results you'll love.",
    v: vid(4), p: poster(4),
  },
  {
    q: "Is permanent makeup a safe procedure❓",
    a: "Yes. When done by a trained professional, permanent makeup is a safe and hygienic procedure. Certified artists use high-quality products and follow strict safety standards, so you can feel completely at ease.",
    v: vid(5), p: poster(5),
  },
  {
    q: "Is any care required after the procedure❓",
    a: "Yes, but it's simple! We'll guide you step by step. Typically, you'll just need to keep the area clean, avoid touching it too much, and let it heal naturally. Following these easy instructions helps ensure your results stay beautiful and long-lasting.",
    v: vid(6), p: poster(6),
  },
];

export type FaqItem = { q: string; a: string; v?: string; p?: string };

export type FunnelPage = {
  cfg: Record<string, string>;
  faqs: FaqItem[];
  title: string;
  logoPreload: string;
  fanbasisHtml: string;
};

function funnelLogo(raw: string): string {
  const logoRaw = raw.replace(/["\\]/g, "");
  const logoFast = !logoRaw ? ""
    : /^https:\/\/(assets\.cdn\.filesafe\.space|storage\.googleapis\.com\/msgsndr)\//.test(logoRaw)
      ? `https://images.leadconnectorhq.com/image/f_webp/q_80/r_320/u_${logoRaw}`
      : logoRaw;
  /* Serve the logo through our own immutable caching proxy: GHL's image
     service costs ~0.3-1.2s per request; behind /api/onebox/logo the first
     visitor per edge region warms it and everyone after gets ~30ms. The
     engine's fastImg passes relative URLs through untouched, so cfg.logo
     can carry the proxied form. A changed logo changes the source URL,
     which changes the proxy URL — immutability is safe. */
  const logoSig = logoFast ? signLogoUrl(logoFast) : "";
  return logoFast && logoSig && /^https:\/\/(images\.leadconnectorhq\.com|assets\.cdn\.filesafe\.space|storage\.googleapis\.com\/msgsndr|services\.leadconnectorhq\.com)\//.test(logoFast)
    ? `/api/onebox/logo?u=${encodeURIComponent(logoFast)}&s=${logoSig}`
    : logoFast;
}

export function buildFunnelPage(row: OneboxRow, req: { expId: string; expVkey: string; isPay: boolean }): FunnelPage {
  const { expId, expVkey, isPay } = req;
  const cfg: Record<string, string> = {
    ...row.config,
    slug: row.slug,
    locationId: row.location_id,
    submitUrl: "/api/onebox/submit",
    experimentId: expId,
    variantKey: expVkey,
    fanbasisSelector: "#fanbasis-checkout-wrapper",
    /* Elfsight Instagram ids are no longer sent (owner, 10/26/2026): the
       page shows our own feed only. */
    igWidget: "",
    igWidgetGrid: "",
    igFeed: (() => {
      /* Only what the engine draws: profile, pictures in order. Verdicts and
         post links stay server-side. The fetch keeps 24 to choose from; the
         page gets the best 12 (6 tiles + the tap-through), as before. */
      if (row.extras.igWidgetOff || !row.extras.igFeed?.imgs?.length) return "";
      const a = arrangeFeed(row.extras.igFeed, row.extras.igPicks);
      const imgs = a.imgs.slice(0, 12);
      const posts = ((a.posts ?? a.imgs.map((img) => ({ img }))) as { img: string; video?: string }[]).slice(0, 12);
      return imgs.length ? JSON.stringify({ imgs, posts: posts.map((p) => (p.video ? { img: p.img, video: p.video } : { img: p.img })), profile: a.profile, at: a.at }) : "";
    })(),
    igFrozenImgs: !row.extras.igWidgetOff && row.extras.igFrozen && row.extras.igSnapshot?.imgs?.length
      ? row.extras.igSnapshot.imgs.join(",")
      : "",
    /* Google reviews, in-house (10/27/2026): the server's copy of the place's
       rating + best reviews. The Elfsight reviews widget is gone. */
    /* Owner (10/27/2026): the count is social proof only from 20 reviews
       up, and a score under 4.5 is better left unsaid — stars and the
       written reviews still show. */
    gReviews: row.extras.gWidgetOff || !row.extras.gReviews?.reviews?.length ? "" : JSON.stringify({
      rating: row.extras.gReviews.rating != null && row.extras.gReviews.rating >= 4.5 ? row.extras.gReviews.rating : null,
      count: row.extras.gReviews.count != null && row.extras.gReviews.count >= 20 ? row.extras.gReviews.count : null,
      reviews: row.extras.gReviews.reviews.slice(0, 6).map((r) => ({ name: r.name, pic: r.pic, stars: r.stars, text: r.text.slice(0, 700), when: r.when })),
    }),
    resultImgs: row.config.resultImgs || row.extras.resultImgs || "",
    studioImgs: row.config.studioImgs || "",
    metaPixelId: (row.config.metaPixelId || row.extras.metaPixelId || "").replace(/\D/g, ""),
    surveyRaw: row.config.surveyRaw || "",
    consultMode: row.extras.consultMode || "",
    freeBooking: row.extras.freeBooking ? "1" : "",
    bigOffer: row.extras.bigOffer ? "1" : "",
    pay: isPay ? "1" : "",
  };
  /* Same URL the engine will render (its fastImg proxies media-library
     files) so the preload warms the right resource, never a second one. */
  /* A per-account webhook secret: the engine never reads it, and the page is public. */
  delete cfg.fanbasisHookUrl;
  const logoPreload = funnelLogo(cfg.logo || "");
  if (logoPreload) cfg.logo = logoPreload;
  const title = `${row.client_name || cfg.biz || "Book"} — Claim Your Offer`;
  // </script> inside the JSON payloads must not terminate the script tag.
  // Fanbasis block, in order of preference:
  //   1. product id  (the simple way — CC - Fanbasis Product ID)
  //   2. the whole pasted block (CC - Fanbasis Checkout Code)
  //   3. the Extras paste
  // Any relative thank-you path is made absolute to pmu-care.com.
  const absThankYou = (p: string) =>
    !p ? "" : /^https?:\/\//i.test(p) ? p : `https://pmu-care.com/${p.replace(/^\/+/, "")}`;
  let fanbasisHtml = "";
  const productId = (row.config.fanbasisProductId || "").trim();
  if (productId) {
    fanbasisHtml = buildFanbasisBlock(productId, absThankYou((row.config.thankYouPath || "").trim()));
  } else {
    fanbasisHtml = (row.config.fanbasisCode || "").trim() || row.extras.fanbasisHtml || "";
    if (fanbasisHtml) {
      fanbasisHtml = fanbasisHtml.replace(
        /REDIRECT_URL\s*=\s*'([^']*)'/,
        (m, u: string) => /^https?:\/\//i.test(u) ? m : `REDIRECT_URL = '${absThankYou(u)}'`
      );
    }
  }
  const customFaqs = row.config.faqsRaw ? parseFaqs(row.config.faqsRaw) : row.extras.faqs ?? [];
  const faqs = customFaqs.length ? customFaqs : DEFAULT_FAQS;
  return { cfg, faqs, title, logoPreload, fanbasisHtml };
}

/* ── Freeze (owner, 11/04/2026): "freeze everything" ──
   Everything a visitor reads or sees comes from the snapshot, except what would
   break a booking, a payment or send someone to the wrong place:
   the calendar, the deposit amount (it has to match the charge), free booking and
   video mode (they decide whether a deposit is taken), the phone and address, the
   pixel, and the checkout block (served live, so an urgent payment fix reaches
   every funnel: commit 7af67a7, 08/24/2026). */
const LIVE_KEYS = new Set([
  "slug", "locationId", "submitUrl", "experimentId", "variantKey", "fanbasisSelector", "pay", "flow",
  "calendarId", "deposit", "freeBooking", "consultMode", "phone", "address", "metaPixelId",
  "fanbasisProductId", "fanbasisCode", "fanbasisHookUrl", "thankYouPath", "depositFunnelUrl",
]);

/* The values someone can still edit for a frozen client. Changing one doesn't
   reach the page, so the Freeze screen lists it and offers to take it. */
const DRIFT_LABELS: Record<string, string> = {
  offer: "Offer", biz: "Business name",
  headline: "Headline", sub: "Subheadline", congrats: "Congrats line", bookingHead: "Booking headline", depositHead: "Deposit headline",
  surveyRaw: "Survey questions", faqsRaw: "FAQs", logo: "Logo",
  resultImgs: "Result photos", resultCvImgs: "Result photos", studioImgs: "Studio photos", studioCvImgs: "Studio photos",
  igLink: "Instagram link",
};
const DRIFT_SHOWS_VALUE = new Set(["offer", "biz", "headline", "sub", "congrats", "bookingHead", "depositHead"]);

export type FrozenPage = {
  cfg: Record<string, string>;
  faqs: FaqItem[];
  title: string;
  /* The editable values at the click, as they are in GHL, to spot later edits. */
  source: Record<string, string>;
  /* Which Instagram posts and header the page shows, for the timeline. The picture
     addresses can't tell: each fetch saves the same posts under a new date folder. */
  ig?: { posts: string[]; first: string[]; picks: unknown; profile: string[] };
};

export type Drift = { key: string; label: string; from?: string; to?: string };

const pickSource = (row: OneboxRow) =>
  Object.fromEntries(Object.keys(DRIFT_LABELS).map((k) => [k, String(row.config[k] ?? "")]));

export function snapshotFunnelPage(row: OneboxRow): FrozenPage {
  const { cfg, faqs, title } = buildFunnelPage(row, { expId: "", expVkey: "", isPay: false });
  /* Live values are never read from a snapshot, so they aren't copied into it. */
  const kept = Object.fromEntries(Object.entries(cfg).filter(([k]) => !LIVE_KEYS.has(k)));
  const fixed = String(cfg.igFrozenImgs ?? "").split(",").filter((u) => u.trim());
  const feed = row.extras?.igFeed;
  const arranged = !fixed.length && cfg.igFeed && feed ? arrangeFeed(feed, row.extras?.igPicks) : null;
  const posts = fixed.length ? fixed : (arranged?.posts ?? []).slice(0, 12).map((x) => x.url || x.img);
  const prof = feed?.profile;
  return {
    cfg: kept, faqs, title, source: pickSource(row),
    /* Sorted, so a small reorder is no change, but visitors see the first six, so a
       new first row is. */
    ig: { posts: [...posts].sort(), first: posts.slice(0, 6).sort(), picks: row.extras?.igPicks ?? null, profile: [prof?.username ?? "", prof?.name ?? "", prof?.bio ?? "", prof?.category ?? ""] },
  };
}

export function lockFunnelPage(page: FunnelPage, frozen: FrozenPage): void {
  /* A value added after the click (photos in a slot that was empty) must not
     appear either: only what the snapshot has reaches the page. */
  for (const k of Object.keys(page.cfg)) {
    if (!LIVE_KEYS.has(k) && !(k in frozen.cfg)) delete page.cfg[k];
  }
  for (const [k, v] of Object.entries(frozen.cfg)) {
    if (!LIVE_KEYS.has(k)) page.cfg[k] = v;
  }
  /* Same logo, re-signed on each render: a stored signature would break the
     picture the day the signing secret changes. */
  const logo = funnelLogo(frozen.source.logo ?? "");
  page.cfg.logo = logo;
  page.logoPreload = logo;
  page.faqs = frozen.faqs;
  page.title = frozen.title;
}

export function frozenDrift(row: OneboxRow): Drift[] {
  const source = row.frozen_page?.source;
  if (!source) return [];
  const seen = new Set<string>();
  const out: Drift[] = [];
  for (const [key, label] of Object.entries(DRIFT_LABELS)) {
    const now = String(row.config[key] ?? "");
    if (now === (source[key] ?? "") || seen.has(label)) continue;
    seen.add(label);
    out.push(DRIFT_SHOWS_VALUE.has(key) ? { key, label, from: source[key] ?? "", to: now } : { key, label });
  }
  return out;
}

/* "Use the new values": only what changed moves into the snapshot; the pictures,
   reviews and everything else stay as they were at the click. */
export function acceptFrozenDrift(row: OneboxRow): FrozenPage | null {
  const frozen = row.frozen_page;
  if (!frozen) return null;
  const fresh = buildFunnelPage(row, { expId: "", expVkey: "", isPay: false });
  const next: FrozenPage = { ...frozen, cfg: { ...frozen.cfg }, source: { ...frozen.source } };
  for (const key of Object.keys(DRIFT_LABELS)) {
    const now = String(row.config[key] ?? "");
    if (now === (frozen.source[key] ?? "")) continue;
    next.source[key] = now;
    if (key === "faqsRaw") next.faqs = fresh.faqs;
    else next.cfg[key] = fresh.cfg[key] ?? "";
  }
  return next;
}
