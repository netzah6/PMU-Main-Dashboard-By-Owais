/* One-Box B2B funnel engine — the agency's own artist-acquisition funnel
   (pmu-bookings.com rebuilt as a single swapping card). Phases: 9-question
   application -> territory scan -> discovery-call booking (real GHL
   availability) -> confirmation. Server side: /api/onebox/submit books
   nothing and tags "b2b-onebox-survey"; /api/onebox/book creates the
   confirmed appointment on the Nicolas discovery calendar so the agency's
   "Appointment status" workflows fire natively. Page chrome (results,
   video interviews, guarantee, founder) renders below the card. */
(function () {
  "use strict";
  var C = window.OB_CONFIG || {};

  /* ---------- assets (agency media library + Wistia thumbnails) ---------- */
  var P = "https://images.leadconnectorhq.com/image/f_webp/q_80/";
  var A = "u_https://assets.cdn.filesafe.space/SfpNMJ5YU9lBkxss47lK/media/";
  var IMG = {
    logo: P + "r_240/" + A + "61e6fdcad646e289f9bae363.png",
    hero: P + "r_1200/" + A + "6258a0ec0b05097dae372b08.png",
    stars: P + "r_500/" + A + "6256e3fc0b0509111b363f7b.png",
    res1: P + "r_420/" + A + "6253946b4304fd9f7d996fc5.jpeg",
    res2: P + "r_420/" + A + "6253946b4304fde555996fc3.jpeg",
    res3: P + "r_420/" + A + "6253946b4304fd754e996fc4.jpeg",
    badge: P + "r_300/" + A + "62614338b04d4b0fd51565bd.png",
    founder: P + "r_600/" + A + "61d0b4dc18b96a8317592f73.jpeg",
    avatar: "https://embed-ssl.wistia.com/deliveries/af2125c514399fa1e7fc6102dbb7eb0f.jpg?image_crop_resized=200x200",
  };
  var W = "https://embed-ssl.wistia.com/deliveries/";
  var CROP = ".jpg?image_crop_resized=480x270";
  /* Real interview videos (Wistia), surfaced pre-booking — on the original
     funnel these sit on the thank-you page where they can't convert. */
  var VIDEOS = [
    { id: "b5fi6btwv8", thumb: W + "a81c5e43c1613f6498b58ceccdde8aac" + CROP, cap: "Interview — Martha, Faces By Design", quote: "“I doubled my income in 30 days, and within 7 months I became fully booked 3 months in advance.”", who: "Martha Jones — Faces By Design", loc: "Whipple, OH, USA" },
    { id: "rgs4u6l8d5", thumb: W + "447d316ac983aac4620af95e0c5402dd" + CROP, cap: "Interview — Lisa Bee, A Natural Beautie", quote: "“I’m making over six figures a month now, and I don’t even have to post consistently on social media!”", who: "Lisa Bee — A Natural Beautie", loc: "Atlanta, GA, USA" },
    { id: "1dfxla3d8c", thumb: W + "6eec51f79e8b8dc2e27d237976442f692547a625" + CROP, cap: "Interview — Erin, Bombshell Beauty & Lash Bar", quote: "“I hit over 60 bookings in less than 90 days — it completely changed the game for my business.”", who: "Erin Heidecke — Bombshell Beauty & Lash Bar", loc: "Grayslake, IL, USA" },
    { id: "gxdwoxhndt", thumb: W + "8b08d8de07b81a2a7e34cecfe059f8f2" + CROP, cap: "Interview — Tonni, Timeless Beauty's", quote: "“In just 4 months, I went from making $3k a month to $12k! The strategies were a game-changer.”", who: "Tonni Petty — Timeless Beauty's", loc: "Puyallup, WA, USA" },
    { id: "0hptjpbu24", thumb: W + "3ec092a0fc950a95ddccb9238f6f68f8" + CROP, cap: "Interview — Teri, Brow Botanical", quote: "“I’ve literally tripled my clients. It’s been the best decision for my business!”", who: "Teri Foulds — Brow Botanical", loc: "Midland, TX, USA" },
    { id: "0coykd6lw2", thumb: W + "a13bbb216c74c03477fa7dcc9c21ac3c" + CROP, cap: "Interview — Nahid, Shihan Day Spa", quote: "“The strategy they gave me helped me 3X my bookings. I finally have a system that actually works!”", who: "Nahid Farzinzad — Shihan Day Spa", loc: "Avon, CT, USA" },
  ];
  var INTRO_VIDEO = { id: "o009b7n55c", thumb: W + "af2125c514399fa1e7fc6102dbb7eb0f" + CROP };

  var HEADLINE = C.headline || "15–30 Financially Qualified Bookings Every Month <span class=\"hl\">On Autopilot</span> With Our AI System";
  var SUB = C.sub || "Without Discount Services… GUARANTEED Or 100% Money-Back";

  /* ---------- styles ---------- */
  var CSS = "" +
":root{--teal:#00ccbb;--teal-deep:#00a396;--ink:#14201e;--muted:#5b6b68;--line:#e3eae8;--mist:#f4f8f7;--amber-bg:#fff7e6;--amber-tx:#9a6200;--amber-line:#f3d9a4;--ok:#0e9f6e;--err:#d64545;--grad:linear-gradient(135deg,#00ccbb 0%,#00a396 100%);--shadow-card:0 24px 60px -18px rgba(10,60,55,.28),0 4px 16px rgba(10,60,55,.08);--font-head:'Montserrat',Avenir,'Segoe UI',sans-serif;--font-body:'Lato','Helvetica Neue',Arial,sans-serif}" +
"*,*::before,*::after{box-sizing:border-box}" +
"body{margin:0;font-family:var(--font-body);color:var(--ink);background:#fff;font-size:16.5px;line-height:1.6;-webkit-font-smoothing:antialiased}" +
"#onebox-root img{max-width:100%;display:block}" +
"#onebox-root h1,#onebox-root h2,#onebox-root h3{font-family:var(--font-head);line-height:1.22;text-wrap:balance;margin:0}" +
"#onebox-root p{margin:0}#onebox-root button{font-family:inherit;cursor:pointer}" +
".topbar{display:flex;align-items:center;justify-content:center;gap:12px;padding:14px 20px;background:#fff}" +
".topbar img{width:52px;height:52px}" +
".topbar .wordmark{font-family:var(--font-head);font-weight:800;font-size:21px;letter-spacing:-.2px}" +
"@media (max-width:560px){.topbar{gap:9px;padding:11px 16px}.topbar img{width:38px;height:38px}.topbar .wordmark{font-size:16px}}" +
".hero{position:relative;background:#0c1f1c url(" + IMG.hero + ") center 30%/cover no-repeat;padding:72px 20px 150px;text-align:center}" +
".hero::before{content:\"\";position:absolute;inset:0;background:linear-gradient(180deg,rgba(7,25,22,.72) 0%,rgba(7,25,22,.55) 55%,rgba(7,25,22,.78) 100%)}" +
".hero>*{position:relative}" +
".hero h1{color:#fff;font-size:clamp(28px,4.6vw,46px);font-weight:800;max-width:900px;margin:0 auto}" +
".hero h1 .hl{color:var(--teal)}" +
".hero .sub{color:#e9f5f3;font-size:clamp(16px,2vw,20px);font-weight:700;margin:18px auto 0;max-width:640px;font-family:var(--font-head)}" +
".hero .sub small{display:block;font-weight:600;font-size:.86em;opacity:.92;margin-top:6px;font-family:var(--font-body)}" +
".boxwrap{padding:0 16px;margin-top:-108px;position:relative;z-index:5}" +
".obox{max-width:620px;margin:0 auto;background:#fff;border-radius:20px;box-shadow:var(--shadow-card);overflow:hidden}" +
".ob-head{padding:18px 26px 0}" +
".ob-progress{display:flex;align-items:center;gap:12px}" +
".ob-track{flex:1;height:7px;border-radius:99px;background:#e8f0ee;overflow:hidden}" +
".ob-fill{height:100%;border-radius:99px;background:var(--grad);width:8%;transition:width .45s cubic-bezier(.22,1,.36,1)}" +
".ob-steplabel{font-size:12.5px;font-weight:700;color:var(--muted);white-space:nowrap;font-variant-numeric:tabular-nums}" +
".ob-body{padding:22px 26px 26px;min-height:330px;position:relative}" +
"@media (max-width:520px){.ob-body{padding:20px 18px 22px}.ob-head{padding:16px 18px 0}}" +
".slide{opacity:0}.slide.in{animation:obslidein .3s cubic-bezier(.22,1,.36,1) forwards}.slide.in.back{animation-name:obslideback}" +
"@keyframes obslidein{from{opacity:0;transform:translateX(28px)}to{opacity:1;transform:none}}" +
"@keyframes obslideback{from{opacity:0;transform:translateX(-28px)}to{opacity:1;transform:none}}" +
"@media (prefers-reduced-motion:reduce){.slide.in{animation:none;opacity:1}}" +
".q-title{font-size:clamp(19px,2.6vw,23px);font-weight:800;margin-bottom:6px}" +
".q-note{color:var(--muted);font-size:14.5px;margin-bottom:16px}" +
".q-frame{background:var(--mist);border:1px solid var(--line);border-radius:12px;padding:12px 16px;font-size:14.5px;color:var(--ink);margin-bottom:16px;line-height:1.55}" +
".q-frame b{color:var(--teal-deep)}" +
".opts{display:flex;flex-direction:column;gap:10px}" +
".opt{display:flex;align-items:center;gap:12px;width:100%;text-align:left;background:#fff;border:2px solid var(--line);border-radius:12px;padding:13px 16px;font-size:16px;font-weight:600;color:var(--ink);transition:border-color .15s,background .15s,color .15s,transform .12s}" +
".opt .dot{flex:none;width:20px;height:20px;border-radius:50%;border:2px solid #c6d4d1;position:relative;transition:border-color .15s}" +
".opt:hover{border-color:var(--teal)}" +
".opt.sel{background:var(--grad);border-color:transparent;color:#fff;transform:scale(1.01)}" +
".opt.sel .dot{border-color:#fff}.opt.sel .dot::after{content:\"\";position:absolute;inset:3px;border-radius:50%;background:#fff}" +
".tin{width:100%;border:2px solid var(--line);border-radius:12px;padding:14px 16px;font-size:17px;font-family:var(--font-body);color:var(--ink);background:#fff;outline:none;transition:border-color .15s}" +
".tin:focus{border-color:var(--teal)}.tin.err{border-color:var(--err);background:#fff7f7}" +
"textarea.tin{min-height:110px;resize:vertical;line-height:1.5}" +
".field{margin-bottom:12px}" +
".field label{display:block;font-size:13px;font-weight:700;color:var(--muted);margin-bottom:6px;letter-spacing:.02em}" +
".ferr{display:none;color:var(--err);font-size:13px;margin-top:5px;font-weight:600}" +
".field.bad .ferr{display:block}.field.bad .tin{border-color:var(--err);background:#fff7f7}" +
".microtrust{display:flex;align-items:center;gap:7px;color:var(--muted);font-size:13px;margin-top:10px}" +
".pf{overflow:hidden;max-height:0;opacity:0;transition:max-height .4s cubic-bezier(.22,1,.36,1),opacity .35s ease}" +
".pf.show{max-height:140px;opacity:1}" +
"@media (prefers-reduced-motion:reduce){.pf{transition:none}}" +
".cta{display:flex;align-items:center;justify-content:center;gap:8px;width:100%;border:none;border-radius:999px;background:var(--grad);color:#fff;font-family:var(--font-head);font-weight:800;font-size:17.5px;padding:16px 22px;margin-top:16px;box-shadow:0 10px 24px -8px rgba(0,180,165,.55);transition:transform .12s,box-shadow .12s}" +
".cta:hover{transform:translateY(-1px)}.cta:active{transform:translateY(0)}.cta[disabled]{opacity:.45;pointer-events:none}" +
".cta small{display:block;font-family:var(--font-body);font-weight:600;font-size:12.5px;opacity:.92}" +
".cta .stack{display:flex;flex-direction:column;line-height:1.25}" +
".backrow{text-align:center;margin-top:16px}" +
".backlink{background:none;border:none;color:var(--muted);font-size:14px;font-weight:600;text-decoration:underline;text-underline-offset:3px}" +
".backlink:hover{color:var(--ink)}" +
".scan{padding:26px 0 10px;text-align:center}" +
".scan .radar{width:74px;height:74px;margin:0 auto 20px;border-radius:50%;border:3px solid #d9ebe8;border-top-color:var(--teal);animation:obspin 1s linear infinite}" +
"@keyframes obspin{to{transform:rotate(360deg)}}" +
"@media (prefers-reduced-motion:reduce){.scan .radar{animation:none}}" +
".scan-lines{max-width:340px;margin:0 auto;text-align:left;display:flex;flex-direction:column;gap:12px}" +
".scan-line{display:flex;align-items:center;gap:10px;font-size:15.5px;font-weight:600;color:#9fb3af;transition:color .3s}" +
".scan-line .tick{flex:none;width:22px;height:22px;border-radius:50%;border:2px solid #d3e2df;display:grid;place-items:center;font-size:12px;color:transparent;transition:all .3s}" +
".scan-line.done{color:var(--ink)}.scan-line.done .tick{background:var(--ok);border-color:var(--ok);color:#fff}" +
".goodnews{text-align:center;margin-bottom:6px;font-size:clamp(20px,2.8vw,24px);font-weight:800;font-family:var(--font-head)}" +
".goodsub{text-align:center;color:var(--muted);font-size:15px;margin-bottom:14px}.goodsub b{color:var(--ink)}" +
".hold{display:flex;align-items:center;justify-content:center;gap:8px;background:var(--amber-bg);border:1px solid var(--amber-line);color:var(--amber-tx);font-weight:700;font-size:13.5px;border-radius:999px;padding:7px 14px;width:max-content;max-width:100%;margin:0 auto 16px;font-variant-numeric:tabular-nums}" +
".hostrow{display:flex;align-items:center;gap:12px;background:var(--mist);border:1px solid var(--line);border-radius:14px;padding:10px 14px;margin-bottom:16px}" +
".hostrow img{width:44px;height:44px;border-radius:50%;object-fit:cover}" +
".hostrow .hn{font-weight:800;font-family:var(--font-head);font-size:14.5px}" +
".hostrow .hm{color:var(--muted);font-size:13px}" +
".dayrow{display:flex;gap:8px;overflow-x:auto;padding:2px 2px 10px;scrollbar-width:thin}" +
".day{flex:none;width:74px;display:flex;flex-direction:column;align-items:center;gap:1px;border:2px solid var(--line);border-radius:12px;background:#fff;padding:9px 4px;text-align:center;transition:border-color .15s,background .15s,color .15s}" +
".day .dw{display:block;font-size:11.5px;font-weight:700;letter-spacing:.08em;color:var(--muted);text-transform:uppercase}" +
".day .dn{display:block;font-family:var(--font-head);font-weight:800;font-size:19px}" +
".day .dm{display:block;font-size:11.5px;color:var(--muted)}" +
".day:hover{border-color:var(--teal)}" +
".day.sel{background:var(--grad);border-color:transparent;color:#fff}.day.sel .dw,.day.sel .dm{color:#eafffb}" +
".slots{display:grid;grid-template-columns:repeat(3,1fr);gap:9px;margin-top:8px}" +
"@media (max-width:430px){.slots{grid-template-columns:repeat(2,1fr)}}" +
".slot{border:2px solid #cfe9e5;border-radius:11px;background:#fff;color:var(--teal-deep);font-weight:700;font-size:14.5px;padding:11px 6px;transition:all .13s;font-variant-numeric:tabular-nums}" +
".slot:hover{border-color:var(--teal);background:#f2fffd}" +
".slot.sel{background:var(--grad);border-color:transparent;color:#fff;box-shadow:0 8px 18px -6px rgba(0,180,165,.5)}" +
".slotshim{height:44px;border-radius:11px;background:linear-gradient(90deg,#eef5f3 25%,#f7fbfa 50%,#eef5f3 75%);background-size:200% 100%;animation:obshim 1.1s infinite}" +
"@keyframes obshim{from{background-position:200% 0}to{background-position:-200% 0}}" +
".tznote{color:var(--muted);font-size:12.5px;text-align:center;margin-top:12px}" +
".donewrap{text-align:center}" +
".bigcheck{width:76px;height:76px;margin:6px auto 14px;border-radius:50%;background:var(--grad);display:grid;place-items:center;box-shadow:0 14px 30px -10px rgba(0,180,165,.55);animation:obpop .5s cubic-bezier(.34,1.56,.64,1)}" +
".bigcheck svg{width:38px;height:38px}" +
"@keyframes obpop{0%{transform:scale(.4);opacity:0}100%{transform:scale(1);opacity:1}}" +
"@media (prefers-reduced-motion:reduce){.bigcheck{animation:none}}" +
".apptcard{background:var(--mist);border:1px solid var(--line);border-radius:14px;padding:16px;margin:16px 0;text-align:left}" +
".apptcard .row{display:flex;gap:10px;align-items:flex-start;padding:6px 0;font-size:15px}" +
".apptcard .row .ic{flex:none;width:22px;text-align:center}" +
".calbtns{display:flex;gap:10px;flex-wrap:wrap;justify-content:center;margin:14px 0 4px}" +
".calbtn{display:inline-flex;align-items:center;gap:8px;border:2px solid var(--line);background:#fff;border-radius:999px;padding:10px 18px;font-weight:700;font-size:14px;color:var(--ink);text-decoration:none;transition:border-color .15s}" +
".calbtn:hover{border-color:var(--teal)}" +
".warnbox{border:2px dashed #e0b4b4;background:#fff9f9;border-radius:12px;padding:12px 16px;font-size:14px;color:#7c3a3a;margin:16px 0;text-align:left}" +
".warnbox b{color:#b02a2a}" +
".howcall{text-align:left;margin:18px 0 4px}" +
".howcall h3{font-size:16px;margin-bottom:10px}" +
".howcall .hc{display:flex;gap:12px;align-items:flex-start;padding:7px 0;font-size:14.5px}" +
".howcall .n{flex:none;width:26px;height:26px;border-radius:50%;background:var(--grad);color:#fff;font-family:var(--font-head);font-weight:800;font-size:13px;display:grid;place-items:center;margin-top:1px}" +
".vidcard{position:relative;border-radius:14px;overflow:hidden;margin-top:16px;cursor:pointer;border:none;padding:0;display:block;width:100%;background:#0c1f1c}" +
".vidcard img{width:100%;aspect-ratio:16/9;object-fit:cover}" +
".vidcard .play{position:absolute;inset:0;display:grid;place-items:center;background:rgba(7,25,22,.25);transition:background .15s}" +
".vidcard:hover .play{background:rgba(7,25,22,.12)}" +
".vidcard .ply{width:64px;height:64px;border-radius:50%;background:var(--teal);display:grid;place-items:center;box-shadow:0 10px 26px -6px rgba(0,0,0,.4)}" +
".vidcard .ply svg{width:24px;height:24px;margin-left:3px}" +
".vidcard .cap{position:absolute;left:0;right:0;bottom:0;padding:22px 14px 10px;background:linear-gradient(transparent,rgba(7,25,22,.85));color:#fff;font-size:13.5px;font-weight:700;text-align:left}" +
".vidcard iframe{width:100%;aspect-ratio:16/9;border:0;display:block}" +
"#onebox-root section{padding:64px 20px;display:block}" +
".wrap{max-width:1020px;margin:0 auto}" +
".eyebrow{font-family:var(--font-head);font-weight:800;font-size:13px;letter-spacing:.18em;color:var(--teal-deep);text-transform:uppercase;text-align:center;margin-bottom:10px}" +
".sec-title{font-size:clamp(24px,3.4vw,34px);font-weight:800;text-align:center;margin-bottom:14px}" +
".sec-sub{color:var(--muted);text-align:center;max-width:620px;margin:0 auto 40px;font-size:16.5px}" +
".truststrip{padding:34px 20px 6px;text-align:center}" +
".truststrip .stars{width:150px;margin:0 auto 8px}" +
".truststrip p{color:var(--muted);font-size:14.5px;font-weight:600}" +
".results-grid{display:grid;grid-template-columns:repeat(3,1fr);gap:22px}" +
"@media (max-width:820px){.results-grid{grid-template-columns:1fr;max-width:420px;margin:0 auto}}" +
".rescard{background:#fff;border:1px solid var(--line);border-radius:16px;overflow:hidden;box-shadow:0 10px 30px -14px rgba(10,60,55,.15)}" +
".rescard .cap{padding:14px 16px;font-weight:700;font-size:15px;text-align:center;font-family:var(--font-head)}" +
".rescard .cap b{color:var(--teal-deep)}" +
".vids-grid{display:grid;grid-template-columns:repeat(3,1fr);gap:22px}" +
"@media (max-width:820px){.vids-grid{grid-template-columns:1fr;max-width:420px;margin:0 auto}}" +
".vt .vidcard{margin-top:0}" +
".vt blockquote{margin:12px 0 6px;font-size:15px;line-height:1.55;color:var(--ink)}" +
".vt .who{font-weight:700;font-family:var(--font-head);font-size:13.5px}" +
".vt .loc{color:var(--muted);font-size:13px}" +
".t-grid{display:grid;grid-template-columns:repeat(3,1fr);gap:20px;margin-top:36px}" +
"@media (max-width:900px){.t-grid{grid-template-columns:repeat(2,1fr)}}" +
"@media (max-width:620px){.t-grid{grid-template-columns:1fr}}" +
".tcard{background:#fff;border:1px solid var(--line);border-radius:16px;padding:22px}" +
".tcard .st{color:#f5b301;letter-spacing:2px;font-size:14px;margin-bottom:10px}" +
".tcard blockquote{margin:0 0 14px;font-size:15px;line-height:1.6}" +
".tcard .who{display:flex;gap:10px;align-items:center}" +
".tcard .av{width:38px;height:38px;border-radius:50%;background:var(--grad);color:#fff;font-family:var(--font-head);font-weight:800;font-size:14px;display:grid;place-items:center;flex:none}" +
".tcard .nm{font-weight:700;font-size:14px;font-family:var(--font-head)}" +
".tcard .biz{color:var(--muted);font-size:12.5px}" +
".guarantee{background:var(--mist)}" +
".g-card{max-width:720px;margin:0 auto;background:#fff;border:1px solid var(--line);border-radius:20px;padding:38px 34px;text-align:center;box-shadow:0 14px 40px -18px rgba(10,60,55,.18)}" +
".g-card img{width:110px;height:110px;margin:0 auto 16px}" +
".g-card h2{font-size:clamp(22px,3vw,28px);margin-bottom:12px}" +
".g-card p{color:var(--muted);font-size:16px;max-width:520px;margin:0 auto 8px}" +
".g-card p b{color:var(--ink)}" +
".founder .wrap{display:flex;gap:44px;align-items:center;max-width:880px}" +
"@media (max-width:720px){.founder .wrap{flex-direction:column;text-align:center}}" +
".founder img{width:min(270px,78vw);height:auto;border-radius:20px;box-shadow:var(--shadow-card);flex:none}" +
".founder h2{font-size:clamp(22px,3vw,30px);margin-bottom:14px}" +
".founder p{color:var(--muted);margin-bottom:10px}.founder p b{color:var(--ink)}" +
".finalcta{background:var(--grad);text-align:center}" +
".finalcta h2{color:#fff;font-size:clamp(24px,3.4vw,34px);margin-bottom:10px}" +
".finalcta p{color:#e6fffb;margin-bottom:24px;font-size:16.5px}" +
".cta2{display:inline-flex;flex-direction:column;align-items:center;background:#fff;color:var(--teal-deep);border:none;border-radius:999px;padding:16px 40px;font-family:var(--font-head);font-weight:800;font-size:17px;box-shadow:0 16px 40px -12px rgba(0,0,0,.35);transition:transform .12s;text-decoration:none}" +
".cta2 small{font-family:var(--font-body);font-weight:600;font-size:12.5px;color:var(--muted)}" +
".cta2:hover{transform:translateY(-2px)}" +
".obfooter{padding:36px 20px 46px;text-align:center;color:#8fb0ab;font-size:13.5px;background:#0c1f1c}" +
".obfooter .fl{display:flex;align-items:center;justify-content:center;gap:10px;margin-bottom:12px}" +
".obfooter .fl img{width:40px;height:40px;border-radius:9px}" +
".obfooter .fl span{color:#fff;font-family:var(--font-head);font-weight:700;font-size:16px}" +
".sticky-cta{position:fixed;left:12px;right:12px;bottom:12px;z-index:50;display:none}" +
".sticky-cta.show{display:block;animation:obrise .3s ease}" +
"@keyframes obrise{from{transform:translateY(80px)}to{transform:none}}" +
".sticky-cta button{width:100%;border:none;border-radius:999px;background:var(--grad);color:#fff;font-family:var(--font-head);font-weight:800;font-size:16px;padding:15px;box-shadow:0 12px 30px -6px rgba(7,40,36,.5)}" +
"@media (min-width:721px){.sticky-cta.show{display:none}}" +
".obtoast{position:fixed;left:50%;bottom:26px;transform:translateX(-50%) translateY(20px);background:#12211f;color:#fff;font-size:14px;font-weight:600;padding:11px 20px;border-radius:999px;opacity:0;pointer-events:none;transition:all .25s;z-index:99;max-width:92vw;text-align:center}" +
".obtoast.show{opacity:1;transform:translateX(-50%)}" +
"#onebox-root :focus-visible{outline:3px solid rgba(0,204,187,.55);outline-offset:2px}";

  /* ---------- page skeleton ---------- */
  var root = document.getElementById("onebox-root");
  if (!root) return;
  var styleEl = document.createElement("style");
  styleEl.textContent = CSS;
  document.head.appendChild(styleEl);

  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }

  var PLAY_SVG = '<span class="play"><span class="ply"><svg viewBox="0 0 24 24" fill="#fff"><path d="M8 5v14l11-7z"/></svg></span></span>';
  function vidCardHTML(id, thumb, cap) {
    return '<button type="button" class="vidcard" data-wid="' + esc(id) + '">' +
      '<img src="' + thumb + '" alt="' + esc(cap) + '" loading="lazy">' + PLAY_SVG +
      '<span class="cap">▶️ ' + esc(cap) + "</span></button>";
  }

  var page = "" +
    '<div class="topbar"><img src="' + IMG.logo + '" alt="PMU Bookings On Demand logo"><span class="wordmark">PMU Bookings On Demand</span></div>' +
    '<header class="hero"><h1>' + HEADLINE + '</h1>' +
    '<p class="sub">' + SUB + '<small>We partner with only <b>one PMU artist per area</b> — check if yours is still open below.</small></p></header>' +
    '<div class="boxwrap" id="boxanchor"><div class="obox" id="obox">' +
    '<div class="ob-head"><div class="ob-progress"><div class="ob-track"><div class="ob-fill" id="obfill"></div></div><div class="ob-steplabel" id="obstep">Step 1 of 9</div></div></div>' +
    '<div class="ob-body"><div class="slide" id="obslide"></div></div>' +
    "</div></div>" +
    '<div class="truststrip"><img class="stars" src="' + IMG.stars + '" alt="5 star rating"><p>Rated 5.0 by over 300 permanent makeup artists across the USA</p></div>' +
    '<section id="ob-results"><div class="wrap"><div class="eyebrow">Results</div><h2 class="sec-title">Real campaigns. Real booking opportunities.</h2>' +
    '<p class="sec-sub">Screenshots from client ad accounts — this is what “on autopilot” actually looks like.</p><div class="results-grid">' +
    '<div class="rescard"><img src="' + IMG.res1 + '" alt="Ad results" loading="lazy"><div class="cap"><b>183</b> booking opportunities in 30 days — <b>$7.94</b> each</div></div>' +
    '<div class="rescard"><img src="' + IMG.res2 + '" alt="Ad results" loading="lazy"><div class="cap"><b>79</b> booking opportunities in 30 days — <b>$10.50</b> each</div></div>' +
    '<div class="rescard"><img src="' + IMG.res3 + '" alt="Ad results" loading="lazy"><div class="cap"><b>93</b> booking opportunities in 30 days — <b>$8.39</b> each</div></div>' +
    "</div></div></section>" +
    '<section id="ob-videos" style="background:var(--mist)"><div class="wrap"><div class="eyebrow">Video Reviews</div><h2 class="sec-title">Hear it from artists like you</h2>' +
    '<p class="sec-sub">Unscripted interviews with PMU artists using the system today.</p><div class="vids-grid">' +
    VIDEOS.map(function (v) {
      return '<div class="vt">' + vidCardHTML(v.id, v.thumb, v.cap) +
        "<blockquote>" + v.quote + "</blockquote>" +
        '<div class="who">' + esc(v.who) + '</div><div class="loc">' + esc(v.loc) + "</div></div>";
    }).join("") +
    "</div></div></section>" +
    '<section id="ob-testimonials"><div class="wrap"><div class="eyebrow">What Our Clients Say</div><h2 class="sec-title">Booked-out calendars, in their words</h2><div class="t-grid">' +
    [
      ["KG", "Kelly Giacalone", "Sage Chevelle Beauty · San Diego, CA", "“I’m now fully booked out two months in advance! PMU Bookings On Demand completely changed the game for me.”"],
      ["DH", "Deyonne Hallberg", "Huemon Beauty · Gaithersburg, MD", "“I was able to grow so much that I hired two more artists to join my team. I never thought I’d expand this fast!”"],
      ["LH", "Livia Harrienger", "New Natural · Watertown, NY", "“They educate my clients like no other. My next month is completely booked.”"],
      ["TC", "Tracey Collett", "Fine Arts Permanent Cosmetics · Chandler, AZ", "“They make the leads excited — they are more than just a marketing company.”"],
      ["MT", "Maryam Thomas", "Eye Select Beauty · Scottsdale, AZ", "“The training on how to talk to clients has been a game-changer! My clients are responding better than ever.”"],
      ["JC", "Jenna Chaco", "It Girl Ink IV · Henderson, NV", "“Thank you for making my business easy to run — I spend time with my family and never worry about having clients.”"],
    ].map(function (t) {
      return '<div class="tcard"><div class="st">★★★★★</div><blockquote>' + t[3] + '</blockquote>' +
        '<div class="who"><div class="av">' + t[0] + '</div><div><div class="nm">' + t[1] + '</div><div class="biz">' + t[2] + "</div></div></div></div>";
    }).join("") +
    "</div></div></section>" +
    '<section class="guarantee"><div class="g-card"><img src="' + IMG.badge + '" alt="100% money-back guarantee seal">' +
    "<h2>Guaranteed Bookings — Or It’s Free</h2>" +
    "<p>Usually, the clients we accept don’t need a money-back guarantee.</p>" +
    "<p>However, just to make it a no-brainer for you: <b>you get PMU bookings, or you don’t pay.</b></p>" +
    "<p>We put our money where our mouth is — this is the proof.</p></div></section>" +
    '<section class="founder"><div class="wrap"><img src="' + IMG.founder + '" alt="Nicolas, founder of PMU Bookings On Demand" loading="lazy"><div>' +
    '<div class="eyebrow" style="text-align:left">Meet The Founder</div><h2>Nicolas — Founder &amp; CEO</h2>' +
    "<p>After spending over <b>$300,000 on marketing</b> for his businesses, with 6 years of experience in advertising &amp; sales, Nicolas took his digital marketing expertise and passion for beauty and founded PMU Bookings On Demand.</p>" +
    "<p>The goal: help permanent makeup artists skyrocket their business with an additional <b>3–6 quality bookings every single week</b> — backed by a money-back guarantee.</p>" +
    "</div></div></section>" +
    '<section class="finalcta"><h2>Is your area still open?</h2><p>We work with only one PMU artist per area. If yours is taken, you can join the waitlist.</p>' +
    '<a class="cta2" href="#boxanchor" id="ob-finalbtn">Check Availability<small>takes about 60 seconds</small></a></section>' +
    '<footer class="obfooter"><div class="fl"><img src="' + IMG.logo + '" alt=""><span>PMU Bookings On Demand</span></div>' +
    "<div>© " + new Date().getFullYear() + " PMU Bookings On Demand. All Rights Reserved.</div></footer>" +
    '<div class="sticky-cta" id="ob-sticky"><button type="button" id="ob-stickybtn">Check Availability In Your Area — 60 sec</button></div>' +
    '<div class="obtoast" id="ob-toast"></div>';

  root.innerHTML = page;

  /* ---------- shared helpers ---------- */
  var slideEl = document.getElementById("obslide");
  var fillEl = document.getElementById("obfill");
  var stepEl = document.getElementById("obstep");
  function $(id) { return document.getElementById(id); }
  function toast(m) {
    var t = $("ob-toast");
    t.textContent = m;
    t.classList.add("show");
    clearTimeout(t._h);
    t._h = setTimeout(function () { t.classList.remove("show"); }, 3200);
  }
  function api(path) { return (C.submitUrl || "/api/onebox/submit").replace(/submit$/, path); }

  var params = new URLSearchParams(location.search);
  var S = {
    step: 0, phase: "qa", answers: {}, area: "", name: "", phone: "", email: "",
    partialSent: false, dayIdx: 0, slot: null, holdEnds: null, holdTimer: null,
    booked: null, booking: false,
    utm_ad: params.get("utm_ad") || params.get("ad_name") || params.get("utm_content") || "",
    utm_adset: params.get("utm_adset") || params.get("adset_name") || params.get("utm_term") || "",
  };

  /* ---------- meta pixel (PageView only — Lead/appointment events come
     from the agency's GHL workflows, identical to the original funnel,
     so the split test measures both sides the same way) ---------- */
  var pixelIds = String(C.metaPixelId || "").split(",").map(function (s) { return s.replace(/\D/g, ""); }).filter(Boolean);
  if (pixelIds.length) {
    (function (f, b, e, v) {
      if (f.fbq) return; var n = (f.fbq = function () { n.callMethod ? n.callMethod.apply(n, arguments) : n.queue.push(arguments); });
      if (!f._fbq) f._fbq = n; n.push = n; n.loaded = true; n.version = "2.0"; n.queue = [];
      var t = b.createElement(e); t.async = true; t.src = v;
      var s = b.getElementsByTagName(e)[0]; s.parentNode.insertBefore(t, s);
    })(window, document, "script", "https://connect.facebook.net/en_US/fbevents.js");
    pixelIds.forEach(function (id) { window.fbq("init", id); });
    window.fbq("track", "PageView");
  }

  /* ---------- survey definition (mirrors the original 9-slide survey) ---------- */
  var QS = [
    { key: "area", type: "text", title: "First — what area do you serve?", note: "We partner with one PMU artist per area, so this decides everything.", ph: "e.g. Miami, Austin, Detroit…", btn: "Check My Area" },
    { key: "spots", type: "radio", title: "How many spots do you need?", opts: ["I'm a single PMU artist", "2 locations", "3 locations", "4 locations", "5+ locations"] },
    { key: "weekly", type: "radio", title: "How many bookings can you handle every week?", opts: ["10–20 bookings", "20–50 bookings", "50–100 bookings", "100–200 bookings", "200+ bookings"] },
    { key: "start", type: "radio", title: "If accepted, how soon are you ready to start receiving qualified booking opportunities?", opts: ["I'm ready right now", "I'm ready in a few weeks", "I'm ready in a few months"] },
    { key: "exp", type: "radio", title: "How long have you been a permanent makeup artist?", opts: ["I just started", "1 year", "2–3 years", "3–5 years", "5–10 years", "10–15 years", "15+ years"] },
    { key: "rev", type: "radio", title: "What is your current annual revenue?", opts: ["Less than $60k", "$60k–$100k annually", "$100k–$200k annually", "$200k–$500k annually", "$500k–$1m annually", "Over $1m annually"] },
    { key: "want", type: "radio", title: "What is your desired annual revenue?", opts: ["Over $60k annually", "$100–$200k annually", "$200–$500k annually", "$500k–$1m annually", "Over $1m annually"] },
    { key: "edge", type: "textarea", title: "What sets YOU apart from other PMU artists in your area?", frame: "We guarantee bookings or it’s free — if you don’t make money, we don’t either. That’s why we can only work with top artists and accept <b>about 20% of applications</b>.", ph: "Tell us in a sentence or two…" },
    { key: "contact", type: "contact", title: "Where should we send your availability report?" },
  ];

  function firstName() {
    var n = (S.name || "").trim().split(/\s+/)[0] || "";
    return n ? n.charAt(0).toUpperCase() + n.slice(1) : "";
  }

  function setProgress() {
    var pct, label;
    if (S.phase === "qa") { pct = 8 + Math.round((S.step / (QS.length - 1)) * 80); label = "Step " + (S.step + 1) + " of " + QS.length; }
    else if (S.phase === "checking") { pct = 92; label = "Checking…"; }
    else if (S.phase === "booking") { pct = 96; label = "Almost done"; }
    else { pct = 100; label = "Confirmed ✓"; }
    fillEl.style.width = pct + "%";
    stepEl.textContent = label;
  }

  function render(html, back) {
    slideEl.classList.remove("in", "back");
    void slideEl.offsetWidth;
    slideEl.innerHTML = html;
    if (back) slideEl.classList.add("back");
    slideEl.classList.add("in");
    setProgress();
    updSticky();
  }

  /* ---------- server calls ---------- */
  function post(path, body) {
    try {
      return fetch(api(path), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        keepalive: true,
        body: JSON.stringify(body),
      });
    } catch (e) { return Promise.reject(e); }
  }
  function leadBase() {
    return {
      slug: C.slug || "",
      full_name: S.name,
      phone: S.phone,
      experimentId: C.experimentId || "",
      variantKey: C.variantKey || "",
      visitorId: VID,
    };
  }
  function sendPartial() {
    if (S.partialSent || !S.name || S.phone.replace(/\D/g, "").length < 10) return;
    S.partialSent = true;
    var b = leadBase();
    b.stage = "partial";
    post("submit", b).catch(function () {});
  }
  function sendComplete() {
    var b = leadBase();
    b.email = S.email;
    b.area = S.answers.area || "";
    b.spots = S.answers.spots || "";
    b.weekly = S.answers.weekly || "";
    b.start = S.answers.start || "";
    b.exp = S.answers.exp || "";
    b.rev = S.answers.rev || "";
    b.want = S.answers.want || "";
    b.edge = S.answers.edge || "";
    b.utm_ad = S.utm_ad;
    b.utm_adset = S.utm_adset;
    b.pageUrl = location.href;
    post("submit", b).catch(function () {});
  }

  /* ---------- QA phase ---------- */
  function showStep(back) {
    S.phase = "qa";
    var q = QS[S.step], h = "";
    h += '<h2 class="q-title">' + q.title + "</h2>";
    if (q.note) h += '<p class="q-note">' + q.note + "</p>";
    if (q.frame) h += '<div class="q-frame">' + q.frame + "</div>";

    if (q.type === "text") {
      h += '<input class="tin" id="ob-qin" type="text" autocomplete="address-level2" placeholder="' + q.ph + '" value="' + esc(S.answers[q.key] || "") + '">';
      h += '<button type="button" class="cta" id="ob-qgo">' + q.btn + " →</button>";
    } else if (q.type === "radio") {
      h += '<div class="opts">';
      q.opts.forEach(function (o, i) {
        var sel = S.answers[q.key] === o ? " sel" : "";
        h += '<button type="button" class="opt' + sel + '" data-i="' + i + '"><span class="dot"></span>' + esc(o) + "</button>";
      });
      h += "</div>";
    } else if (q.type === "textarea") {
      h += '<textarea class="tin" id="ob-qin" placeholder="' + q.ph + '">' + esc(S.answers[q.key] || "") + "</textarea>";
      h += '<button type="button" class="cta" id="ob-qgo">Continue →</button>';
    } else if (q.type === "contact") {
      var hasName = S.name.length > 2, hasPhone = S.phone.replace(/\D/g, "").length >= 10;
      h += '<div class="field" id="ob-f_name"><label>FULL NAME</label><input class="tin" id="ob-in_name" type="text" autocomplete="name" placeholder="Full Name" value="' + esc(S.name) + '"><div class="ferr">Please enter your full name</div></div>';
      h += '<div class="pf' + (hasName ? " show" : "") + '" id="ob-pf_phone"><div class="field" id="ob-f_phone"><label>PHONE</label><input class="tin" id="ob-in_phone" type="tel" inputmode="tel" autocomplete="tel" placeholder="(555) 123-4567" value="' + esc(S.phone) + '"><div class="ferr">Please enter a valid phone number</div></div></div>';
      h += '<div class="pf' + (hasPhone ? " show" : "") + '" id="ob-pf_email"><div class="field" id="ob-f_email"><label>EMAIL</label><input class="tin" id="ob-in_email" type="email" inputmode="email" autocomplete="email" placeholder="you@studio.com" value="' + esc(S.email) + '"><div class="ferr">Please enter a valid email</div></div></div>';
      var area = S.answers.area ? " In " + esc(S.answers.area) : "";
      h += '<div class="pf' + (hasPhone ? " show" : "") + '" id="ob-pf_go"><button type="button" class="cta" id="ob-qgo" style="margin-top:8px"><span class="stack"><span>Check Availability' + area + "</span><small>see if your territory is already taken</small></span></button></div>";
      h += '<div class="microtrust"><svg width="15" height="15" viewBox="0 0 24 24"><path fill="#0e9f6e" d="M12 1.5l8.5 4.2v6.1c0 5.3-3.7 9-8.5 10.7C7.2 20.8 3.5 17.1 3.5 11.8V5.7z"/><path d="M8.2 12l2.6 2.6 4.8-5.2" fill="none" stroke="#fff" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg> Your info is private — no spam, ever.</div>';
    }
    if (S.step > 0) h += '<div class="backrow"><button type="button" class="backlink" id="ob-qback">← Back</button></div>';
    render(h, back);

    var go = $("ob-qgo"), bk = $("ob-qback");
    if (bk) bk.onclick = function () { S.step--; showStep(true); };

    if (q.type === "radio") {
      var opts = slideEl.querySelectorAll(".opt");
      Array.prototype.forEach.call(opts, function (b) {
        b.onclick = function () {
          Array.prototype.forEach.call(opts, function (x) { x.classList.remove("sel"); });
          b.classList.add("sel");
          S.answers[q.key] = q.opts[+b.getAttribute("data-i")];
          setTimeout(next, 260);
        };
      });
    } else if (q.type === "text" || q.type === "textarea") {
      var inp = $("ob-qin");
      if (S.step === 0 && !S.answers[q.key]) { /* don't steal focus on load */ }
      else inp.focus();
      if (q.type === "text") inp.addEventListener("keydown", function (e) { if (e.key === "Enter") go.click(); });
      go.onclick = function () {
        var v = inp.value.trim();
        if (!v) { inp.classList.add("err"); inp.focus(); return; }
        inp.classList.remove("err");
        S.answers[q.key] = v;
        if (q.key === "area") S.area = v.replace(/\b\w/g, function (c) { return c.toUpperCase(); });
        next();
      };
    } else if (q.type === "contact") {
      var ip = $("ob-in_phone"), inm = $("ob-in_name");
      function reveal(id) { var e = $(id); if (e && !e.classList.contains("show")) e.classList.add("show"); }
      inm.addEventListener("input", function () {
        S.name = inm.value.trim();
        if (S.name.length > 2) reveal("ob-pf_phone");
      });
      ip.addEventListener("input", function () {
        var d = ip.value.replace(/\D/g, "").slice(0, 11);
        if (d.length === 11 && d.charAt(0) === "1") d = d.slice(1);
        var f = d;
        if (d.length > 6) f = "(" + d.slice(0, 3) + ") " + d.slice(3, 6) + "-" + d.slice(6);
        else if (d.length > 3) f = "(" + d.slice(0, 3) + ") " + d.slice(3);
        ip.value = f;
        S.phone = f;
        if (d.length >= 10) {
          reveal("ob-pf_email"); reveal("ob-pf_go");
          /* Early capture: the lead exists in GHL from this moment, even
             if they never finish — same as the B2C funnels. */
          sendPartial();
        }
      });
      go.onclick = function () {
        var ok = true;
        var nm = $("ob-in_name").value.trim();
        var ph = $("ob-in_phone").value.replace(/\D/g, "");
        var em = $("ob-in_email").value.trim();
        function mark(id, bad) { $(id).classList.toggle("bad", bad); if (bad) ok = false; }
        mark("ob-f_name", nm.length < 2);
        mark("ob-f_phone", !(ph.length === 10 || (ph.length === 11 && ph.charAt(0) === "1")));
        mark("ob-f_email", !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(em));
        if (!ok) return;
        S.name = nm; S.phone = $("ob-in_phone").value; S.email = em;
        sendComplete();
        startChecking();
      };
    }
  }
  function next() { if (S.step < QS.length - 1) { S.step++; showStep(false); } }

  /* ---------- checking phase (territory scan) ---------- */
  function startChecking() {
    S.phase = "checking";
    var area = esc(S.area || "your area");
    var h = '<div class="scan"><div class="radar"></div><div class="scan-lines">' +
      '<div class="scan-line" id="ob-sc0"><span class="tick">✓</span>Checking active partners near <b>&nbsp;' + area + "</b>…</div>" +
      '<div class="scan-line" id="ob-sc1"><span class="tick">✓</span>Scanning open territories…</div>' +
      '<div class="scan-line" id="ob-sc2"><span class="tick">✓</span>Matching your application…</div>' +
      "</div></div>";
    render(h, false);
    setTimeout(function () { var e = $("ob-sc0"); if (e) e.classList.add("done"); }, 700);
    setTimeout(function () { var e = $("ob-sc1"); if (e) e.classList.add("done"); }, 1450);
    setTimeout(function () { var e = $("ob-sc2"); if (e) e.classList.add("done"); }, 2100);
    setTimeout(showBooking, 2650);
  }

  /* ---------- real availability ---------- */
  var cal = { days: [], loaded: false, loading: false, error: false };
  function loadSlots(cb) {
    if (cal.loading) return;
    cal.loading = true;
    /* One request covers the next 3 weeks; starts are rounded to 5-min
       buckets so concurrent visitors share the server's edge cache. */
    var start = Math.ceil(Date.now() / 300000) * 300000;
    var end = start + 21 * 86400000;
    fetch(api("slots") + "?slug=" + encodeURIComponent(C.slug || "") + "&start=" + start + "&end=" + end)
      .then(function (r) { return r.json(); })
      .then(function (j) {
        cal.loading = false;
        if (!j.ok) { cal.error = true; if (cb) cb(); return; }
        var days = [];
        Object.keys(j.dates || {}).sort().forEach(function (k) {
          var slots = (j.dates[k] || []).filter(function (iso) { return new Date(iso).getTime() > Date.now(); });
          if (slots.length) days.push({ date: k, slots: slots });
        });
        cal.days = days.slice(0, 10);
        cal.loaded = true;
        cal.error = false;
        if (cb) cb();
      })
      .catch(function () { cal.loading = false; cal.error = true; if (cb) cb(); });
  }
  var WD = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  var MO = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  function dayParts(dstr) {
    var p = dstr.split("-");
    var d = new Date(+p[0], +p[1] - 1, +p[2], 12);
    return { dw: WD[d.getDay()], dn: d.getDate(), dm: MO[d.getMonth()] };
  }
  function slotLabel(iso) {
    var d = new Date(iso);
    var hh = d.getHours(), mm = d.getMinutes();
    var ap = hh >= 12 ? "PM" : "AM";
    var h12 = hh % 12 || 12;
    return h12 + ":" + (mm < 10 ? "0" : "") + mm + " " + ap;
  }

  /* ---------- booking phase ---------- */
  function fmtHold(ms) {
    var s = Math.max(0, Math.floor(ms / 1000));
    return Math.floor(s / 60) + ":" + ("0" + (s % 60)).slice(-2);
  }
  function startHold() {
    if (!S.holdEnds) S.holdEnds = Date.now() + 15 * 60 * 1000;
    clearInterval(S.holdTimer);
    S.holdTimer = setInterval(function () {
      var el = $("ob-holdt");
      if (!el) { clearInterval(S.holdTimer); return; }
      var left = S.holdEnds - Date.now();
      if (left <= 0) { S.holdEnds = Date.now() + 15 * 60 * 1000; left = 15 * 60 * 1000; }
      el.textContent = fmtHold(left);
    }, 500);
  }
  function showBooking(back) {
    S.phase = "booking";
    var f = firstName(), area = esc(S.area || "your area");
    var h = '<h2 class="goodnews">🎉 Good news' + (f ? ", " + esc(f) : "") + "!</h2>";
    h += '<p class="goodsub">We have <b>1 spot available in ' + area + "</b>. Book your free 15-minute discovery call to claim it.</p>";
    h += '<div class="hold">⏳ We’re holding your ' + area + ' spot for <span id="ob-holdt" style="min-width:44px;text-align:left">15:00</span></div>';
    h += '<div class="hostrow"><img src="' + IMG.avatar + '" alt="Nicolas"><div><div class="hn">Nicolas — Founder &amp; CEO</div><div class="hm">Discovery call · 15 min · Zoom or phone</div></div></div>';
    h += '<div id="ob-calarea"></div>';
    h += '<p class="tznote">All times shown in your local timezone</p>';
    h += '<button type="button" class="cta" id="ob-bookgo" disabled><span class="stack"><span>Claim My ' + area + " Spot</span><small>book the free 15-min call</small></span></button>";
    h += '<div class="backrow"><button type="button" class="backlink" id="ob-qback">← Back to my answers</button></div>';
    render(h, back);
    startHold();
    $("ob-qback").onclick = function () { S.step = QS.length - 1; showStep(true); };
    $("ob-bookgo").onclick = confirmBooking;
    paintCalArea();
    if (!cal.loaded && !cal.loading) loadSlots(paintCalArea);
  }
  function paintCalArea() {
    var box = $("ob-calarea");
    if (!box) return;
    if (!cal.loaded) {
      if (cal.error) {
        box.innerHTML = '<p style="text-align:center;color:var(--err);font-weight:600;padding:16px 0">Couldn’t load available times. <button type="button" class="backlink" id="ob-retry">Try again</button></p>';
        var rb = $("ob-retry");
        if (rb) rb.onclick = function () { cal.error = false; box.innerHTML = ""; loadSlots(paintCalArea); };
        return;
      }
      var shim = "";
      for (var i = 0; i < 6; i++) shim += '<div class="slotshim"></div>';
      box.innerHTML = '<div class="slots">' + shim + "</div>";
      return;
    }
    if (!cal.days.length) {
      box.innerHTML = '<p style="text-align:center;color:var(--muted);font-weight:600;padding:16px 0">No open times in the next 3 weeks — please check back soon.</p>';
      return;
    }
    if (S.dayIdx >= cal.days.length) S.dayIdx = 0;
    var h = '<div class="dayrow">';
    cal.days.forEach(function (d, i) {
      var p = dayParts(d.date);
      h += '<button type="button" class="day' + (i === S.dayIdx ? " sel" : "") + '" data-i="' + i + '"><span class="dw">' + p.dw + '</span><span class="dn">' + p.dn + '</span><span class="dm">' + p.dm + "</span></button>";
    });
    h += '</div><div class="slots" id="ob-slots"></div>';
    box.innerHTML = h;
    Array.prototype.forEach.call(box.querySelectorAll(".day"), function (b) {
      b.onclick = function () {
        Array.prototype.forEach.call(box.querySelectorAll(".day"), function (x) { x.classList.remove("sel"); });
        b.classList.add("sel");
        S.dayIdx = +b.getAttribute("data-i");
        S.slot = null;
        $("ob-bookgo").setAttribute("disabled", "");
        paintSlots();
      };
    });
    paintSlots();
  }
  function paintSlots() {
    var box = $("ob-slots");
    if (!box) return;
    box.innerHTML = "";
    var day = cal.days[S.dayIdx];
    if (!day) return;
    day.slots.forEach(function (iso) {
      var b = document.createElement("button");
      b.type = "button";
      b.className = "slot" + (S.slot === iso ? " sel" : "");
      b.textContent = slotLabel(iso);
      b.onclick = function () {
        Array.prototype.forEach.call(box.querySelectorAll(".slot"), function (x) { x.classList.remove("sel"); });
        b.classList.add("sel");
        S.slot = iso;
        $("ob-bookgo").removeAttribute("disabled");
        var body = leadBase();
        body.stage = "slot";
        body.slotIso = iso;
        post("submit", body).catch(function () {});
      };
      box.appendChild(b);
    });
  }
  function confirmBooking() {
    if (!S.slot || S.booking) return;
    S.booking = true;
    var btn = $("ob-bookgo");
    btn.setAttribute("disabled", "");
    btn.innerHTML = '<span class="stack"><span>Booking your call…</span></span>';
    var body = {
      slug: C.slug || "",
      full_name: S.name,
      phone: S.phone,
      email: S.email,
      startTime: S.slot,
      pageUrl: location.href,
    };
    post("book", body)
      .then(function (r) { return r.json(); })
      .then(function (j) {
        S.booking = false;
        if (j && j.ok) {
          S.booked = { iso: S.slot };
          showDone();
        } else {
          toast("That time was just taken — please pick another.");
          cal.loaded = false;
          showBooking(false);
        }
      })
      .catch(function () {
        S.booking = false;
        toast("Connection hiccup — please try again.");
        var b2 = $("ob-bookgo");
        if (b2) {
          b2.removeAttribute("disabled");
          b2.innerHTML = '<span class="stack"><span>Claim My ' + esc(S.area || "") + " Spot</span><small>book the free 15-min call</small></span>";
        }
      });
  }

  /* ---------- done phase ---------- */
  function fmtWhen(iso) {
    var d = new Date(iso);
    return WD[d.getDay()] + ", " + MO[d.getMonth()] + " " + d.getDate() + " at " + slotLabel(iso);
  }
  function gcalLink() {
    var st = new Date(S.booked.iso);
    var en = new Date(st.getTime() + 15 * 60000);
    function z(x) { return x.toISOString().replace(/[-:]|\.\d{3}/g, ""); }
    return "https://calendar.google.com/calendar/render?action=TEMPLATE&text=" +
      encodeURIComponent("Discovery Call — PMU Bookings On Demand") +
      "&dates=" + z(st) + "/" + z(en) +
      "&details=" + encodeURIComponent("15-minute discovery call with Nicolas (CEO). We will text you to confirm.");
  }
  function icsHref() {
    var st = new Date(S.booked.iso);
    var en = new Date(st.getTime() + 15 * 60000);
    function z(x) { return x.toISOString().replace(/[-:]|\.\d{3}/g, ""); }
    var ics = "BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:-//PMU Bookings On Demand//EN\r\nBEGIN:VEVENT\r\nUID:" +
      Date.now() + "@pmu-bookings.com\r\nDTSTAMP:" + z(new Date()) + "\r\nDTSTART:" + z(st) + "\r\nDTEND:" + z(en) +
      "\r\nSUMMARY:Discovery Call — PMU Bookings On Demand\r\nDESCRIPTION:15-minute discovery call with Nicolas (CEO). We will text you to confirm.\r\nEND:VEVENT\r\nEND:VCALENDAR";
    return "data:text/calendar;charset=utf-8," + encodeURIComponent(ics);
  }
  function showDone() {
    S.phase = "done";
    clearInterval(S.holdTimer);
    var f = esc(firstName() || "you"), area = esc(S.area || "your area");
    var h = '<div class="donewrap">';
    h += '<div class="bigcheck"><svg viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="M4 12.5l5 5L20 7"/></svg></div>';
    h += '<h2 class="q-title" style="text-align:center">You’re booked, ' + f + "!</h2>";
    h += '<p class="q-note" style="text-align:center;margin-bottom:8px">Your <b>1 spot in ' + area + "</b> is reserved under your name.</p>";
    h += '<div class="apptcard">';
    h += '<div class="row"><span class="ic">📅</span><div><b>' + fmtWhen(S.booked.iso) + "</b> (your local time)</div></div>";
    h += '<div class="row"><span class="ic">📞</span><div>15-min discovery call with <b>Nicolas (CEO)</b> — we’ll text you to confirm</div></div>';
    if (S.email) h += '<div class="row"><span class="ic">📧</span><div>Confirmation sent to <b>' + esc(S.email) + '</b> — click “I know the sender” in the event email</div></div>';
    h += "</div>";
    h += '<div class="calbtns"><a class="calbtn" href="' + gcalLink() + '" target="_blank" rel="noopener">📅 Add to Google Calendar</a><a class="calbtn" href="' + icsHref() + '" download="discovery-call.ics"> Add to Apple Calendar</a></div>';
    h += '<div class="warnbox"><b>WARNING:</b> Time is our highest standard. We don’t reschedule, and we partner only with those who honor commitment.</div>';
    h += '<div class="howcall"><h3>How the call will work:</h3>';
    h += '<div class="hc"><span class="n">1</span><div>We’ll <b>text you</b> via cell phone to confirm the call.</div></div>';
    h += '<div class="hc"><span class="n">2</span><div>Be at your desk or in a <b>quiet place</b> — or we’ll politely end the call.</div></div>';
    h += '<div class="hc"><span class="n">3</span><div>Bring a <b>pen &amp; paper</b> to take notes.</div></div></div>';
    h += vidCardHTML(INTRO_VIDEO.id, INTRO_VIDEO.thumb, "Watch this 2-min message from Nicolas before your call");
    h += "</div>";
    render(h, false);
    window.scrollTo(0, 0);
  }

  /* ---------- Wistia click-to-play (event delegation covers cards
     rendered later, e.g. on the confirmation step) ---------- */
  root.addEventListener("click", function (e) {
    var card = e.target && e.target.closest ? e.target.closest(".vidcard[data-wid]") : null;
    if (!card) return;
    var id = card.getAttribute("data-wid");
    card.removeAttribute("data-wid");
    card.innerHTML = '<iframe src="https://fast.wistia.net/embed/iframe/' + esc(id) +
      '?autoPlay=true&videoFoam=true" title="Video" allow="autoplay; fullscreen" allowtransparency="true" allowfullscreen></iframe>';
  });

  /* ---------- sticky CTA / final CTA ---------- */
  var sticky = $("ob-sticky");
  var boxEl = $("obox");
  function updSticky() {
    if (!sticky || !boxEl) return;
    var r = boxEl.getBoundingClientRect();
    var out = r.bottom < 70 || r.top > window.innerHeight;
    sticky.classList.toggle("show", out && S.phase !== "done");
  }
  window.addEventListener("scroll", updSticky, { passive: true });
  window.addEventListener("resize", updSticky);
  function toBox() {
    var smooth = !(window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches);
    $("boxanchor").scrollIntoView({ behavior: smooth ? "smooth" : "auto" });
  }
  $("ob-stickybtn").onclick = toBox;
  $("ob-finalbtn").addEventListener("click", function (e) { e.preventDefault(); toBox(); });

  /* ---------- visit beacon (one per visitor per day, same as B2C) ---------- */
  var VID = "";
  try {
    VID = localStorage.getItem("ob_vid") || "";
    if (!VID) {
      VID = (window.crypto && crypto.randomUUID) ? crypto.randomUUID() : "v-" + Date.now() + "-" + Math.floor(Math.random() * 1e9);
      localStorage.setItem("ob_vid", VID);
    }
    var day = new Date().toISOString().slice(0, 10);
    var hitKey = "ob_hit_" + (C.slug || "") + "_" + day;
    if (!sessionStorage.getItem(hitKey)) {
      sessionStorage.setItem(hitKey, "1");
      post("hit", { slug: C.slug || "", visitorId: VID, experimentId: C.experimentId || "", variantKey: C.variantKey || "" }).catch(function () {});
    }
  } catch (e) {}

  /* ---------- boot ---------- */
  if ("scrollRestoration" in history) { try { history.scrollRestoration = "manual"; } catch (e) {} }
  window.scrollTo(0, 0);
  showStep(false);
  /* Warm the calendar during the survey — by the time the visitor reaches
     the booking step, availability is already in memory. */
  setTimeout(function () { if (!cal.loaded && !cal.loading) loadSlots(null); }, 2500);
})();
