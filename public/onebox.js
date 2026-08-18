/* One-Box Funnel engine — survey → booking → deposit in a single card.
 *
 * Served from the dashboard (like lead-pixel.js). Each client funnel embeds a
 * tiny custom-code snippet that fills window.OB_CONFIG from GHL merge tags and
 * loads this script; updating this file updates every client's funnel at once.
 *
 * Config (all strings; populated by {{ custom_values.* }} in the snippet):
 *   biz         {{ custom_values.business_name }}
 *   phone       {{ custom_values.business_phone_number }}
 *   address     {{ custom_values.full_business_address }}
 *   offer       {{ custom_values.offer }}               e.g. "$200 OFF!"
 *   deposit     {{ custom_values.cc__deposit_amount_ }} e.g. "$50"
 *   logo        {{ custom_values.logo }}
 *   igLink      {{ custom_values.ig_business_page_link }}
 *   calendarId  {{ custom_values.cc__permanent_makeup_transformation_calendar_id }}
 *   locationId  {{ location.id }}
 *   surveyId    per-funnel: the GHL survey that receives the lead (existing
 *               V2/V3 survey id, so today's automations fire unchanged)
 *   fanbasisSelector  CSS selector of the (hidden) Fanbasis wrapper element on
 *               the page; the deposit step reveals it inside the box.
 *   resultImgs  comma-separated image URLs for "See Real Client Results"
 *   studioImgs  comma-separated studio photo URLs (shown with the map)
 *   elfsightId  optional Elfsight app id for the real IG/reviews widget
 */
