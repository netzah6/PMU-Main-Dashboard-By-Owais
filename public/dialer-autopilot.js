/* PMU Power Dialer — Autopilot for GHL Manual Actions.
 * Loaded by a bookmark while the rep is on GHL. It only presses GHL's own buttons:
 *   - "Let's Start" on the Manual Actions list
 *   - moves on 3 s after a call nobody picked up
 *   - "Send" on a text task, ONLY when the text box holds exactly the no-answer
 *     text the dashboard wrote for that lead (asked from the dashboard each time)
 * A call that connected (1 s or more) pauses the run and asks the rep:
 *   "We talked" → the lead is taken out of the dialer (no 2nd call, no text)
 *   "No answer" → carry on.
 * If "We talked" cannot be saved, the helper STOPS instead of moving on.
 * GHL facts this relies on (seen live 11/16/2026): buttons .redial-call-btn,
 * .next-call-btn, .pause-call-btn in the Call Summary; #conv-send-button-simple;
 * input[id^=composer-input-]; #manual-actions-let-start-button; ?manualId= in the URL.
 * OWN LEADS ONLY (11/23/2026): an admin's Manual Actions list shows EVERY rep's
 * tasks, and after the last task GHL drops the list filter. A test then dialed a
 * real lead of another rep. Now the list is always filtered to the rep whose key
 * this is (assignee = the GHL user id in the key) before "Let's Start" is pressed,
 * and a task that opens without that filter stops the helper at once.
 * GHL's own "Next" button can ALSO jump to a task outside the filter (seen
 * 11/23/2026: Next after a test call opened another rep's lead). So the helper
 * never presses GHL's Next: after a call it goes back to the rep's own filtered
 * list and presses "Let's Start" there (that one keeps the filter — checked live).
 * LISTENS TO THE CALL (owner, 11/24/2026: "hang up at the voicemail, call the
 * maximum amount of leads, never wait"). GHL's screen cannot tell ringing from
 * picked up: its timer and the "00 Min 44 Sec" in the summary both count the
 * ringing too (checked live on the owner's phone: summary 44 s, GHL log 12 s).
 * The sound can: while the phone rings the line carries the ring tone (440+480 Hz,
 * 2 s on / 4 s off — over 95% of the sound sits on those two notes), and any
 * other sound means somebody or something picked up. So the helper listens to
 * the lead's side of the call (never records, never sends it anywhere) and:
 *   - ring tone still SOUNDING after ~18 s     → hangs up (during the 4th ring), next lead in 3 s
 *   - ring tone stopped (7 s without it)       → somebody picked up, even if silent
 *   - picked up + talks ~6 s without a break
 *     while the rep says nothing (= voicemail?) → shows "Sounds like voicemail": ONE click on
 *     "Voicemail — next lead" hangs up. Not automatic: a person with a long greeting or a TV on
 *     sounds the same, and the owner's hard rule is never to hang up on a person (cfg.vmAuto = test switch)
 *   - a person picked up                       → NEVER hangs up
 *   - call over and the rep never spoke        → no answer, next lead in 3 s
 *   - both sides spoke                         → asks "Did you talk to them?"
 * If it cannot listen (no sound seen for a call) it behaves as before.
 * Softphone buttons seen live 11/24/2026: big panel "End Call" = button.end-call-button;
 * small top bar = div.cursor-pointer around svg.text-error-500; "Done" = button.end-call-btn.
 */
