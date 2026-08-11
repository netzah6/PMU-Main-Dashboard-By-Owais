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
  var RESULTS = (C.resultImgs || "").split(",").map(function (s) { return s.trim(); }).filter(Boolean);

  /* Fonts: real Google Fonts on GHL (no CSP here). */
  var fl = document.createElement("link");
  fl.rel = "stylesheet";
  fl.href = "https://fonts.googleapis.com/css2?family=Montserrat:wght@400;700&family=Lato:wght@400;700&family=Inter:wght@400;600&display=swap";
  document.head.appendChild(fl);

  var css = "" +
    "#onebox-root{--teal:#17c3c3;--teal-deep:#0e9c9c;--ink:#111315;--ink-soft:#3d4348;--muted:#6f777d;--line:#e4e7e9;--mint-bg:#d8f5de;--mint-line:#8fd7a1;--mint-ink:#186b2f;--amber:#e8a33d;--gold:#ffc107;--footer:#2b2d2f;--headline:'Montserrat','Helvetica Neue',Arial,sans-serif;--content:'Lato','Helvetica Neue',Arial,sans-serif;--form:'Inter',system-ui,sans-serif;font-family:var(--content);color:var(--ink);background:#fff}" +
    "#onebox-root *{box-sizing:border-box}" +
    "#onebox-root .topbar{background:var(--teal);min-height:30px;display:flex;align-items:center;justify-content:center;gap:6px;padding:6px 14px;text-align:center}" +
    "#onebox-root .topbar svg{width:13px;height:13px;fill:#111;flex:none}" +
    "#onebox-root .topbar span{font-family:var(--headline);font-weight:400;font-size:13.5px;color:#111;line-height:1.3}" +
    "#onebox-root .callbar{border-bottom:1px solid var(--line);padding:11px 20px;text-align:right;font-size:15px;font-weight:700;font-family:var(--headline)}" +
    "#onebox-root .wrap{padding:26px 20px 44px;max-width:720px;margin:0 auto}" +
    "#onebox-root .biglogo{display:block;margin:0 auto 14px;max-height:80px;width:auto}" +
    "#onebox-root .lede{text-align:center;margin:0;font-size:15px;color:var(--ink-soft)}" +
    "#onebox-root h1.page{font-family:var(--headline);font-weight:700;font-size:clamp(24px,3.4vw,30px);line-height:1.2;letter-spacing:-.01em;text-align:center;text-wrap:balance;margin:10px auto 0;max-width:24ch;color:#000}" +
    "#onebox-root .sub{font-family:var(--headline);font-weight:400;font-size:20px;text-align:center;margin:6px 0 0;color:var(--ink-soft)}" +
    "#onebox-root .trust{text-align:center;padding:18px 20px 0}" +
    "#onebox-root .trust p{margin:0;font-size:14px;color:var(--ink-soft)}" +
    "#onebox-root .stars{color:var(--gold);letter-spacing:.14em;font-size:15px;margin-top:3px}" +
    "#onebox-root .box{margin:26px auto 0;max-width:560px;background:#fff;border-radius:12px;border:1px solid var(--line);box-shadow:0 24px 48px -20px rgba(17,19,21,.28),0 4px 14px -8px rgba(17,19,21,.14);overflow:hidden;font-family:var(--form)}" +
    "#onebox-root .rail{margin:14px 16px 0;height:24px;border-radius:999px;background:#e9edef;overflow:hidden}" +
    "#onebox-root .rail span{display:grid;place-items:center;height:100%;border-radius:999px;background:repeating-linear-gradient(135deg,var(--teal) 0 11px,var(--teal-deep) 11px 22px);color:#fff;font-size:11px;font-weight:600;white-space:nowrap;transition:width .45s cubic-bezier(.4,0,.2,1);min-width:44px}" +
    "#onebox-root .slide{padding:22px 26px 26px;min-height:210px}" +
    "#onebox-root .slide.anim-next{animation:ob-in-next .3s ease both}" +
    "#onebox-root .slide.anim-prev{animation:ob-in-prev .3s ease both}" +
    "@keyframes ob-in-next{from{opacity:0;transform:translateX(46px)}to{opacity:1;transform:none}}" +
    "@keyframes ob-in-prev{from{opacity:0;transform:translateX(-46px)}to{opacity:1;transform:none}}" +
    "#onebox-root .qlabel{font-size:16px;font-weight:600;margin:0 0 16px;line-height:1.45;letter-spacing:-.01em}" +
    "#onebox-root .qlabel em{font-style:normal;color:#d33}" +
    "#onebox-root .opts{display:flex;flex-direction:column;gap:9px}" +
    "#onebox-root .opt{display:flex;align-items:center;gap:12px;padding:13px 15px;cursor:pointer;font-size:14.5px;font-weight:500;border:1.5px solid var(--line);border-radius:9px;background:#fff;transition:border-color .15s,background .15s,box-shadow .15s}" +
    "#onebox-root .opt:hover{border-color:var(--teal);background:#f6fcfc}" +
    "#onebox-root .opt:has(input:checked){border-color:var(--teal);background:#eefafa;box-shadow:0 0 0 3px rgba(23,195,195,.14)}" +
    "#onebox-root .opt input{accent-color:var(--teal-deep);width:16px;height:16px;margin:0;cursor:pointer;flex:none}" +
    "#onebox-root .field{width:100%;padding:11px 12px;border:1px solid var(--line);border-radius:4px;font:inherit;font-size:14px;color:var(--ink)}" +
    "#onebox-root .err{color:#d33;font-size:12px;margin:8px 0 0;min-height:1.1em}" +
    "#onebox-root .bar{background:var(--ink);display:flex;justify-content:space-between;align-items:center;padding:13px 22px;gap:12px}" +
    "#onebox-root .bar button{background:none;border:0;color:#fff;font-family:var(--form);font-size:13px;font-weight:600;letter-spacing:.08em;cursor:pointer;padding:6px 8px;border-radius:6px;opacity:.92;transition:opacity .15s,background .15s}" +
    "#onebox-root .bar button:hover:not(:disabled){opacity:1;background:rgba(255,255,255,.09)}" +
    "#onebox-root .bar button[hidden]{visibility:hidden;display:block}" +
    "#onebox-root .phead{font-family:var(--headline);font-weight:700;font-size:17px;line-height:1.3;text-align:center;text-wrap:balance;margin:0 0 4px;color:#000}" +
    "#onebox-root .psub{text-align:center;font-family:var(--content);font-size:13px;color:var(--muted);margin:0 0 14px}" +
    "#onebox-root .calframe{width:100%;border:0;min-height:640px;border-radius:8px}" +
    "#onebox-root .guarantee{background:var(--mint-bg);border:1px solid var(--mint-line);border-radius:7px;padding:13px 15px;text-align:center;margin:0 0 12px;font-family:var(--content)}" +
    "#onebox-root .guarantee strong{display:block;color:var(--mint-ink);font-size:14px;margin-bottom:5px;font-family:var(--headline)}" +
    "#onebox-root .guarantee p{margin:0;font-size:12.5px;color:#2c5c39;line-height:1.55}" +
    "#onebox-root .addr{border:1px solid var(--amber);border-radius:5px;padding:8px;text-align:center;font-size:12.5px;font-weight:600;margin:0 0 14px;font-family:var(--content)}" +
    "#onebox-root .clock{display:flex;justify-content:center;gap:26px;margin:0 0 16px}" +
    "#onebox-root .clock div{text-align:center}" +
    "#onebox-root .clock b{display:block;font-size:26px;font-weight:700;line-height:1;font-variant-numeric:tabular-nums;letter-spacing:-.02em;font-family:var(--headline)}" +
    "#onebox-root .clock span{font-size:11px;color:var(--muted)}" +
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
    { k: "phone", q: "Phone Number", type: "tel", ph: "Phone Number" }
  ];
  var N = QUESTIONS.length;
  var state = { answers: {}, submitted: false };
  var qi = 0, phase = "survey";

  /* -- lead submission ------------------------------------------------
     Sends the finished survey into GHL so the contact is created and the
     sub-account's automations fire. Endpoint + payload are confirmed
     during the Ivan pilot (captured from the live survey's own submit);
     until then failures are logged, never shown to the lead.            */
  function submitLead() {
    if (state.submitted) return;
    state.submitted = true;
    var a = state.answers;
    var payload = {
      slug: C.slug || "",
      surveyId: C.surveyId || "",
      locationId: C.locationId || "",
      full_name: a.full_name || "",
      phone: a.phone || "",
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
      fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
        keepalive: true
      }).catch(function (e) { console.warn("[onebox] submit failed", e); });
    } catch (e) { console.warn("[onebox] submit failed", e); }
  }

  /* ------------------------------------------------------------------ */
  root.innerHTML =
    '<div class="topbar"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 2a7 7 0 0 0-7 7c0 5.25 7 13 7 13s7-7.75 7-13a7 7 0 0 0-7-7zm0 9.5A2.5 2.5 0 1 1 12 6.5a2.5 2.5 0 0 1 0 5z"/></svg><span>' + esc(ADDR) + "</span></div>" +
    '<div class="callbar">Call Us Today:' + (PHONE ? " " + esc(PHONE) : "") + "</div>" +
    '<div class="wrap">' +
    (LOGO ? '<img class="biglogo" src="' + esc(LOGO) + '" alt="' + esc(BIZ) + ' logo">' : "") +
    '<p class="lede">Congrats on claiming ' + (OFFERR ? esc(OFFERR) + " " : "") + "All Permanent Makeup Packages!</p>" +
    '<h1 class="page">Fill Out Our Quiz To See If You Qualify</h1>' +
    '<p class="sub">(30 Seconds)</p>' +
    '<div class="trust"><p>Trusted by 5,600+ Happy Clients</p><div class="stars">&#9733;&#9733;&#9733;&#9733;&#9733;</div></div>' +
    '<div class="box"><div class="rail"><span id="ob-rail">&nbsp;</span></div>' +
    '<div class="slide" id="ob-slide"></div><div class="bar" id="ob-bar"></div></div>' +
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
  var barEl = document.getElementById("ob-bar");

  function rail() {
    var wrap = railEl.parentNode;
    wrap.style.display = phase === "survey" ? "none" : "";
    if (phase === "survey") return;
    var pct, label;
    if (phase === "booking") { pct = 72; label = "You’re Almost Done…"; }
    else if (phase === "deposit") { pct = 88; label = "Last Step…"; }
    else { pct = 100; label = "100%"; }
    railEl.style.width = pct + "%";
    railEl.textContent = label;
  }

  function slideSurvey() {
    var q = QUESTIONS[qi];
    if (q.type) {
      return '<label class="qlabel" for="ob-f">' + esc(q.q) + ' <em>*</em></label>' +
        '<input class="field" id="ob-f" type="' + q.type + '" placeholder="' + esc(q.ph) + '" value="' +
        esc(state.answers[q.k] || "") + '" autocomplete="' + (q.k === "phone" ? "tel" : "name") + '"><p class="err" id="ob-err"></p>';
    }
    return '<p class="qlabel">' + esc(q.q) + ' <em>*</em></p><div class="opts">' +
      q.o.map(function (o) {
        return '<label class="opt"><input type="radio" name="ob-o" value="' + esc(o) + '"' +
          (state.answers[q.k] === o ? " checked" : "") + ">" + esc(o) + "</label>";
      }).join("") + '</div><p class="err" id="ob-err"></p>';
  }

  function slideBooking() {
    /* Real GHL calendar widget — the appointment books natively and fires
       the sub-account's appointment automations. Prefill uses the widget's
       own param names (first_name/last_name/phone) so the lead doesn't
       retype what the survey already captured. */
    var src = "https://api.leadconnectorhq.com/widget/booking/" + encodeURIComponent(CAL);
    var pre = [];
    var nm = (state.answers.full_name || "").split(/\s+/).filter(Boolean);
    if (nm.length) pre.push("first_name=" + encodeURIComponent(nm[0]));
    if (nm.length > 1) pre.push("last_name=" + encodeURIComponent(nm.slice(1).join(" ")));
    if (state.answers.phone) pre.push("phone=" + encodeURIComponent(state.answers.phone));
    if (pre.length) src += "?" + pre.join("&");
    return '<h2 class="phead">' + (OFFERR
      ? "Book Your Appointment NOW to Claim " + esc(OFFERR) + "."
      : "Book Your Appointment NOW!") + "</h2>" +
      (CAL ? '<iframe class="calframe" id="ob-cal" src="' + src + '" loading="lazy"></iframe>'
           : '<p class="psub">Calendar not configured for this account.</p>');
  }

  /* No skipping: the deposit step opens only when the calendar widget
     itself reports a completed booking (postMessage from the GHL widget). */
  window.addEventListener("message", function (ev) {
    if (phase !== "booking") return;
    if (!/leadconnectorhq\.com|msgsndr\.com|gohighlevel\.com/.test(ev.origin)) return;
    var s = "";
    try { s = JSON.stringify(ev.data); } catch (e) { s = String(ev.data); }
    if (/height|resize|dimension|scroll|loaded/i.test(s) && !/appointment|booked/i.test(s)) return;
    if (/appointment|booked|booking[-_ ]?(success|confirmed|complete)|confirmation/i.test(s)) {
      show("deposit");
    }
  });

  function slideDeposit() {
    return '<h2 class="phead">Last Step - ' + esc(DEPOSIT) + ' Refundable Reservation Fee</h2>' +
      '<p class="psub">&#9203; Slot is held for 10 min</p>' +
      '<div class="guarantee"><strong>100% Guaranteed &mdash; Fully Refundable</strong>' +
      "<p>After your free consultation, we&rsquo;ll apply your fee to your service &mdash; or refund it in full. Either way, you&rsquo;re 100% covered.</p></div>" +
      (ADDR ? '<div class="addr">' + esc(ADDR) + "</div>" : "") +
      '<div class="clock" id="ob-clock"></div>' +
      '<div class="fbslot" id="ob-fbslot"></div>';
  }

  function barHTML() {
    if (phase === "survey") {
      return '<button type="button" id="ob-prev"' + (qi === 0 ? " hidden" : "") + ">&larr; PREV</button>" +
        '<button type="button" id="ob-next">' + (qi === N - 1 ? "SUBMIT" : "NEXT") + " &rarr;</button>";
    }
    if (phase === "booking") return '<button type="button" id="ob-prev">&larr; PREV</button><span></span>';
    return '<button type="button" id="ob-prev">&larr; PREV</button><span></span>';
  }

  var timer = null, left = 600;
  function paintClock() {
    var el = document.getElementById("ob-clock");
    if (!el) return;
    var m = Math.floor(left / 60), s = left % 60;
    el.innerHTML = "<div><b>0</b><span>hours</span></div><div><b>" + m + "</b><span>minutes</span></div><div><b>" +
      String(s).padStart(2, "0") + "</b><span>seconds</span></div>";
  }

  function show(p, dir) {
    phase = p;
    if (timer && phase !== "deposit") { clearInterval(timer); timer = null; }
    slideEl.className = "slide";
    void slideEl.offsetWidth;
    slideEl.classList.add(dir === "prev" ? "anim-prev" : "anim-next");
    slideEl.innerHTML = phase === "survey" ? slideSurvey() : phase === "booking" ? slideBooking() : slideDeposit();
    barEl.innerHTML = barHTML();

    var prev = document.getElementById("ob-prev");
    if (prev) prev.onclick = function () {
      if (phase === "survey") { if (qi > 0) { qi--; show("survey", "prev"); } }
      else if (phase === "booking") { qi = N - 1; show("survey", "prev"); }
      else show("booking", "prev");
    };

    if (phase === "survey") bindSurvey();
    if (phase === "deposit") {
      left = 600; paintClock();
      if (timer) clearInterval(timer);
      timer = setInterval(function () {
        left--; if (left <= 0) { left = 0; clearInterval(timer); timer = null; }
        paintClock();
      }, 1000);
      /* move the page's (hidden) Fanbasis wrapper into the box */
      var slot = document.getElementById("ob-fbslot");
      var fb = document.querySelector(C.fanbasisSelector || "#fanbasis-checkout-wrapper");
      if (fb && slot) { slot.appendChild(fb); fb.style.display = ""; }
    }
    rail(); renderExtras();
    if (p !== "survey") { try { root.scrollIntoView({ behavior: "smooth", block: "start" }); } catch (e) {} }
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
      if (!val) { err.textContent = q.type ? q.q + " is required" : "Please choose an option to continue"; return; }
      if (q.k === "phone") {
        var digits = val.replace(/\D/g, "");
        if (digits.length === 11 && digits.charAt(0) === "1") digits = digits.slice(1);
        /* Real US number: 10 digits, area code + exchange can't start 0/1 —
           catches "1 + 9 digits" and other missing-digit variants. */
        if (!/^[2-9]\d{2}[2-9]\d{6}$/.test(digits)) {
          err.textContent = "Please enter a valid phone number"; return;
        }
      }
      state.answers[q.k] = val;
      advance();
    }
    document.getElementById("ob-next").onclick = submit;
    slideEl.querySelectorAll('input[name="ob-o"]').forEach(function (r) {
      r.onclick = function () {
        state.answers[QUESTIONS[qi].k] = r.value;
        setTimeout(advance, 250);
      };
    });
    slideEl.onkeydown = function (e) { if (e.key === "Enter") { e.preventDefault(); submit(); } };
    var f = document.getElementById("ob-f");
    if (f) f.focus();
  }

  /* stage-dependent sections: survey none; booking results+map+FAQs;
     deposit results+map. FAQs come from OB_FAQS (per-funnel, optional). */
  function renderExtras() {
    var el = document.getElementById("ob-extras");
    if (phase === "survey") { el.innerHTML = ""; return; }
    var handle = IGLINK.replace(/\/+$/, "").split("/").pop() || "instagram";
    var htmlStr = "";
    if (C.elfsightId) {
      htmlStr += '<div class="xsec"><h2 class="xhead">See Real Client Results &#128071;</h2>' +
        '<div class="elfsight-app-' + esc(C.elfsightId) + '" data-elfsight-app-lazy></div></div>';
      if (!document.querySelector('script[src*="elfsightcdn"]')) {
        var es = document.createElement("script");
        es.src = "https://elfsightcdn.com/platform.js"; es.async = true;
        document.head.appendChild(es);
      }
    } else if (RESULTS.length) {
      htmlStr += '<div class="xsec"><h2 class="xhead">See Real Client Results &#128071;</h2><div class="igcard">' +
        '<div class="ighead"><span class="avatar"><img src="' + esc(LOGO) + '" alt=""></span>' +
        '<span class="who"><b>' + esc(handle) + "</b><span>" + esc(BIZ) + "</span></span>" +
        (IGLINK ? '<a href="' + esc(IGLINK) + '" target="_blank" rel="noopener">Follow</a>' : "") + "</div>" +
        '<div class="results">' + RESULTS.map(function (u) {
          return '<img src="' + esc(u) + '" alt="Client result" loading="lazy">';
        }).join("") + "</div></div></div>";
    }
    htmlStr += '<div class="xsec"><h2 class="xhead">&#128205;We are located at ' + esc(ADDR) + "</h2>" +
      '<div class="mapcard"><iframe loading="lazy" src="https://www.google.com/maps?q=' +
      encodeURIComponent(ADDR) + '&output=embed"></iframe></div></div>';
    if (phase === "booking" && Array.isArray(window.OB_FAQS) && window.OB_FAQS.length) {
      htmlStr += '<div class="xsec"><h2 class="xhead">FAQs &#128071;</h2><div class="faqs">' +
        window.OB_FAQS.map(function (f) {
          return "<details><summary>" + esc(f.q) + '</summary><p class="fa">' + esc(f.a) + "</p></details>";
        }).join("") + "</div></div>";
    }
    el.innerHTML = htmlStr;
  }

  show("survey");
})();