(function () {
  "use strict";
  var C = window.OB_CONFIG || {};
  var root = document.getElementById("onebox-root");
  if (!root) return;

  var BIZ = (C.biz || "").trim() || "Our Studio";
  var PHONE = (C.phone || "").trim();
  var ADDR = (C.address || "").trim();
  var OFFERR = (C.offer || "").trim();
  var DEPOSIT = (C.deposit || "").trim() || "$50";
  var LOGO = (C.logo || "").trim();
  var IGLINK = (C.igLink || "").trim();
  var CAL = (C.calendarId || "").trim();
  function imgList() {
    var seen = {}, out = [];
    for (var i = 0; i < arguments.length; i++) {
      (arguments[i] || "").split(",").forEach(function (s) {
        s = s.trim();
        if (s && !seen[s]) { seen[s] = 1; out.push(s); }
      });
    }
    return out;
  }
  /* Template CV slots first (Eyebrows/Lip blush/Eyeliner B&A 1-3, Picture
     of Studio 1-3, aggregated server-side), then dashboard extras, deduped. */
  var RESULTS = imgList(C.resultCvImgs, C.resultImgs);
  var STUDIO = imgList(C.studioCvImgs, C.studioImgs);

  /* Meta pixel: the client's own pixel id (harvested from their existing
     funnel or set via the "OB - Meta Pixel ID" custom value). Fires
     PageView here, Lead on survey completion, Schedule on booking. */
  var PIXEL = (C.metaPixelId || "").replace(/\D/g, "");
  if (PIXEL) {
    (function (f, b, e, v, n, t, s) {
      if (f.fbq) return; n = f.fbq = function () { n.callMethod ? n.callMethod.apply(n, arguments) : n.queue.push(arguments); };
      if (!f._fbq) f._fbq = n; n.push = n; n.loaded = !0; n.version = "2.0"; n.queue = [];
      t = b.createElement(e); t.async = !0; t.src = v; s = b.getElementsByTagName(e)[0]; s.parentNode.insertBefore(t, s);
    })(window, document, "script", "https://connect.facebook.net/en_US/fbevents.js");
    window.fbq("init", PIXEL);
    window.fbq("track", "PageView");
  }
  function newEventId() {
    try { return crypto.randomUUID(); } catch (e) {}
    return "ob-" + Date.now() + "-" + Math.floor(Math.random() * 1e9);
  }
  /* The same event_id goes to the browser pixel and to our server, so the
     Conversions API copy is deduplicated against this one by Meta. */
  function pixelTrack(ev, params) {
    var id = newEventId();
    state.eventIds[ev] = id;
    if (PIXEL && window.fbq) {
      try { window.fbq("track", ev, params || {}, { eventID: id }); } catch (e) {}
    }
    return id;
  }
  function cookie(name) {
    var m = document.cookie.match("(^|; )" + name + "=([^;]*)");
    return m ? decodeURIComponent(m[2]) : "";
  }

  /* Fonts: real Google Fonts on GHL (no CSP here). */
  var fl = document.createElement("link");
  fl.rel = "stylesheet";
  fl.href = "https://fonts.googleapis.com/css2?family=Montserrat:wght@400;700&family=Lato:wght@400;700&family=Inter:wght@400;600&display=swap";
  /* The page already links these (server-rendered, so they download in
     parallel with this file) — only inject when embedded elsewhere. */
  if (!document.querySelector('link[href*="fonts.googleapis.com/css2"]')) document.head.appendChild(fl);

  var css = "" +
    "#onebox-root{--teal:#17c3c3;--teal-deep:#0e9c9c;--ink:#111315;--ink-soft:#3d4348;--muted:#6f777d;--line:#e4e7e9;--mint-bg:#d8f5de;--mint-line:#8fd7a1;--mint-ink:#186b2f;--amber:#e8a33d;--gold:#ffc107;--footer:#2b2d2f;--headline:'Montserrat','Helvetica Neue',Arial,sans-serif;--content:'Lato','Helvetica Neue',Arial,sans-serif;--form:'Inter',system-ui,sans-serif;font-family:var(--content);color:var(--ink);background:#fff}" +
    "#onebox-root *{box-sizing:border-box}" +
    "#onebox-root .topbar{background:var(--teal);min-height:30px;display:flex;align-items:center;justify-content:center;gap:6px;padding:6px 14px;text-align:center}" +
    "#onebox-root .topbar svg{width:13px;height:13px;fill:#111;flex:none}" +
    "#onebox-root .topbar span{font-family:var(--headline);font-weight:400;font-size:13.5px;color:#111;line-height:1.3}" +
    "#onebox-root .callbar{border-bottom:1px solid var(--line);padding:11px 20px;text-align:center;font-size:15px;font-weight:700;font-family:var(--headline)}" +
    "#onebox-root .wrap{padding:20px 20px 44px;max-width:720px;margin:0 auto;min-height:calc(100vh - 74px);min-height:calc(100svh - 74px)}" +
    "#onebox-root .biglogo{display:block;margin:0 auto 12px;max-height:64px;width:auto}" +
    "#onebox-root .lede{text-align:center;margin:0;font-size:15px;color:var(--ink-soft)}" +
    "#onebox-root h1.page{font-family:var(--headline);font-weight:700;font-size:clamp(24px,3.4vw,30px);line-height:1.2;letter-spacing:-.01em;text-align:center;text-wrap:balance;margin:8px auto 0;max-width:24ch;color:#000}" +
    "#onebox-root .sub{font-family:var(--headline);font-weight:400;font-size:18px;text-align:center;margin:6px 0 0;color:var(--ink-soft)}" +
    "#onebox-root .trust{text-align:center;padding:0 20px;margin-bottom:12px}" +
    "#onebox-root.nohero .lede,#onebox-root.nohero h1.page,#onebox-root.nohero .sub,#onebox-root.nohero .biglogo{display:none}" +
    "#onebox-root.nohero .wrap{padding-top:8px}" +
    "#onebox-root.nohero .trust{margin-bottom:0}" +
    "#onebox-root.nohero .box{margin-top:10px}" +
    "#onebox-root .trust p{margin:0;font-size:14px;color:var(--ink-soft)}" +
    "#onebox-root .stars{color:var(--gold);letter-spacing:.14em;font-size:15px;margin-top:3px}" +
    "#onebox-root .box{margin:20px auto 0;max-width:560px;background:#fff;border-radius:12px;border:1px solid var(--line);box-shadow:0 24px 48px -20px rgba(17,19,21,.28),0 4px 14px -8px rgba(17,19,21,.14);overflow:hidden;font-family:var(--form)}" +
    "#onebox-root .rail{margin:14px 16px 0;height:24px;border-radius:999px;background:#e9edef;overflow:hidden}" +
    "#onebox-root .rail span{display:grid;place-items:center;height:100%;border-radius:999px;background:repeating-linear-gradient(135deg,var(--teal) 0 11px,var(--teal-deep) 11px 22px);color:#fff;font-size:11px;font-weight:600;white-space:nowrap;transition:width .45s cubic-bezier(.4,0,.2,1);min-width:44px;animation:ob-railmove 1.1s linear infinite}" +
    "@keyframes ob-railmove{to{background-position:31.11px 0}}" +
    "@media(min-width:768px){#onebox-root .wrap{padding-top:34px}#onebox-root .biglogo{max-height:86px;margin-bottom:22px}#onebox-root h1.page{margin-top:16px}#onebox-root .sub{margin-top:10px}#onebox-root .trust{margin-bottom:18px}#onebox-root .box{margin-top:32px}" +
    /* desktop: the 3 studio portraits share one cropped row - no tall gaps */
    "#onebox-root .studio{grid-template-columns:repeat(3,1fr)}#onebox-root .studio img{aspect-ratio:3/4;object-fit:cover}}" +
    "#onebox-root .slide{padding:22px 26px 26px;min-height:210px}" +
    "#onebox-root .slide.anim-next{animation:ob-in-next .3s ease both}" +
    "#onebox-root .slide.anim-prev{animation:ob-in-prev .3s ease both}" +
    "@keyframes ob-in-next{from{opacity:0;transform:translateX(46px)}to{opacity:1;transform:none}}" +
    "@keyframes ob-in-prev{from{opacity:0;transform:translateX(-46px)}to{opacity:1;transform:none}}" +
    "#onebox-root .qlabel{font-size:16px;font-weight:600;margin:0 0 16px;line-height:1.45;letter-spacing:-.01em}" +
    "#onebox-root .qlabel em{font-style:normal;color:#d33}" +
    "#onebox-root label.qlabel{margin-bottom:24px;display:block}" +
    "#onebox-root .opts{display:flex;flex-direction:column;gap:9px}" +
    "#onebox-root .opt{display:flex;align-items:center;gap:12px;padding:13px 15px;cursor:pointer;font-size:14.5px;font-weight:500;border:1.5px solid #cdeeed;border-radius:10px;background:#f4fbfb;transition:border-color .15s,background .15s,box-shadow .15s}" +
    "#onebox-root .opt:hover{border-color:var(--teal);background:#e4f6f6}" +
    "#onebox-root .opt:has(input:checked){border-color:var(--teal);background:#eefafa;box-shadow:0 0 0 3px rgba(23,195,195,.14)}" +
    "#onebox-root .opt input{accent-color:var(--teal-deep);width:16px;height:16px;margin:0;cursor:pointer;flex:none}" +
    "#onebox-root .field{width:100%;padding:11px 12px;border:1px solid var(--line);border-radius:4px;font:inherit;font-size:16px;color:var(--ink)}" +
    "#onebox-root .err{color:#d33;font-size:12px;margin:8px 0 0;min-height:1.1em}" +
    "#onebox-root .field.err-f{border-color:#d33;box-shadow:0 0 0 3px rgba(221,51,51,.08)}" +
    "#onebox-root .trustnote{margin:10px 0 0;font-size:12px;color:var(--muted);font-family:var(--form);display:flex;align-items:center;gap:6px}" +
    "#onebox-root .skel{max-width:340px;margin:8px auto}" +
    "#onebox-root .skel div{height:16px;border-radius:8px;margin:10px 0;background:linear-gradient(90deg,#eef1f2 25%,#f7f9f9 50%,#eef1f2 75%);background-size:200% 100%;animation:ob-shimmer 1.2s infinite}" +
    "#onebox-root .skel div:nth-child(2){width:75%}#onebox-root .skel div:nth-child(3){width:55%}" +
    "@keyframes ob-shimmer{from{background-position:200% 0}to{background-position:-200% 0}}" +
    "#onebox-root .obslots button.booking{background:var(--teal);border-color:var(--teal);color:#fff;cursor:wait}" +
    "#onebox-root .spin{display:inline-block;width:12px;height:12px;border:2px solid rgba(255,255,255,.45);border-top-color:#fff;border-radius:50%;animation:ob-spin .7s linear infinite;vertical-align:-2px;margin-right:6px}" +
    "@keyframes ob-spin{to{transform:rotate(360deg)}}" +
    "#onebox-root .backlink{background:none;border:0;color:var(--muted);font-family:var(--form);font-size:12.5px;cursor:pointer;padding:0;margin:16px auto 0;display:flex;align-items:center;justify-content:center;gap:4px;transition:color .15s;width:100%}" +
    "#onebox-root .backlink:hover{color:var(--teal-deep)}" +
    "#onebox-root .vlabel{text-align:center;font-family:var(--form);font-size:11px;font-weight:600;letter-spacing:.12em;color:var(--muted);margin:2px 0 10px;text-transform:uppercase}" +
    "#onebox-root .chips{display:flex;justify-content:center;gap:10px;margin:0 0 18px}" +
    "#onebox-root .chips div{border:1px solid var(--line);border-radius:10px;padding:9px 0;width:72px;text-align:center;box-shadow:0 3px 8px -6px rgba(17,19,21,.25)}" +
    "#onebox-root .chips b{display:block;font-size:22px;font-weight:700;font-family:var(--headline);line-height:1;font-variant-numeric:tabular-nums}" +
    "#onebox-root .chips span{font-size:9px;font-weight:600;letter-spacing:.08em;color:var(--muted);font-family:var(--form);text-transform:uppercase}" +
    "#onebox-root .confcard{background:#f7f9f9;border:1px solid var(--line);border-radius:12px;padding:18px 18px 16px;margin:0 0 16px}" +
    "#onebox-root .confcard h3{margin:0 0 10px;font-family:var(--headline);font-weight:700;font-size:16.5px;color:#000}" +
    "#onebox-root .confcard p{margin:0 0 10px;font-family:var(--content);font-size:13.5px;line-height:1.55;color:var(--ink-soft)}" +
    "#onebox-root .confwhen{font-family:var(--headline);font-weight:700;font-size:16px;color:#000!important;margin:0 0 2px!important}" +
    "#onebox-root .confrel{color:var(--teal-deep)!important;font-weight:700;font-size:13px!important;font-family:var(--form)!important;margin:0 0 8px!important}" +
    "#onebox-root .confaddr{font-size:12.5px!important;color:var(--muted)!important;margin:0!important}" +
    "#onebox-root .confyes{display:block;width:100%;border:0;border-radius:12px;padding:13px;cursor:pointer;background:linear-gradient(100deg,#5adbd4,var(--teal) 60%,var(--teal-deep));box-shadow:0 10px 22px -10px rgba(23,195,195,.55);transition:filter .15s;margin:0 0 10px}" +
    "#onebox-root .stickycta{position:fixed;left:14px;right:14px;bottom:14px;z-index:2147483000;display:flex;justify-content:center;opacity:0;pointer-events:none;transform:translateY(12px);transition:opacity .25s,transform .25s}" +
    "#onebox-root .stickycta.on{opacity:1;pointer-events:auto;transform:none}" +
    "#onebox-root .stickycta button{width:100%;max-width:560px;cursor:pointer;border-radius:14px;padding:13px 18px;background:linear-gradient(100deg,#5adbd4,var(--teal) 60%,var(--teal-deep));border:2px solid rgba(255,255,255,.75);box-shadow:0 0 0 3px rgba(13,43,51,.9),0 16px 34px -10px rgba(17,19,21,.5);font-family:var(--form);text-align:center;transition:transform .12s,filter .12s}" +
    "#onebox-root .stickycta button:active{transform:scale(.97);filter:brightness(.96)}" +
    "#onebox-root .stickycta b{display:block;font-size:17px;font-weight:800;color:#0d2b33;letter-spacing:-.01em}" +
    "#onebox-root .stickycta span{display:block;font-size:12px;font-weight:600;color:#0d3b40;opacity:.85;margin-top:2px}" +
    "#onebox-root .confyes:hover:not(:disabled){filter:brightness(1.05)}" +
    "#onebox-root .confyes:disabled{cursor:not-allowed;filter:saturate(.35);opacity:.75;box-shadow:none}" +
    "#onebox-root .confyes b{display:block;font-family:var(--headline);font-weight:700;font-size:15.5px;color:#083b3b}" +
    "#onebox-root .confyes span{display:block;font-family:var(--form);font-size:11.5px;color:#0b4f4d;margin-top:2px}" +
    "#onebox-root .confalt{display:block;width:100%;border:1.5px solid var(--line);border-radius:12px;padding:12px;background:#fff;cursor:pointer;font-family:var(--form);font-size:13.5px;font-weight:600;color:var(--ink-soft);transition:border-color .15s}" +
    "#onebox-root .confalt:hover{border-color:var(--teal)}" +
    "#onebox-root .fbslot{position:relative;min-height:400px}" +
    "#onebox-root .fbslot::before{content:'';position:absolute;top:56px;left:50%;margin-left:-14px;width:28px;height:28px;border:3px solid #e4e7e9;border-top-color:var(--teal);border-radius:50%;animation:ob-spin .8s linear infinite}" +
    "#onebox-root .fbslot::after{content:'Loading secure checkout\u2026';position:absolute;top:98px;left:0;right:0;text-align:center;font-family:var(--form);font-size:12.5px;color:var(--muted)}" +
    "#onebox-root .fbslot>*{position:relative;z-index:1}" +
    "#onebox-root .bar{background:var(--ink);display:flex;justify-content:space-between;align-items:center;padding:13px 22px;gap:12px}" +
    "#onebox-root .bar button{background:none;border:0;color:#fff;font-family:var(--form);font-size:13px;font-weight:600;letter-spacing:.08em;cursor:pointer;padding:6px 8px;border-radius:6px;opacity:.92;transition:opacity .15s,background .15s}" +
    "#onebox-root .bar button:hover:not(:disabled){opacity:1;background:rgba(255,255,255,.09)}" +
    "#onebox-root .bar button[hidden]{visibility:hidden;display:block}" +
    "#onebox-root .phead{font-family:var(--headline);font-weight:700;font-size:17px;line-height:1.3;text-align:center;text-wrap:balance;margin:0 0 4px;color:#000}" +
    "#onebox-root .pheadoffer{display:block;margin-top:2px;color:#12b9b9;font-size:19px}" +
    "#onebox-root .psub{text-align:center;font-family:var(--content);font-size:13px;color:var(--muted);margin:0 0 14px}" +
    "#onebox-root .cal-nav{display:flex;align-items:center;justify-content:center;gap:16px;margin:2px 0 10px}" +
    "#onebox-root .cal-nav button{width:29px;height:29px;border-radius:50%;border:0;background:#eef7f7;color:var(--teal-deep);font-size:16px;line-height:1;cursor:pointer}" +
    "#onebox-root .cal-nav button:hover:not(:disabled){background:#dcf0f0}" +
    "#onebox-root .cal-nav button:disabled{opacity:.35;cursor:default}" +
    "#onebox-root .cal-nav strong{font-size:14px;font-weight:600;min-width:8.5em;text-align:center;font-family:var(--form)}" +
    "#onebox-root .obgrid{display:grid;grid-template-columns:repeat(7,1fr);gap:3px;text-align:center;max-width:340px;margin:0 auto}" +
    "#onebox-root .obgrid .dow{font-size:10px;color:var(--muted);padding:4px 0;font-weight:600}" +
    "#onebox-root .obgrid button{aspect-ratio:1;border:0;background:#f2fbfb;border-radius:50%;font:inherit;font-size:13px;color:var(--teal-deep);font-weight:600;cursor:pointer;font-variant-numeric:tabular-nums}" +
    "#onebox-root .obgrid button:hover:not(:disabled){background:#d8f3f2}" +
    "#onebox-root .obgrid button:disabled{color:#c9ced2;background:none;font-weight:400;cursor:default}" +
    "#onebox-root .obgrid button[aria-pressed=true],#onebox-root .obgrid button[aria-pressed=true]:hover{background:linear-gradient(135deg,#3ed2cb,var(--teal-deep));color:#fff;font-weight:700;box-shadow:0 5px 12px -4px rgba(23,195,195,.65)}" +
    "#onebox-root .obslotwrap{position:relative;margin-top:12px}" +
    "#onebox-root .obslots{display:grid;grid-template-columns:repeat(auto-fill,minmax(96px,1fr));gap:7px;max-height:176px;overflow-y:auto;padding-bottom:6px}" +
    "#onebox-root .obfade{position:absolute;left:0;right:0;bottom:0;height:38px;background:linear-gradient(180deg,rgba(255,255,255,0),#fff 88%);pointer-events:none;opacity:0;transition:opacity .2s}" +
    "#onebox-root .obslotwrap.can .obfade{opacity:1}" +
    "#onebox-root .obmore{margin:4px 0 0;text-align:center;font-size:14.5px;font-weight:600;color:var(--teal-deep);font-family:var(--form)}" +
    "#onebox-root .obslots button{padding:12px 4px;border:1px solid var(--line);border-radius:10px;background:#fff;font:inherit;font-size:13.5px;color:var(--ink);font-weight:600;cursor:pointer;font-variant-numeric:tabular-nums;transition:border-color .15s,background .15s,box-shadow .15s;box-shadow:0 3px 8px -6px rgba(17,19,21,.18)}" +
    "#onebox-root .obslots button:hover:not(:disabled){border-color:var(--teal);background:#f2fbfb}" +
    "#onebox-root .obslots button.sel,#onebox-root .obslots button.sel:hover{background:linear-gradient(100deg,#3ed2cb,var(--teal) 55%,var(--teal-deep));color:#fff;border-color:transparent;box-shadow:0 8px 18px -8px rgba(23,195,195,.65)}" +
    "#onebox-root .obreserve{margin:14px auto 0;max-width:340px}" +
    "#onebox-root .obslots button:disabled{opacity:.5;cursor:wait}" +
    "#onebox-root .obslots p{margin:0;font-size:13px;color:var(--muted);text-align:center;padding:16px 0;grid-column:1/-1}" +
    "#onebox-root .obcal-note{text-align:center;font-size:12px;color:var(--muted);margin:10px 0 0;font-family:var(--form);min-height:1.2em}" +
    "#onebox-root .depmeta{border:1.5px solid var(--teal);background:#f2fbfb;border-radius:7px;padding:6px 10px;text-align:center;margin:0 0 7px;font-family:var(--content)}" +
    "#onebox-root .depwhen{margin:0;font-size:14.5px;font-weight:700;color:var(--teal-deep);line-height:1.35}" +
    "#onebox-root .deprow{display:flex;align-items:center;justify-content:center;gap:9px;flex-wrap:wrap;margin:0 0 10px;font-family:var(--form);font-size:17px}" +
    "#onebox-root .depsafe{background:var(--mint-bg);border:1px solid var(--mint-line);border-radius:7px;padding:7px 10px;text-align:center;margin:0 0 7px;font-family:var(--content)}" +
    "#onebox-root .depsafe strong{display:block;color:var(--mint-ink);font-size:14px;font-family:var(--headline);line-height:1.3}" +
    "#onebox-root .depsafe p{margin:2px 0 0;font-size:12.5px;color:#2c5c39;line-height:1.4}" +
    "#onebox-root .dephold{color:var(--ink-soft);font-weight:600}" +
    "#onebox-root .dephold b{font-variant-numeric:tabular-nums;font-weight:800;font-size:17px;letter-spacing:-.01em;color:var(--ink)}" +
    "#onebox-root .dephead{font-size:15.5px;margin:0 0 7px}" +
    "@media(min-width:768px){#onebox-root .dephead{font-size:19px}}" +
    "#onebox-root .fbslot{min-height:400px}" +
    "#onebox-root .done{text-align:center;padding:6px 0}" +
    "#onebox-root .done .tick{width:58px;height:58px;border-radius:50%;background:var(--mint-bg);border:1px solid var(--mint-line);color:var(--mint-ink);display:grid;place-items:center;margin:0 auto 14px;font-size:26px}" +
    "#onebox-root .done strong{font-family:var(--headline);font-size:17px}" +
    "#onebox-root .done p{font-family:var(--content);font-size:13.5px;color:var(--ink-soft)}" +
    "#onebox-root .xsec{margin-top:38px}" +
    "#onebox-root .xhead{font-family:var(--headline);font-weight:700;font-size:clamp(18px,2.6vw,22px);line-height:1.25;text-align:center;text-wrap:balance;margin:0 0 16px;color:#000}" +
    "#onebox-root .igcard{max-width:640px;margin:0 auto;border:1px solid var(--line);border-radius:12px;overflow:hidden;background:#fff;box-shadow:0 8px 20px -12px rgba(17,19,21,.25)}" +
    "#onebox-root .ighead{display:flex;align-items:center;gap:11px;padding:11px 14px;border-bottom:1px solid var(--line)}" +
    "#onebox-root .ighead .avatar{width:38px;height:38px;border-radius:50%;padding:2px;flex:none;background:radial-gradient(circle at 30% 110%,#fdf497 0%,#fd5949 45%,#d6249f 60%,#285AEB 90%)}" +
    "#onebox-root .ighead .avatar img{width:100%;height:100%;border-radius:50%;object-fit:cover;display:block;background:#fff;border:2px solid #fff}" +
    "#onebox-root .ighead .who{flex:1;min-width:0}" +
    "#onebox-root .ighead .who b{display:block;font-family:var(--form);font-size:13.5px}" +
    "#onebox-root .ighead .who span{font-family:var(--form);font-size:11.5px;color:var(--muted)}" +
    "#onebox-root .ighead a{flex:none;padding:7px 16px;border-radius:8px;background:#0095f6;color:#fff;text-decoration:none;font-family:var(--form);font-size:12.5px;font-weight:600}" +
    "#onebox-root .results{display:grid;grid-template-columns:repeat(3,1fr);gap:3px}" +
    "#onebox-root .results img{width:100%;height:100%;aspect-ratio:4/5;object-fit:cover;display:block}" +
    "#onebox-root .mapcard{max-width:640px;margin:0 auto;border:1px solid var(--line);border-radius:12px;overflow:hidden;box-shadow:0 8px 20px -12px rgba(17,19,21,.25)}" +
    "#onebox-root .mapcard iframe{width:100%;height:280px;border:0;display:block}" +
    "#onebox-root .faqs{max-width:640px;margin:0 auto}" +
    "#onebox-root .faqs details{border-bottom:1px solid var(--line)}" +
    "#onebox-root .faqs summary{cursor:pointer;list-style:none;display:flex;justify-content:space-between;align-items:center;gap:12px;padding:14px 2px;font-family:var(--form);font-size:14.5px;font-weight:600}" +
    "#onebox-root .faqs summary::-webkit-details-marker{display:none}" +
    "#onebox-root .faqs summary::after{content:'+';font-size:18px;color:var(--muted);flex:none}" +
    "#onebox-root .faqs details[open] summary::after{content:'\\2212'}" +
    "#onebox-root .faqs .fa{margin:0;padding:0 2px 15px;font-family:var(--content);font-size:13.5px;line-height:1.6;color:var(--ink-soft)}" +
    "#onebox-root .studio{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:6px;max-width:640px;margin:10px auto 0}" +
    "#onebox-root .results.solo{max-width:640px;margin:0 auto;border-radius:12px;overflow:hidden}" +
    "#onebox-root .igwrap{margin-top:14px}" +
    /* Elfsight IG header: put the Follow button beside the stats row
       (their CSS stacks the header as a column) to save a scroll. */
    "#onebox-root .eapps-instagram-feed-header-inner{display:flex!important;flex-direction:row!important;flex-wrap:wrap!important;align-items:center;justify-content:center;column-gap:12px;row-gap:6px}" +
    "#onebox-root .eapps-instagram-feed-header-inner > :first-child{flex-basis:100%}" +
    "#onebox-root .eapps-instagram-feed-header-stats{margin:0!important;flex:0 1 auto;min-width:0}" +
    "#onebox-root .eapps-instagram-feed-header-follow-button-wrapper{margin:0!important;flex:0 0 auto}" +
    "#onebox-root .doneburst{font-size:54px;text-align:center;margin:2px 0 4px;line-height:1;animation:obpop .45s cubic-bezier(.2,1.6,.4,1) both}" +
    "@keyframes obpop{0%{transform:scale(.3);opacity:0}100%{transform:scale(1);opacity:1}}" +
    "#onebox-root .donehead{font-size:clamp(22px,4vw,27px);color:var(--teal-deep)}" +
    "#onebox-root .donesub{text-align:center;font-family:var(--form);font-size:14.5px;color:var(--ink-soft);margin:6px 0 14px}" +
    "#onebox-root .donecard{border-color:var(--teal);background:#f0fbfa;box-shadow:0 10px 24px -14px rgba(18,181,176,.55)}" +
    "#onebox-root .donecard h3{color:var(--teal-deep)}" +
    "#onebox-root .donecard .confwhen{font-size:18px}" +
    "#onebox-root .donefollow{display:block;text-align:center;margin:16px auto 0;max-width:340px;padding:12px 18px;border-radius:12px;color:#fff;font-family:var(--form);font-weight:700;font-size:14.5px;text-decoration:none;background:linear-gradient(45deg,#f09433,#e6683c,#dc2743,#cc2366,#bc1888);box-shadow:0 8px 18px -10px rgba(204,35,102,.6)}" +
    "#onebox-root .donenote{text-align:center;font-family:var(--form);font-size:13.5px;color:var(--ink-soft);margin:14px 0 0}" +
    "#onebox-root .confetti{position:absolute;left:0;right:0;top:0;height:0;pointer-events:none}" +
    "#onebox-root .confetti i{position:absolute;top:-14px;width:8px;height:14px;border-radius:2px;opacity:0;animation-name:obfall;animation-timing-function:linear;animation-fill-mode:forwards}" +
    "@keyframes obfall{0%{transform:translateY(0) rotate(0);opacity:1}100%{transform:translateY(72vh) rotate(560deg);opacity:0}}" +
    "@media(prefers-reduced-motion:reduce){#onebox-root .confetti{display:none}#onebox-root .doneburst{animation:none}}" +
    "#onebox-root .slide{position:relative}" +
    "#onebox-root .studio img{width:100%;display:block;border-radius:10px}" +
    "#onebox-root .vidbox{position:relative;cursor:pointer;margin:0 2px 14px;border-radius:10px;overflow:hidden;background:#000}" +
    "#onebox-root .vidbox img{width:100%;display:block;opacity:.92}" +
    "#onebox-root .vplay{position:absolute;top:50%;left:50%;transform:translate(-50%,-50%);width:54px;height:54px;border-radius:50%;background:rgba(0,0,0,.55);color:#fff;display:flex;align-items:center;justify-content:center;font-size:20px;padding-left:4px}" +
    "#onebox-root .vidplayer{width:100%;display:block;border-radius:10px;margin:0 2px 14px}" +
    "#onebox-root .contactblock{text-align:center;padding:30px 20px 34px;border-top:1px solid var(--line)}" +
    "#onebox-root .contactblock img{max-height:70px;width:auto;margin:0 auto 12px;display:block}" +
    "#onebox-root .contactblock p{margin:2px 0;font-family:var(--headline);font-weight:700;font-size:16px;color:#000}" +
    "#onebox-root .footer{background:var(--footer);color:#c6cacd;text-align:center;padding:26px 20px;font-size:13px}";
  var st = document.createElement("style");
  st.textContent = css;
  document.head.appendChild(st);

  function esc(s) {
    return String(s).replace(/[&<>"]/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c];
    });
  }

  var QUESTIONS = [
    { k: "area", q: "Which Area(s) Would You Like Treated?", o: ["Lips", "Eyebrows"] },
    { k: "had_pmu", q: "Have You Ever Had Permanent Makeup Before?", o: ["Yes", "No"] },
    { k: "age", q: "What Age Group Are You In?", o: ["18-24", "24-30", "30-36", "36-42", "42-54", "54-65", "65+"] },
    { k: "commute", q: "Our Address is " + ADDR + ". Is This commutable for you?", o: ["Yes", "No"] },
    { k: "serious", q: "On A Scale From 1-10 How Serious Are You About Getting This Treatment?", o: ["0-2", "3-6", "7-9", "10 I Want This Treatment!"] },
    { k: "aftercare", q: "Would you like a FREE Aftercare Kit?", o: ["Yes", "No"] },
    { k: "full_name", q: "Full Name", type: "text", ph: "Full Name" },
    { k: "phone", q: "Phone Number", type: "tel", ph: "Phone Number" },
    { k: "email", q: "Email Address", type: "email", ph: "Email Address" }
  ];
  var N = QUESTIONS.length;
  var state = { eventIds: {}, answers: {}, submitted: false };
  var qi = 0, phase = "survey";

  /* -- lead submission ------------------------------------------------
     Sends the finished survey into GHL so the contact is created and the
     sub-account's automations fire. Endpoint + payload are confirmed
     during the Ivan pilot (captured from the live survey's own submit);
     until then failures are logged, never shown to the lead.            */
  function sendLead(stage) {
    var a = state.answers;
    var payload = {
      stage: stage,
      slug: C.slug || "",
      experimentId: C.experimentId || "",
      variantKey: C.variantKey || "",
      eventId: state.eventIds.Lead || "",
      fbp: cookie("_fbp"),
      fbc: cookie("_fbc"),
      pageUrl: location.href,
      surveyId: C.surveyId || "",
      locationId: C.locationId || "",
      full_name: a.full_name || "",
      phone: a.phone || "",
      email: a.email || "",
      area: a.area || "",
      had_pmu: a.had_pmu || "",
      age: a.age || "",
      commutable: a.commute || "",
      seriousness: a.serious || "",
      aftercare_kit: a.aftercare || "",
      source: "onebox"
    };
    try {
      var url = C.submitUrl || "";
      if (!url) { console.warn("[onebox] no submitUrl configured; lead:", payload); return; }
      payload.email = a.email || "";
      fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
        keepalive: true
      }).catch(function (e) { console.warn("[onebox] submit failed", e); });
    } catch (e) { console.warn("[onebox] submit failed", e); }
  }

  function submitLead() {
    if (state.submitted) return;
    state.submitted = true;
    pixelTrack("Lead");
    sendLead("complete");
  }
  function partialLead() {
    if (state.partialSent || state.submitted) return;
    state.partialSent = true;
    sendLead("partial");
  }

  /* ------------------------------------------------------------------ */
  root.innerHTML =
    '<div class="topbar"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 2a7 7 0 0 0-7 7c0 5.25 7 13 7 13s7-7.75 7-13a7 7 0 0 0-7-7zm0 9.5A2.5 2.5 0 1 1 12 6.5a2.5 2.5 0 0 1 0 5z"/></svg><span>' + esc(ADDR) + "</span></div>" +
    '<div class="callbar">Call Us Today:' + (PHONE ? " " + esc(PHONE) : "") + "</div>" +
    '<div class="wrap">' +
    (LOGO ? '<img class="biglogo" src="' + esc(LOGO) + '" alt="' + esc(BIZ) + ' logo">' : "") +
    '<div class="trust"><p>Trusted by 5,600+ Happy Clients</p><div class="stars">&#9733;&#9733;&#9733;&#9733;&#9733;</div></div>' +
    '<p class="lede">' + (C.congrats ? esc(C.congrats)
      : "Congrats on claiming " + (OFFERR ? esc(OFFERR) + " " : "") + "All Permanent Makeup Packages!") + "</p>" +
    '<h1 class="page">' + esc(C.headline || "Fill Out Our Quiz To See If You Qualify") + "</h1>" +
    '<p class="sub">' + esc(C.sub || "(30 Seconds)") + "</p>" +
    '<div class="box"><div class="rail"><span id="ob-rail">&nbsp;</span></div>' +
    '<div class="slide" id="ob-slide"></div></div>' +
    '<div id="ob-extras"></div>' +
    "</div>" +
    '<div class="contactblock">' +
    (LOGO ? '<img src="' + esc(LOGO) + '" alt="">' : "") +
    (PHONE ? "<p>" + esc(PHONE) + "</p>" : "") +
    (ADDR ? "<p>" + esc(ADDR) + "</p>" : "") +
    "</div>" +
    '<div class="footer">&copy; ' + new Date().getFullYear() + " " + esc(BIZ) + ". All Rights Reserved.</div>";

  var railEl = document.getElementById("ob-rail");
  var slideEl = document.getElementById("ob-slide");
  var boxEl = root.querySelector(".box");
  /* FAQ videos are click-to-play: a poster + play button until tapped, so
     six mp4s never weigh down the page load. */
  /* Keep visitors in the funnel: any Instagram-bound link in the widget
     (Follow button, username, post tiles, the post lightbox — which can
     mount on <body>) stays visible but never navigates away. Elfsight's
     own popup-open handler still runs, so posts keep opening in the
     lightbox. Bound on document so the portaled popup is covered too. */
  document.addEventListener("click", function (e) {
    if (phase === "done") return; // paid — following on Instagram is welcome now
    var a = e.target && e.target.closest
      ? e.target.closest('a[class*="eapps-"][href*="instagram.com"], [class*="eapps-"] a[href*="instagram.com"], [class*="es-popup"] a[href*="instagram.com"]')
      : null;
    if (a) e.preventDefault();
  }, true);

  document.getElementById("ob-extras").addEventListener("click", function (e) {
    var t = e.target;
    while (t && t !== document && !(t.className && String(t.className).indexOf("vidbox") > -1)) t = t.parentNode;
    if (!t || t === document) return;
    var v = document.createElement("video");
    v.className = "vidplayer";
    v.controls = true; v.autoplay = true; v.playsInline = true; v.preload = "metadata";
    v.src = t.getAttribute("data-v");
    t.parentNode.replaceChild(v, t);
  });
  var firstShow = true;
  var interacted = false;
  root.addEventListener("pointerdown", function () { interacted = true; }, { passive: true });
  root.addEventListener("keydown", function () { interacted = true; });
  function focusBox() {
    try {
      var tall = phase === "deposit" || phase === "booking" ||
        boxEl.getBoundingClientRect().height >= window.innerHeight - 40;
      /* "Reduce Motion" turns smooth scrolling into a no-op, which would
         drop the focus behaviour entirely — jump instantly instead. */
      var reduce = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
      boxEl.scrollIntoView({ behavior: reduce ? "auto" : "smooth", block: tall ? "start" : "end" });
    } catch (e) {}
  }

  function rail() {
    var wrap = railEl.parentNode;
    wrap.style.display = phase === "survey" ? "none" : "";
    if (phase === "survey") return;
    var pct, label;
    if (phase === "booking") { pct = 85; label = "You’re Almost Done…"; }
    else if (phase === "confirm") { pct = 88; label = "You\u2019re Almost Done\u2026"; }
    else if (phase === "deposit") { pct = 90; label = "Last Step…"; }
    else if (phase === "done") { pct = 100; label = "Confirmed ✓"; }
    else { pct = 100; label = "100%"; }
    railEl.style.width = pct + "%";
    railEl.textContent = label;
  }

  function slideSurvey() {
    var q = QUESTIONS[qi];
    var back = qi > 0 ? '<button type="button" class="backlink" id="ob-prev">&larr; Back</button>' : "";
    if (q.type) {
      var extra = q.k === "full_name"
        ? ' autocapitalize="words" autocorrect="off" spellcheck="false" enterkeyhint="next"'
        : q.k === "phone" ? ' inputmode="tel" enterkeyhint="next"'
        : ' autocapitalize="none" spellcheck="false" enterkeyhint="done"';
      var note = (q.k === "phone" || q.k === "email")
        ? '<p class="trustnote">&#128274; Only used to confirm your appointment &mdash; no spam.</p>' : "";
      var submitBtn = qi === N - 1
        ? '<button type="button" class="confyes" id="ob-submit" style="margin-top:16px"><b>See My Available Times</b>' +
          "<span>Next: pick your appointment</span></button>"
        : '<button type="button" class="confyes" id="ob-submit" style="margin-top:16px"><b>Continue &rarr;</b></button>';
      return '<label class="qlabel" for="ob-f">' + esc(q.q) + '\u00A0<em>*</em></label>' +
        '<input class="field" id="ob-f" type="' + q.type + '" placeholder="' + esc(q.ph) + '" value="' +
        esc(state.answers[q.k] || "") + '" autocomplete="' + (q.k === "phone" ? "tel" : q.k === "email" ? "email" : "name") + '"' +
        extra + '><p class="err" id="ob-err"></p>' + note + submitBtn + back;
    }
    return '<p class="qlabel">' + esc(q.q) + '\u00A0<em>*</em></p><div class="opts">' +
      q.o.map(function (o) {
        return '<label class="opt"><input type="radio" name="ob-o" value="' + esc(o) + '"' +
          (state.answers[q.k] === o ? " checked" : "") + ">" + esc(o) + "</label>";
      }).join("") + '</div><p class="err" id="ob-err"></p>' + back;
  }

  /* Native date & time picker fed by the calendar's real availability
     (our /api/onebox/slots proxy of GHL free-slots). Picking a time books
     the appointment server-side with the survey's data — no extra form —
     and only a confirmed booking advances to the deposit step. */
  var calState = { y: 0, m: 0, day: null, dates: {}, loading: false, error: "", booking: false };

  function monthKeyDates() {
    var out = [];
    for (var k in calState.dates) if (calState.dates[k] && calState.dates[k].length) out.push(k);
    return out;
  }

  function slideBooking() {
    if (!calState.y) {
      var n = new Date();
      calState.y = n.getFullYear(); calState.m = n.getMonth();
    }
    return '<h2 class="phead">' + (C.bookingHead ? esc(C.bookingHead) : OFFERR
      ? 'Book Your Appointment NOW<br><span class="pheadoffer">to Claim ' + esc(OFFERR) + "</span>"
      : "Book Your Appointment NOW!") + "</h2>" +
      '<div id="ob-calbox">' + calHTML() + "</div>" +
      '<button type="button" class="backlink" id="ob-prev">&larr; Back</button>';
  }

  var MONTHS = ["January","February","March","April","May","June","July","August","September","October","November","December"];

  function pad2(n) { return (n < 10 ? "0" : "") + n; }

  function calHTML() {
    if (calState.loading) return '<div class="skel"><div></div><div></div><div></div></div>' +
      '<p class="obcal-note">Finding open times&hellip;</p>';
    if (calState.error) {
      return '<p class="obcal-note">' + esc(calState.error) + '</p>' +
        '<div class="cal-nav"><button type="button" id="ob-retry" style="width:auto;padding:0 14px;border-radius:8px">Try again</button></div>';
    }
    var y = calState.y, m = calState.m;
    var first = new Date(y, m, 1).getDay();
    var days = new Date(y, m + 1, 0).getDate();
    var cells = "";
    ["Sun","Mon","Tue","Wed","Thu","Fri","Sat"].forEach(function (d) { cells += '<div class="dow">' + d + "</div>"; });
    for (var i = 0; i < first; i++) cells += "<div></div>";
    for (var d = 1; d <= days; d++) {
      var key = y + "-" + pad2(m + 1) + "-" + pad2(d);
      var has = calState.dates[key] && calState.dates[key].length;
      cells += '<button type="button" data-day="' + key + '"' + (has ? "" : " disabled") +
        ' aria-pressed="' + (calState.day === key) + '">' + d + "</button>";
    }
    var slots = "";
    if (calState.day && calState.dates[calState.day]) {
      slots = calState.dates[calState.day].map(function (iso) {
        return '<button type="button" data-slot="' + esc(iso) + '" class="' +
          (calState.selIso === iso ? "sel" : "") + '">' + fmtTime(iso) + "</button>";
      }).join("");
    } else {
      slots = "<p>Pick a day to see open times.</p>";
    }
    return '<div class="cal-nav">' +
        '<button type="button" id="ob-pm" aria-label="Previous month">&lsaquo;</button>' +
        "<strong>" + MONTHS[m] + " " + y + "</strong>" +
        '<button type="button" id="ob-nm" aria-label="Next month">&rsaquo;</button>' +
      "</div>" +
      '<div class="obgrid" id="ob-grid">' + cells + "</div>" +
      '<div class="obslotwrap"><div class="obslots" id="ob-slots">' + slots + '</div><div class="obfade"></div></div>' +
      '<p class="obmore" id="ob-more">&darr; Scroll for more times</p>' +
      '<p class="obcal-note" id="ob-note"></p>';
  }

  var DAYS = ["Sunday","Monday","Tuesday","Wednesday","Thursday","Friday","Saturday"];
  function fmtWhen(iso) {
    var y = +iso.slice(0, 4), m = +iso.slice(5, 7), d = +iso.slice(8, 10);
    var wd = DAYS[new Date(y, m - 1, d).getDay()];
    return wd + ", " + MONTHS[m - 1] + " " + d + " at " + fmtTime(iso);
  }

  function fmtTime(iso) {
    /* The ISO string is already in the calendar's own timezone — read the
       wall-clock time straight from it. */
    var hh = parseInt(iso.slice(11, 13), 10), mm = iso.slice(14, 16);
    var ap = hh >= 12 ? "PM" : "AM";
    hh = hh % 12 || 12;
    return hh + ":" + mm + " " + ap;
  }

  function paintCal() {
    var box = document.getElementById("ob-calbox");
    if (!box) return;
    box.innerHTML = calHTML();
    bindCal();
  }

  function loadMonth() {
    var y = calState.y, m = calState.m;
    var start = new Date(y, m, 1).getTime();
    var now = Date.now();
    if (start < now) start = now;
    var end = new Date(y, m + 1, 1).getTime();
    calState.loading = true; calState.error = ""; calState.day = null; calState.dates = {}; calState.selIso = null;
    paintCal();
    fetch((C.submitUrl || "").replace(/submit$/, "slots") + "?slug=" + encodeURIComponent(C.slug || "") +
      "&start=" + start + "&end=" + end)
      .then(function (r) { return r.json(); })
      .then(function (j) {
        calState.loading = false;
        if (!j.ok) { calState.error = "Couldn’t load available times."; }
        else {
          calState.dates = j.dates || {};
          var ks = monthKeyDates().sort();
          calState.day = ks.length ? ks[0] : null;
        }
        paintCal();
      })
      .catch(function () {
        calState.loading = false;
        calState.error = "Couldn’t load available times.";
        paintCal();
      });
  }

  function bindCal() {
    var pm = document.getElementById("ob-pm"), nm = document.getElementById("ob-nm");
    if (pm) pm.onclick = function () {
      calState.m--; if (calState.m < 0) { calState.m = 11; calState.y--; }
      loadMonth();
    };
    if (nm) nm.onclick = function () {
      calState.m++; if (calState.m > 11) { calState.m = 0; calState.y++; }
      loadMonth();
    };
    var retry = document.getElementById("ob-retry");
    if (retry) retry.onclick = loadMonth;
    var grid = document.getElementById("ob-grid");
    if (grid) grid.onclick = function (e) {
      var b = e.target.closest("button[data-day]");
      if (!b || b.disabled) return;
      calState.day = b.getAttribute("data-day");
      calState.selIso = null;
      paintCal();
    };
    var slots = document.getElementById("ob-slots");
    if (slots) slots.onclick = function (e) {
      var b = e.target.closest("button[data-slot]");
      if (!b || calState.booking) return;
      calState.selIso = b.getAttribute("data-slot");
      paintCal();
      // straight to the confirm step — no extra Reserve tap
      setTimeout(function () {
        if (calState.booking || !calState.selIso) return;
        state.pendingIso = calState.selIso;
        show("confirm");
      }, 250);
    };
    var more = document.getElementById("ob-more");
    var se = document.getElementById("ob-slots");
    if (more && se) {
      var can = se.scrollHeight > se.clientHeight + 4;
      more.style.display = can ? "" : "none";
      se.parentNode.classList.toggle("can", can);
      se.onscroll = function () {
        se.parentNode.classList.toggle("can", se.scrollTop + se.clientHeight < se.scrollHeight - 6);
      };
    }
  }

  function relDay(iso) {
    var y = +iso.slice(0, 4), m = +iso.slice(5, 7), d = +iso.slice(8, 10);
    var t = new Date(); t.setHours(0, 0, 0, 0);
    var diff = Math.round((new Date(y, m - 1, d) - t) / 86400000);
    if (diff <= 0) return "Today";
    if (diff === 1) return "Tomorrow";
    return "In " + diff + " days";
  }

  function slideConfirm() {
    var first = (state.answers.full_name || "").split(/\s+/)[0] || "Hey";
    return '<p class="vlabel">Your spot is saved for:</p>' +
      '<div class="chips" id="ob-vclock"></div>' +
      '<div class="confcard">' +
        "<h3>" + esc(first) + ", please confirm your appointment</h3>" +
        "<p>We&rsquo;ll set this time aside exclusively for you and prepare in advance &mdash; please confirm you can attend:</p>" +
        '<p class="confwhen">' + esc(fmtWhen(state.pendingIso)) + "</p>" +
        '<p class="confrel">' + esc(relDay(state.pendingIso)) + "</p>" +
        (ADDR ? '<p class="confaddr">' + esc(ADDR) + "</p>" : "") +
      "</div>" +
      '<button type="button" class="confyes" id="ob-yes"><b>Yes, I&rsquo;ll be there</b>' +
      "<span>Continue to securing my appointment</span></button>" +
      '<button type="button" class="confalt" id="ob-alt">Choose a different time</button>';
  }

  /* Choosing a time books nothing yet. The appointment is created once,
     already confirmed, only after the deposit clears (see OB_ONPAID) —
     unconfirmed holds on the calendar were confusing the clients. */
  function book(iso) {
    state.slotIso = iso;
    pixelTrack("Schedule");
    try {
      fetch(C.submitUrl || "", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        keepalive: true,
        body: JSON.stringify({
          stage: "slot",
          slug: C.slug || "",
          full_name: state.answers.full_name || "",
          phone: state.answers.phone || "",
          slotIso: iso,
        }),
      }).catch(function () {});
    } catch (e) {}
    show("deposit");
  }

  /* The Fanbasis block ships inert in a <template> — booting it at page
     load and moving it later reloads the iframe and kills its one-time
     checkout session (symptom: endless 'Loading secure checkout').
     Instead the block is instantiated fresh, scripts and all, the moment
     the deposit step opens — same lifecycle as on a GHL page. */
  function bootFanbasis(slot) {
    if (!slot || state.fbBooted) return;
    var tpl = document.getElementById("onebox-fanbasis-holder");
    if (!tpl || !tpl.content) {
      /* No checkout is configured for this funnel (no product id and no
         pasted block) — an honest message beats an endless spinner. */
      slot.innerHTML = '<div style="text-align:center;padding:30px 16px;font-family:sans-serif">' +
        '<p style="margin:0 0 6px;font-weight:700">We couldn\u2019t load the secure checkout.</p>' +
        '<p style="margin:0;color:#667">Please refresh the page' +
        (C.phone ? ' \u2014 or call us at <b>' + esc(C.phone) + '</b> and we\u2019ll reserve your spot' : '') +
        ".</p></div>";
      state.fbBooted = true;
      return;
    }
    state.fbBooted = true;
    window.OB_LEAD = { name: state.answers.full_name || "", email: state.answers.email || "" };
    /* Fallback landing when no external thank-you page is configured:
       the checkout's success handler calls this to show the in-funnel
       confirmation step (date, time, address). */
    window.OB_DONE = function () { show("done", "next"); window.scrollTo(0, 0); };
    /* The checkout calls this the moment the deposit clears — that's when
       the appointment goes from held to confirmed. */
    window.OB_ONPAID = function () {
      if (state.paidSent || !state.slotIso) return;
      state.paidSent = true;
      // The deposit cleared — tell Meta, so campaigns can optimise for
      // clients who actually pay, not just form fills.
      var amt = parseFloat(String(C.deposit || "").replace(/[^0-9.]/g, ""));
      var purchaseId = pixelTrack("Purchase", { value: isNaN(amt) ? 0 : amt, currency: "USD" });
      try {
        fetch((C.submitUrl || "").replace(/submit$/, "book"), {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          keepalive: true,
          body: JSON.stringify({
            slug: C.slug || "",
            full_name: state.answers.full_name || "",
            phone: state.answers.phone || "",
            email: state.answers.email || "",
            startTime: state.slotIso,
            eventId: purchaseId,
            fbp: cookie("_fbp"),
            fbc: cookie("_fbc"),
            pageUrl: location.href,
          }),
        });
      } catch (e) {}
    };
    var nodes = Array.prototype.slice.call(tpl.content.childNodes);
    var scripts = [];
    nodes.forEach(function (n) {
      if (n.tagName === "SCRIPT") scripts.push(n);
      else slot.appendChild(n.cloneNode(true));
    });
    setTimeout(function () {
      if (!slot.querySelector("iframe")) {
        var note = document.createElement("p");
        note.style.cssText = "text-align:center;font-size:12.5px;color:#667;font-family:sans-serif;margin:8px 0 0";
        note.innerHTML = "Still loading\u2026 if it doesn\u2019t appear, refresh the page" +
          (C.phone ? " or call <b>" + esc(C.phone) + "</b>" : "") + ".";
        slot.appendChild(note);
      }
    }, 50000);
    (function runNext(i) {
      if (i >= scripts.length) return;
      var s = document.createElement("script");
      if (scripts[i].src) {
        s.src = scripts[i].src;
        s.onload = function () { runNext(i + 1); };
        s.onerror = function () { runNext(i + 1); };
        slot.appendChild(s);
      } else {
        s.textContent = scripts[i].textContent;
        slot.appendChild(s);
        runNext(i + 1);
      }
    })(0);
  }

  function slideDeposit() {
    return '<h2 class="phead dephead">' + (C.depositHead ? esc(C.depositHead)
      : "Last Step - " + esc(DEPOSIT) + " Refundable Reservation Fee") + "</h2>" +
      (state.slotIso ? '<div class="depmeta"><p class="depwhen">&#128197; ' +
        esc(fmtWhen(state.slotIso)) + "</p></div>" : "") +
      '<div class="depsafe">' +
        '<strong>&#10004; 100% Guaranteed &mdash; Fully Refundable</strong>' +
        "<p>After your free consultation, we&rsquo;ll apply your fee to your service &mdash; or refund it in full. Either way, you&rsquo;re 100% covered.</p>" +
      "</div>" +
      '<p class="vlabel">&#9203; Your spot is held for:</p>' +
      '<div class="chips" id="ob-clock"></div>' +
      '<div class="fbslot" id="ob-fbslot"></div>' +
      '<button type="button" class="backlink" id="ob-prev">&larr; Back</button>';
  }

  /* In-funnel thank-you step, shown after the deposit clears when the
     funnel has no external thank-you page configured. */
  function confettiHtml() {
    var colors = ["#12b5b0", "#ffd166", "#ef476f", "#06d6a0", "#118ab2", "#f4a261"];
    var out = "";
    for (var i = 0; i < 22; i++) {
      out += '<i style="left:' + (2 + i * 4.4) + "%;background:" + colors[i % 6] +
        ";animation-delay:" + ((i % 7) * 0.22).toFixed(2) + "s;animation-duration:" +
        (2.4 + (i % 5) * 0.45).toFixed(2) + 's"></i>';
    }
    return '<div class="confetti" aria-hidden="true">' + out + "</div>";
  }
  function slideDone() {
    var first = (state.answers.full_name || "").split(/\s+/)[0] || "";
    return confettiHtml() +
      '<div class="doneburst">&#127881;</div>' +
      '<h2 class="phead donehead">' + (first ? esc(first) + ", you" : "You") + "&rsquo;re booked!</h2>" +
      '<p class="donesub">Get excited &mdash; your transformation is officially on the calendar.</p>' +
      '<div class="confcard donecard">' +
        "<h3>&#10004; Your appointment is confirmed</h3>" +
        (state.slotIso ? '<p class="confwhen">' + esc(fmtWhen(state.slotIso)) + "</p>" +
          '<p class="confrel">' + esc(relDay(state.slotIso)) + "</p>" : "") +
        (ADDR ? '<p class="confaddr">&#128205; ' + esc(ADDR) + "</p>" : "") +
        "<p>Your " + esc(DEPOSIT) + " reservation fee is fully refundable &mdash; we&rsquo;ll apply it to your service at your visit.</p>" +
      "</div>" +
      ((C.igWidget || C.elfsightId) && IGLINK ? '<a class="donefollow" href="' + esc(IGLINK) + '" target="_blank" rel="noopener">' +
        "&#128248; Follow us on Instagram for daily results</a>" : "") +
      '<p class="donenote">We&rsquo;ll be in touch shortly to prepare everything for your visit. Keep an eye on your phone! &#128241;</p>';
  }

  /* One continuous hold countdown: starts on the confirmation screen and
     keeps running into the deposit step, so the timers always agree. */
  var holdTimer = null, holdLeft = 600;
  function paintHold() {
    var hh = Math.floor(holdLeft / 3600), mm = Math.floor((holdLeft % 3600) / 60), ss = holdLeft % 60;
    function two(n) { return (n < 10 ? "0" : "") + n; }
    var chips = "<div><b>" + two(hh) + "</b><span>hours</span></div><div><b>" + two(mm) +
      "</b><span>minutes</span></div><div><b>" + two(ss) + "</b><span>seconds</span></div>";
    var v = document.getElementById("ob-vclock");
    if (v) v.innerHTML = chips;
    var c = document.getElementById("ob-clock");
    if (c) c.innerHTML = chips;
    var mini = document.getElementById("ob-clock-mini");
    if (mini) mini.textContent = (hh ? two(hh) + ":" : "") + two(mm) + ":" + two(ss);
  }
  function ensureHold(reset) {
    if (reset || holdLeft <= 0) holdLeft = 600;
    paintHold();
    if (holdTimer) return;
    holdTimer = setInterval(function () {
      holdLeft--; if (holdLeft <= 0) { holdLeft = 0; clearInterval(holdTimer); holdTimer = null; }
      paintHold();
    }, 1000);
  }
  function stopHold() {
    if (holdTimer) { clearInterval(holdTimer); holdTimer = null; }
  }

  function show(p, dir) {
    var oldWrap = slideEl.querySelector(C.fanbasisSelector || "#fanbasis-checkout-wrapper");
    if (oldWrap) { oldWrap.remove(); state.fbBooted = false; }
    phase = p;
    if (phase === "survey" || phase === "booking" || phase === "done") stopHold();
    slideEl.className = "slide";
    void slideEl.offsetWidth;
    slideEl.classList.add(dir === "prev" ? "anim-prev" : "anim-next");
    slideEl.innerHTML = phase === "survey" ? slideSurvey()
      : phase === "booking" ? slideBooking()
      : phase === "confirm" ? slideConfirm()
      : phase === "done" ? slideDone()
      : slideDeposit();

    var prev = document.getElementById("ob-prev");
    if (prev) prev.onclick = function () {
      if (phase === "survey") { if (qi > 0) { qi--; show("survey", "prev"); } }
      else if (phase === "booking") { qi = N - 1; show("survey", "prev"); }
      else if (phase === "deposit") show("confirm", "prev");
      else show("booking", "prev");
    };
    if (phase === "confirm") {
      ensureHold(state.holdFor !== state.pendingIso);
      state.holdFor = state.pendingIso;
      document.getElementById("ob-yes").onclick = function () {
        book(state.pendingIso);
      };
      document.getElementById("ob-alt").onclick = function () { show("booking", "prev"); };
    }

    if (phase === "survey") bindSurvey();
    if (phase === "booking") { bindCal(); if (!calState.loading && !monthKeyDates().length && !calState.error) loadMonth(); }
    if (phase === "deposit") {
      ensureHold(false);
      bootFanbasis(document.getElementById("ob-fbslot"));
    }
    /* Survey-stage copy: hidden from the calendar onward so the booking,
       confirm and deposit steps sit as high as possible. */
    root.classList.toggle("nohero", phase !== "survey");
    if (typeof cta !== "undefined" && cta && phase === "done") cta.classList.remove("on");
    rail(); renderExtras();
    if (firstShow) firstShow = false;
    else if (interacted) { focusBox(); setTimeout(focusBox, 700); }
  }

  function bindSurvey() {
    var advanced = false;
    function advance() {
      if (advanced) return;
      advanced = true;
      if (qi < N - 1) { qi++; show("survey"); }
      else { submitLead(); show("booking"); }
    }
    function submit() {
      var q = QUESTIONS[qi], val;
      if (q.type) val = document.getElementById("ob-f").value.trim();
      else {
        var sel = slideEl.querySelector('input[name="ob-o"]:checked');
        val = sel ? sel.value : "";
      }
      var err = document.getElementById("ob-err");
      var fld = document.getElementById("ob-f");
      function fail(msg) { err.textContent = msg; if (fld) fld.classList.add("err-f"); }
      if (!val) { fail(q.type ? q.q + " is required" : "Please choose an option to continue"); return; }
      if (q.k === "email" && !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(val)) {
        fail("Please enter a valid email address"); return;
      }
      if (q.k === "phone") {
        var digits = val.replace(/\D/g, "");
        if (digits.length === 11 && digits.charAt(0) === "1") digits = digits.slice(1);
        /* Real US number: 10 digits, area code + exchange can't start 0/1 —
           catches "1 + 9 digits" and other missing-digit variants. */
        if (!/^[2-9]\d{2}[2-9]\d{6}$/.test(digits)) {
          fail("Please enter a valid phone number"); return;
        }
      }
      state.answers[q.k] = val;
      if (q.k === "phone") partialLead();
      advance();
    }
    var submitBtn = document.getElementById("ob-submit");
    if (submitBtn) submitBtn.onclick = submit;
    slideEl.querySelectorAll('input[name="ob-o"]').forEach(function (r) {
      r.onclick = function () {
        state.answers[QUESTIONS[qi].k] = r.value;
        setTimeout(advance, 250);
      };
    });
    slideEl.onkeydown = function (e) { if (e.key === "Enter") { e.preventDefault(); submit(); } };
    var f = document.getElementById("ob-f");
    if (f) {
      f.oninput = function () {
        f.classList.remove("err-f");
        document.getElementById("ob-err").textContent = "";
        if (f.type === "tel") {
          var d = f.value.replace(/\D/g, "").slice(0, 11);
          if (d.length === 11 && d.charAt(0) === "1") d = d.slice(1);
          if (d.length > 6) f.value = "(" + d.slice(0, 3) + ") " + d.slice(3, 6) + "-" + d.slice(6);
          else if (d.length > 3) f.value = "(" + d.slice(0, 3) + ") " + d.slice(3);
          else if (d.length > 0) f.value = "(" + d;
        }
      };
      f.focus();
    }
  }

  /* below-the-box sections, phase by phase: the survey step is the quiz
     alone — nothing below the box competes with finishing it. From the
     booking step: results + reviews + studio/map + FAQs with their
     educational videos. The deposit step drops the FAQs so nothing
     competes with the checkout. */
  function renderExtras() {
    var el = document.getElementById("ob-extras");
    if (phase === "survey") { el.innerHTML = ""; return; }
    var IG = C.igWidget || C.elfsightId || "";
    var GOOG = C.googleWidget || "";
    function loadElfsight() {
      if (!document.querySelector('script[src*="elfsightcdn"]')) {
        var es = document.createElement("script");
        es.src = "https://elfsightcdn.com/platform.js"; es.async = true;
        document.head.appendChild(es);
      }
    }
    var htmlStr = "";
    /* Template order: the client's own before/after photos (the 9 CV
       slots) first, the live Instagram widget right under them. */
    if (RESULTS.length || IG) {
      htmlStr += '<div class="xsec"><h2 class="xhead">See Real Client Results &#128071;</h2>';
      if (RESULTS.length) {
        htmlStr += '<div class="results solo">' + RESULTS.map(function (u) {
          return '<img src="' + esc(u) + '" alt="Client result" loading="lazy">';
        }).join("") + "</div>";
      }
      if (IG) {
        htmlStr += (RESULTS.length ? '<div class="igwrap">' : "") +
          '<div class="elfsight-app-' + esc(IG) + '" data-elfsight-app-lazy></div>' +
          (RESULTS.length ? "</div>" : "");
        loadElfsight();
      }
      htmlStr += "</div>";
    }
    if (GOOG) {
      htmlStr += '<div class="xsec"><h2 class="xhead">What Our Clients Say &#11088;</h2>' +
        '<div class="elfsight-app-' + esc(GOOG) + '" data-elfsight-app-lazy></div></div>';
      loadElfsight();
    }
    /* Location: map first, the studio photos below it — template order. */
    htmlStr += '<div class="xsec"><h2 class="xhead">&#128205;We are located at ' + esc(ADDR) + "</h2>" +
      '<div class="mapcard"><iframe loading="lazy" src="https://www.google.com/maps?q=' +
      encodeURIComponent(ADDR) + '&output=embed"></iframe></div>' +
      (STUDIO.length ? '<div class="studio">' + STUDIO.map(function (u) {
        return '<img src="' + esc(u) + '" alt="Our studio" loading="lazy">';
      }).join("") + "</div>" : "") + "</div>";
    if (phase === "booking" && Array.isArray(window.OB_FAQS) && window.OB_FAQS.length) {
      htmlStr += '<div class="xsec"><h2 class="xhead">FAQs &#128071;</h2><div class="faqs">' +
        window.OB_FAQS.map(function (f) {
          return "<details><summary>" + esc(f.q) + '</summary><p class="fa">' + esc(f.a) + "</p>" +
            (f.v ? '<div class="vidbox" data-v="' + esc(f.v) + '">' +
              (f.p ? '<img src="' + esc(f.p) + '" alt="" loading="lazy">' : "") +
              '<span class="vplay">&#9654;</span></div>' : "") +
            "</details>";
        }).join("") + "</div></div>";
    }
    el.innerHTML = htmlStr;
  }

  var cta = document.createElement("div");
  cta.className = "stickycta";
  cta.innerHTML = '<button type="button" id="ob-cta"><b>Receive My Voucher</b>' +
    '<span>Limited to the next 20 clients only</span></button>';
  root.appendChild(cta);
  document.getElementById("ob-cta").onclick = focusBox;
  var hasScrolled = false;
  function ctaCheck() {
    /* Nothing left to claim on the thank-you step — the voucher CTA
       stays hidden once the deposit is paid. */
    if (phase === "done") { cta.classList.remove("on"); return; }
    hasScrolled = true;
    var b = boxEl.getBoundingClientRect();
    var away = b.bottom < window.innerHeight * 0.35 || b.top > window.innerHeight * 0.85;
    cta.classList.toggle("on", hasScrolled && away);
  }
  window.addEventListener("scroll", ctaCheck, { passive: true });
  window.addEventListener("resize", function () { if (hasScrolled) ctaCheck(); });

  if ("scrollRestoration" in history) { try { history.scrollRestoration = "manual"; } catch (e) {} }
  window.scrollTo(0, 0);
  window.addEventListener("load", function () { if (!interacted) window.scrollTo(0, 0); });

  /* Team preview: ?preview=thankyou jumps straight to the post-payment
     celebration with sample data (&name= to personalize) — no lead is
     created and no visit is counted. */
  var PREVIEW = new URLSearchParams(location.search).get("preview") || "";

  /* Visit beacon: one report per visitor per day (the page itself is
     CDN-cached, so the server can't count views). localStorage id keeps
     refreshes from double counting; the server dedupes per day too. */
  if (!PREVIEW) try {
    var vid = localStorage.getItem("ob_vid");
    if (!vid) {
      vid = (crypto.randomUUID ? crypto.randomUUID() : "v-" + Date.now() + "-" + Math.floor(Math.random() * 1e9));
      localStorage.setItem("ob_vid", vid);
    }
    var day = new Date().toISOString().slice(0, 10);
    var hitKey = "ob_hit_" + (C.slug || "") + "_" + day;
    if (!sessionStorage.getItem(hitKey)) {
      sessionStorage.setItem(hitKey, "1");
      fetch((C.submitUrl || "").replace(/submit$/, "hit"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        keepalive: true,
        body: JSON.stringify({
          slug: C.slug || "",
          visitorId: vid,
          experimentId: C.experimentId || "",
          variantKey: C.variantKey || "",
        }),
      }).catch(function () {});
    }
  } catch (e) {}

  if (PREVIEW === "thankyou") {
    state.answers.full_name = new URLSearchParams(location.search).get("name") || "Gorgeous";
    var pvd = new Date(Date.now() + 2 * 86400000);
    var pad2 = function (n) { return (n < 10 ? "0" : "") + n; };
    state.slotIso = pvd.getFullYear() + "-" + pad2(pvd.getMonth() + 1) + "-" + pad2(pvd.getDate()) + "T14:00:00";
    show("done");
  } else {
    show("survey");
  }
})();