(function () {
  if (window.__pmuAutopilot) { window.__pmuAutopilot.show(); return; }
  var cfg = window.__pmuAutopilotCfg || {};
  try { delete window.__pmuAutopilotCfg; } catch (e) { window.__pmuAutopilotCfg = undefined; }
  if (!/\/v2\/location\//.test(location.pathname)) { alert("Open GHL first (Conversations → Manual Actions), then click Autopilot."); return; }
  var API = cfg.api || "", KEY = cfg.key || "";
  var ME = (/^([A-Za-z0-9]{10,40})\./.exec(KEY) || [])[1] || "";   // GHL user id the key was made for
  if (!ME) { alert("Autopilot key is missing. Copy the Autopilot button again from the dashboard (Sales → Dialer)."); return; }
  var keepWf = "";                                // a workflow filter the rep had when pressing Start
  var FILTER_WAIT_MS = 3500;                      // after re-filtering, let GHL reload the list first
  var GAP_MS = 3000;           // wait after a no-answer call before moving on (owner 11/23/2026: 10 s → 3 s, more calls per hour)
  var RING_MAX_MS = cfg.ringMax || 17000;   // after this, the next ring burst ends the call: in practice the 4th ring, about 18-20 s (before most voicemails start)
  var RING_GAP_MS = 7000;                   // the ring tone comes back every 6 s; longer silence = it stopped (picked up)
  var VM_MS = cfg.vmMs || 6000;             // other side talks this long without a break, rep silent → voicemail
  var IDLE_STOP_MS = 180000;   // list empty this long → finished
  var REFRESH_MS = 8000;       // how often to reload an empty list
  var on = false, run = 0, busy = false, ask = null, st = {}, lastNext = null;
  var stats = { calls: 0, texts: 0, talked: 0 }, emptySince = 0, lastStart = 0, lastRefresh = 0, offListSince = 0, lastFilter = 0, timers = [];

  var vis = function (e) { return !!(e && e.offsetParent !== null); };
  var txt = function (e) { return ((e && e.innerText) || "").replace(/\s+/g, " ").trim(); };
  var norm = function (s) { return String(s || "").replace(/\s+/g, " ").trim(); };
  var q = function (s) { return Array.prototype.slice.call(document.querySelectorAll(s)); };
  var manualId = function () { return new URLSearchParams(location.search).get("manualId") || ""; };
  var contactId = function () { var m = location.pathname.match(/contacts\/detail\/([A-Za-z0-9]+)/); return m ? m[1] : ""; };
  var onList = function () { return /\/conversations\/manual_actions/.test(location.pathname); };
  var later = function (fn, ms) { var r = run; timers.push(setTimeout(function () { if (r === run && on) fn(); }, ms)); };

  // ---- GHL elements -------------------------------------------------------
  function summary() {
    var next = q("button.next-call-btn").filter(vis)[0];
    if (!next) return null;
    var root = next, g = 0;
    while (root.parentElement && g++ < 10 && !/Call Summary/.test(txt(root))) root = root.parentElement;
    var t = txt(root), m = t.match(/(\d+)\s*Min\s*(\d+)\s*Sec/);
    // Status chip right after "Call Ended" (e.g. "Failed"). A failed call can show "00 Min 01 Sec" (seen 11/17/2026).
    var status = ((t.match(/Call Ended\s+(.*?)\s*\d+\s*Min/) || [])[1] || "").trim();
    var secs = m ? Number(m[1]) * 60 + Number(m[2]) : -1;
    return { next: next, pause: q("button.pause-call-btn").filter(vis)[0] || null, secs: secs,
      noAnswer: secs === 0 || (secs >= 0 && secs <= 3 && /^(Failed|No Answer|Busy|Cancel)/i.test(status)) };
  }
  function composer() {
    var send = document.getElementById("conv-send-button-simple");
    var input = q('input[id^="composer-input-"], textarea[id^="composer-input-"]').filter(vis)[0];
    if (!vis(send) || !input) return null;
    return { send: send, text: norm(input.value), ready: /^Send Message/.test(norm(send.getAttribute("aria-label"))) };  // "Sending message" = busy
  }
  function startBtn() { var b = document.getElementById("manual-actions-let-start-button"); return vis(b) && !b.disabled ? b : null; }
  function param(k) { return new URLSearchParams(location.search).get(k) || ""; }
  function mineOnly() { return param("assignee") === ME && (!keepWf || param("workflow") === keepWf); }
  function router() { var a = document.querySelector("#app, .app"); var v = a && a.__vue_app__; return v && v.config.globalProperties.$router; }
  function forceMine() {                          // filter the list to this rep's own tasks (no reload)
    var R = router(); if (!R) return false;
    var cr = R.currentRoute.value, qy = Object.assign({}, cr.query, { type: "workflow", assignee: ME });
    if (keepWf) qy.workflow = keepWf;
    R.replace({ path: cr.path, query: qy }); return true;
  }
  function hangUp() {                             // press the softphone's own hang-up; true if a button was found
    var b = q("button.end-call-button").filter(vis)[0];
    if (!b) {                                     // small top bar: red phone icon next to the call timer
      var sv = q("svg.text-error-500").filter(function (e) { return e.getBoundingClientRect().width > 0 && e.closest("div.cursor-pointer"); })[0];
      b = sv ? sv.closest("div.cursor-pointer") : null;
    }
    if (!b) b = q("button, [role=button]").filter(vis).filter(function (x) {
      if (/end-call-btn|next-call-btn|redial-call-btn|pause-call-btn/.test(x.className)) return false;
      return /end-call|hang-?up|call-end|disconnect/i.test(x.className + " " + (x.id || "")) || /^(end call|hang ?up)$/i.test(norm(x.getAttribute("aria-label") || x.title || ""));
    })[0];
    if (!b) return false;
    try { b.click(); } catch (e) { return false; }
    return true;
  }

  // ---- listening to the call ----------------------------------------------
  // One "ear" per call. Sound is only measured (loudness + how much of it is ring tone).
  var ear = null;
  function listen(pc, track) {
    var AC = window.AudioContext || window.webkitAudioContext; if (!AC) return;
    var ctx = window.__pmuActx || (window.__pmuActx = new AC());
    try { ctx.resume(); } catch (e) {}
    var e = { t0: Date.now(), mid: manualId(), cid: contactId(), rings: 0, lastTone: 0, pickAt: 0, voiceAt: 0, runStart: 0, lastVoice: 0, vN: 0, micMs: 0, micAll: 0, lastMic: 0, micSeen: false, replaced: false, heard: false, ended: false };
    ear = e;
    var tap = function (tr) {                     // Chrome only feeds a call's sound to an analyser if a media element plays it too
      var ms = new MediaStream([tr]), el = new Audio(); el.muted = true; el.srcObject = ms; var pl = el.play(); if (pl && pl.catch) pl.catch(function () {});
      var an = ctx.createAnalyser(); an.fftSize = 4096; an.smoothingTimeConstant = 0; var src = ctx.createMediaStreamSource(ms); src.connect(an);
      return { an: an, src: src, td: new Float32Array(an.fftSize), f: new Float32Array(an.frequencyBinCount), el: el };
    };
    var them = tap(track), me = null, hz = ctx.sampleRate / 4096;
    var rms = function (t) { t.an.getFloatTimeDomainData(t.td); var r = 0; for (var i = 0; i < t.td.length; i++) r += t.td[i] * t.td[i]; return Math.sqrt(r / t.td.length); };
    var iv = setInterval(function () {
      if (track.readyState === "ended" || ear !== e) {
        if (track.readyState !== "ended") e.replaced = true;   // another call's sound took over: do not judge this call by what we heard
        e.ended = true; clearInterval(iv);
        [them, me].forEach(function (t) { if (!t) return; try { t.src.disconnect(); } catch (x) {} try { t.el.pause(); t.el.srcObject = null; } catch (x) {} });
        return;
      }
      var now = Date.now(), r = rms(them);
      if (!me) { try { var sn = pc.getSenders().filter(function (x) { return x.track && x.track.kind === "audio"; })[0]; if (sn) me = tap(sn.track); } catch (x) {} }
      if (r > 0.0005) e.heard = true;
      if (r >= 0.003) {
        them.an.getFloatFrequencyData(them.f);
        var tot = 0, tone = 0;
        for (var k = Math.round(200 / hz); k < Math.round(3400 / hz); k++) { var p = Math.pow(10, them.f[k] / 10), fr = k * hz; tot += p; if (Math.abs(fr - 440) < 18 || Math.abs(fr - 480) < 18) tone += p; }
        if (tot > 0 && tone / tot > 0.6) { if (now - e.lastTone > 1500) e.rings++; e.lastTone = now; e.vN = 0; }
        else if (r > 0.01) {
          e.vN++;
          if (e.vN >= 2) {                        // two samples in a row: not a click on the line
            if (!e.voiceAt) { e.voiceAt = now; e.runStart = now; }
            else if (now - e.lastVoice > 900) e.runStart = now;   // a real pause: the unbroken talk starts over
            e.lastVoice = now;
          }
        } else e.vN = 0;
      } else e.vN = 0;
      // The ring tone stopped but the call is still on: somebody picked up, even if they say nothing yet
      // (live test 11/24/2026: the owner picked up and stayed quiet — that must never count as "still ringing").
      if (!e.pickAt && (e.voiceAt || (e.rings > 0 && now - e.lastTone > RING_GAP_MS))) e.pickAt = now;
      if (me) { var mr = rms(me); if (mr > 0.0002) e.micSeen = true; if (mr > 0.02) { e.micAll += 200; e.lastMic = now; if (e.pickAt) e.micMs += 200; } }   // micSeen: we really do hear the rep's side
    }, 200);
  }
  function earVoicemail(e, now) {                 // talks from the pickup on, no break, rep silent
    return e.rings > 0 && !(e.lastMic > e.lastTone) && !!e.voiceAt && e.runStart - e.voiceAt < 1200 && now - e.lastVoice < 900 && now - e.runStart >= VM_MS && e.micSeen && e.micMs < 600;
  }
  if (!window.__pmuPcHook && window.RTCPeerConnection) {      // once per page; later helper loads reuse it
    window.__pmuPcHook = true;
    var RealPC = window.RTCPeerConnection;
    var PC = function (a, b) {
      var pc = new RealPC(a, b);
      pc.addEventListener("track", function (ev) { try { if (ev.track && ev.track.kind === "audio" && window.__pmuOnTrack) window.__pmuOnTrack(pc, ev.track); } catch (x) {} });
      return pc;
    };
    PC.prototype = RealPC.prototype;
    Object.getOwnPropertyNames(RealPC).forEach(function (k) { try { if (!(k in PC)) PC[k] = RealPC[k]; } catch (x) {} });
    window.RTCPeerConnection = PC;
    if (window.webkitRTCPeerConnection) window.webkitRTCPeerConnection = PC;
  }
  window.__pmuOnTrack = function (pc, track) { try { listen(pc, track); } catch (x) {} };

  // ---- dashboard ----------------------------------------------------------
  function call(op, cid) {
    if (!API || !KEY || !cid) return Promise.resolve(null);
    return fetch(API + "/api/dialer/answered", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ key: KEY, contactId: cid, op: op }) })
      .then(function (r) { return r.json().catch(function () { return null; }); }).catch(function () { return null; });
  }
  function stopLead(cid) {      // one retry
    return call("stop", cid).then(function (j) { return j && j.ok ? true : call("stop", cid).then(function (k) { return !!(k && k.ok); }); });
  }

  // ---- main loop ----------------------------------------------------------
  function halt(m) { on = false; run++; busy = false; ask = null; say(m); render(); }
  function tick() {
    if (!on || busy) return;
    var id = manualId(), now = Date.now();
    if (ask) {                                      // waiting for the rep's answer
      if (!ask.stopping && (id !== ask.id || !summary())) halt("⚠ GHL moved on by itself. If you talked to the last lead, remove them from the dialer by hand. Then press Start.");
      return;
    }
    if (id) {
      emptySince = 0; offListSince = 0;
      if (!st[id] && param("assignee") && param("assignee") !== ME) { hangUp(); halt("⚠ This task is not yours — stopped. If a call started, hang up."); return; }
      if (!st[id] && !param("assignee") && !param("campaignId")) { hangUp(); halt("⚠ This task was opened without your own-leads filter — stopped. If a call started, hang up."); return; }
      if (!st[id]) st[id] = { seen: now, clear: false };
      var s = st[id], sum = summary();
      if (!sum) s.clear = true;
      if (sum && !s.call && !s.clear && (sum.next === lastNext || now - s.seen < 1500)) { say("Loading next lead…"); return; }  // last lead's summary still on screen
      if (sum) {                                    // a call just ended
        if (!s.call) {
          s.call = true; s.sumAt = now; stats.calls++;
          if (sum.pause) sum.pause.click();         // we do the timing, not GHL's 40 s countdown
        }
        if (s.nexted) { if (now - s.nextAt > 20000) say("Waiting for GHL… (if stuck, click Next)"); return; }
        if (s.quiet === undefined) {               // what the ear heard, decided once per call
          var e = s.ear;
          // nobody picked up (ring only), or something picked up and the rep never said a word (voicemail she hung up on)
          // (only trusted when we could hear the rep's microphone and the other side spoke for under 30 s)
          if (s.auto && s.sumAt - s.hungAt > 12000) s.auto = null;   // our hang-up did not end the call: judge by what we heard
          // "rep never spoke" counts her microphone over the WHOLE call (she may speak before we notice the pickup)
          s.quiet = !!s.auto || (!!e && !e.replaced && e.heard && e.micAll < 1000 && (!e.pickAt || (e.micSeen && (e.lastVoice || e.pickAt) - e.pickAt < 30000)));
        }
        if ((!sum.noAnswer && !s.quiet) || cfg.askAll) {   // both sides spoke (or we could not listen) → never guess (askAll = test switch)
          ask = { id: id, cid: contactId(), secs: sum.secs };
          say(sum.secs > 0 ? "Call was " + sum.secs + "s. Did you talk to them?" : "Did you talk to them?"); render();
          return;
        }
        var left = GAP_MS - (now - s.sumAt);
        var why = s.auto === "vm" ? "Voicemail" : "No answer";
        if (left <= 0) pressNext(id, sum, why + " → next lead"); else say(why + " · next in " + Math.ceil(left / 1000) + "s");
        return;
      }
      if (!s.ear && ear && !ear.ended && ear.t0 >= s.seen - 1000) s.ear = ear;   // this task's call
      if (s.ear && !s.ear.ended && !s.call) {       // call in progress: ringing / picked up
        var e2 = s.ear;
        if (s.hungAt) {                              // we pressed hang-up: wait for the summary
          if (now - s.hungAt > 5000 && !s.hung2) { s.hung2 = true; hangUp(); }
          if (now - s.hungAt > 10000) say("⚠ Could not hang up — please hang up yourself.");
          return;
        }
        // Past the limit, hang up only WHILE a ring burst is sounding (heard in the last 0.7 s): a person who
        // picked up in the quiet 4 s between two rings makes no ring tone, so they can never be cut off here.
        if (!e2.pickAt && e2.rings > 0 && now - e2.lastTone < 700 && now - e2.t0 > RING_MAX_MS) {
          if (hangUp()) { s.auto = "ring"; s.hungAt = now; say("No answer after " + Math.round((now - e2.t0) / 1000) + "s → hanging up"); }
          return;
        }
        if (earVoicemail(e2, now)) {                // a guess, so by default only a hint: the rep presses the button
          if (cfg.vmAuto) { if (hangUp()) { s.auto = "vm"; s.hungAt = now; say("Voicemail → hanging up"); } return; }
          if (s.live !== "vm") { s.live = "vm"; say("Sounds like voicemail — press Voicemail to skip"); render(); }
          return;
        }
        var live = e2.pickAt ? "picked" : "ring";
        if (s.live === "vm") return;
        if (s.live !== live) { s.live = live; say(e2.pickAt ? "Someone picked up" : "Ringing…"); render(); }
        return;
      }
      if (s.call || s.sent || s.blocked) return;    // call task (ringing / talking), or text already handled
      var c = composer();
      if (!c || !c.text || now - s.seen < 2500) return;
      if (s.want === undefined) {                   // ask the dashboard for this lead's text, once
        s.want = null; say("Checking the text…");
        var r = run, cid = contactId();
        call("text", cid).then(function (j) { if (r !== run) return; s.want = j && j.ok ? norm(j.text) : ""; });
        return;
      }
      if (s.want === null) return;
      if (!s.want || c.text !== s.want) { s.blocked = true; say("⚠ This text is not the one we wrote for this lead — NOT sent. Check it, then send or click Next yourself."); return; }
      if (!c.ready) return;
      if (!s.textAt) { s.textAt = now; say("Text ready · sending in 2s"); return; }
      if (now - s.textAt >= 2000) { s.sent = true; stats.texts++; c.send.click(); say("Text sent → next lead"); later(function () { if (manualId() === id) toMyList(); }, 3000); }
      return;
    }
    if (onList()) {
      offListSince = 0;
      if (!mineOnly()) {                            // never press Let's Start on someone else's list
        if (now - lastFilter > FILTER_WAIT_MS) { lastFilter = now; if (!forceMine()) { halt("⚠ Could not filter to your own leads. Pick your name in \"Select Assignee\", then press Start."); return; } }
        say("Showing only your leads…"); return;
      }
      if (now - lastFilter < FILTER_WAIT_MS) return;
      var b = startBtn();
      if (b) { if (now - lastStart > 4000) { lastStart = now; emptySince = 0; b.click(); say("Starting…"); } return; }
      if (now - lastStart < 6000) return;           // the task we just started is still opening
      if (!emptySince) emptySince = now;
      if (now - emptySince > IDLE_STOP_MS) { halt("List finished ✅"); return; }
      say("Waiting for the next task…");
      if (now - Math.max(lastRefresh, emptySince) > REFRESH_MS) refreshList();
      return;
    }
    // ON but neither on a task nor on the list (e.g. a refresh that did not come back)
    if (!offListSince) offListSince = now;
    if (now - offListSince > 6000) { offListSince = now; if (!toMyList()) say("Open Conversations → Manual Actions to continue"); }
  }
  function pressNext(id, sum, m) {    // NOT GHL's Next (it can leave the filter): back to own list → Let's Start
    var s = st[id] || (st[id] = { seen: Date.now(), clear: true, call: true });
    s.nexted = true; s.nextAt = Date.now(); lastNext = sum.next; say(m);
    if (!toMyList()) halt("⚠ Could not go back to your list. Open Manual Actions, then press Start.");
  }
  function toMyList() {
    var R = router(); if (!R) return false;
    var loc = (location.pathname.match(/^\/v2\/location\/[^/]+/) || [])[0]; if (!loc) return false;
    var qy = { type: "workflow", workflow: keepWf || "", campaign: "", assignee: ME };
    lastFilter = Date.now(); lastStart = Date.now();   // let the list load before Let's Start
    R.push({ path: loc + "/conversations/manual_actions", query: qy }); return true;
  }
  function refreshList() {            // GHL's list does not update by itself: leave the tab and come back
    var tab = q("a").filter(function (a) { return vis(a) && txt(a) === "Conversations" && /conversations\/conversations/.test(a.getAttribute("href") || ""); })[0];
    lastRefresh = Date.now();
    if (!tab || manualId()) return;
    busy = true; tab.click();
    var back = function () {
      if (manualId()) { busy = false; return; }
      if (toMyList()) { later(function () { busy = false; }, 2500); }   // back to OWN list, never the full one
      else busy = false;
    };
    later(back, 1500);
  }

  // ---- small bar ----------------------------------------------------------
  var bar = document.createElement("div");
  bar.id = "pmu-autopilot";
  bar.style.cssText = "position:fixed;left:16px;bottom:72px;z-index:2147483647;background:#111827;color:#fff;font:14px/1.3 system-ui,sans-serif;padding:10px 12px;border-radius:12px;box-shadow:0 6px 24px rgba(0,0,0,.35);display:flex;gap:10px;align-items:center;max-width:640px";
  var msg = "Ready", log = [];
  function btn(label, bg, fn) { var b = document.createElement("button"); b.textContent = label; b.style.cssText = "background:" + bg + ";color:#fff;border:0;border-radius:8px;padding:7px 12px;font:600 13px system-ui,sans-serif;cursor:pointer;white-space:nowrap"; b.onclick = fn; return b; }
  function say(m) { if (m !== msg) { msg = m; log.push(new Date().toTimeString().slice(0, 8) + " " + contactId().slice(0, 4) + " " + m); if (log.length > 400) log.shift(); render(); } }
  function render() {
    bar.innerHTML = "";
    bar.style.background = /^⚠/.test(msg) ? "#b91c1c" : "#111827";
    var t = document.createElement("div");
    t.textContent = "📞 Autopilot " + (on ? "ON" : "OFF") + " · " + msg + " · " + stats.calls + " calls, " + stats.texts + " texts";
    bar.appendChild(t);
    if (ask && !ask.stopping) {
      bar.appendChild(btn("✅ We talked — stop calling", "#16a34a", function () { answer(true); }));
      bar.appendChild(btn("No answer — keep going", "#4b5563", function () { answer(false); }));
    } else if (ask) { /* saving: no buttons */ }
    else if (on) {
      var cs = st[manualId()];
      if (cs && cs.ear && !cs.ear.ended && cs.ear.pickAt && !cs.hungAt && !cs.call) bar.appendChild(btn("📵 Voicemail — next lead", "#b45309", function () {
        if (hangUp()) { cs.auto = "vm"; cs.hungAt = Date.now(); say("Voicemail → hanging up"); }
      }));
      bar.appendChild(btn("■ Stop", "#dc2626", function () { halt("Stopped"); }));
    }
    else bar.appendChild(btn("▶ Start", "#16a34a", start));
  }
  function start() {
    if (onList() && param("assignee") === ME) keepWf = param("workflow");   // keep a workflow filter the rep chose
    on = true; run++; emptySince = 0; offListSince = 0; lastStart = 0; say("Running"); render();
    if (!onList() && !manualId()) { if (!toMyList()) { on = false; say("Open Conversations → Manual Actions, then press Start"); render(); } }
  }
  function answer(talked) {
    var a = ask, r = run;
    if (!a || a.stopping) return;
    var go = function (m) {
      ask = null;
      var sum = summary();
      if (manualId() === a.id && sum) pressNext(a.id, sum, m); else say(m);
      render();
    };
    if (!talked) { go("Next lead"); return; }
    a.stopping = true; stats.talked++; say("Stopping this lead…"); render();
    stopLead(a.cid).then(function (ok) {
      if (r !== run) return;
      if (ok) go("Lead stopped → next lead");
      else halt("⚠ Could not stop this lead. Remove them from the dialer workflow in GHL (or they get a 2nd call + text). Then press Start.");
    });
  }
  document.body.appendChild(bar);
  render();
  var timer = setInterval(tick, 500);
  window.__pmuAutopilot = {
    show: function () { bar.style.display = "flex"; },
    stop: function () { on = false; run++; clearInterval(timer); timers.forEach(clearTimeout); bar.remove(); delete window.__pmuAutopilot; },
    state: function () { return { on: on, msg: msg, stats: stats, ask: ask, log: log, ear: ear }; }
  };
  if (cfg.autostart) start();
})();
