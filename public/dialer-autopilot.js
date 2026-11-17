/* PMU Power Dialer — Autopilot for GHL Manual Actions.
 * Loaded by a bookmark while the rep is on GHL. It only presses GHL's own buttons:
 *   - "Let's Start" on the Manual Actions list
 *   - "Next" 10 s after a call that never connected (0 seconds)
 *   - "Send" on a text task, ONLY when the text box holds exactly the no-answer
 *     text the dashboard wrote for that lead (asked from the dashboard each time)
 * A call that connected (1 s or more) pauses the run and asks the rep:
 *   "We talked" → the lead is taken out of the dialer (no 2nd call, no text)
 *   "No answer" → carry on.
 * If "We talked" cannot be saved, the helper STOPS instead of moving on.
 * GHL facts this relies on (seen live 11/16/2026): buttons .redial-call-btn,
 * .next-call-btn, .pause-call-btn in the Call Summary; #conv-send-button-simple;
 * input[id^=composer-input-]; #manual-actions-let-start-button; ?manualId= in the URL.
 */
(function () {
  if (window.__pmuAutopilot) { window.__pmuAutopilot.show(); return; }
  var cfg = window.__pmuAutopilotCfg || {};
  try { delete window.__pmuAutopilotCfg; } catch (e) { window.__pmuAutopilotCfg = undefined; }
  if (!/\/v2\/location\//.test(location.pathname)) { alert("Open GHL first (Conversations → Manual Actions), then click Autopilot."); return; }
  var API = cfg.api || "", KEY = cfg.key || "";
  var GAP_MS = 10000;          // wait after a no-answer call before moving on
  var IDLE_STOP_MS = 180000;   // list empty this long → finished
  var REFRESH_MS = 8000;       // how often to reload an empty list
  var on = false, run = 0, busy = false, ask = null, st = {}, lastNext = null;
  var stats = { calls: 0, texts: 0, talked: 0 }, emptySince = 0, lastStart = 0, lastRefresh = 0, offListSince = 0, timers = [];

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
  function listLink() { return q("a").filter(function (a) { return vis(a) && /\/conversations\/manual_actions/.test(a.getAttribute("href") || ""); })[0] || null; }

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
        if (!sum.noAnswer || cfg.askAll) {         // connected (or unreadable) → never guess (askAll = test switch)
          ask = { id: id, cid: contactId(), secs: sum.secs };
          say(sum.secs > 0 ? "Call was " + sum.secs + "s. Did you talk to them?" : "Did you talk to them?"); render();
          return;
        }
        var left = GAP_MS - (now - s.sumAt);
        if (left <= 0) pressNext(id, sum, "No answer → next lead"); else say("No answer · next in " + Math.ceil(left / 1000) + "s");
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
      if (now - s.textAt >= 2000) { s.sent = true; stats.texts++; c.send.click(); say("Text sent → next lead"); }
      return;
    }
    if (onList()) {
      offListSince = 0;
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
    if (now - offListSince > 6000) { offListSince = now; var l = listLink(); if (l) l.click(); else say("Open Conversations → Manual Actions to continue"); }
  }
  function pressNext(id, sum, m) {
    var s = st[id] || (st[id] = { seen: Date.now(), clear: true, call: true });
    s.nexted = true; s.nextAt = Date.now(); lastNext = sum.next; sum.next.click(); say(m);
  }
  function refreshList() {            // GHL's list does not update by itself: leave the tab and come back
    var tab = q("a").filter(function (a) { return vis(a) && txt(a) === "Conversations" && /conversations\/conversations/.test(a.getAttribute("href") || ""); })[0];
    lastRefresh = Date.now();
    if (!tab || manualId()) return;
    busy = true; tab.click();
    var tries = 0, back = function () {
      if (manualId()) { busy = false; return; }
      var l = listLink();
      if (l) { l.click(); later(function () { busy = false; }, 2500); }
      else if (tries++ < 16) later(back, 500);
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
    else if (on) bar.appendChild(btn("■ Stop", "#dc2626", function () { halt("Stopped"); }));
    else bar.appendChild(btn("▶ Start", "#16a34a", start));
  }
  function start() {
    on = true; run++; emptySince = 0; offListSince = 0; lastStart = 0; say("Running"); render();
    if (!onList() && !manualId()) { var l = listLink(); if (l) l.click(); else { on = false; say("Open Conversations → Manual Actions, then press Start"); render(); } }
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
    state: function () { return { on: on, msg: msg, stats: stats, ask: ask, log: log }; }
  };
  if (cfg.autostart) start();
})();
