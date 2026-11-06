import { imageHash } from "@/lib/img-hash";
import { hashDistance } from "@/lib/ig-arrange";
const B = "https://rtmiakhhohhfaqghieri.supabase.co/storage/v1/object/public/onebox-ig/";
(async () => {
  const pairs = [["modern-artistry-spa-wellness/reels/Ddun_wuPHGW-f4.jpg", "modern-artistry-spa-wellness/reels/DduRFz9zCas-f4.jpg"],
    ["naples-beauty/2026-10-28/11.jpg", "naples-beauty/2026-10-28/12.jpg"],
    ["jacklyn-beauty-spa/reels/De9orJOR0Uh-f10.jpg", "jacklyn-beauty-spa/reels/DfAJkIfxl56-f9.jpg"],
    ["make-up-by-maria-blanco/2026-10-28/1.jpg", "make-up-by-maria-blanco/reels/Dc1h3UnAouA-f1.jpg"],
    ["helena-brows-and-lips/2026-11-03/1.jpg", "helena-brows-and-lips/2026-11-03/2.jpg"]];
  for (const [a, b] of pairs) {
    const [ha, hb] = await Promise.all([a, b].map(async (u) => imageHash(Buffer.from(await (await fetch(B + u)).arrayBuffer()))));
    console.log(a.split("/")[0], ha, hb, ha && hb ? hashDistance(ha, hb) : "?");
  }
})();
