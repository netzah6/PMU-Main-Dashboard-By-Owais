// Fires the Facebook "Lead" conversion event IMMEDIATELY on page load, exactly
// once. Loaded by funnel booking/thank-you pages via a Custom Code element:
//   <script src="https://pmu-main-dashboard-by-owais1.vercel.app/lead-pixel.js" async></script>
// GHL custom-code elements never execute INLINE scripts (and sanitize onerror
// handlers), but they do load external ones — which is why this file exists.
//
// GHL initializes the Meta Pixel LAZILY (~10s after load), and quick bounces
// would never be counted if we waited for it. So this script doesn't wait: it
// reads the pixel ID out of the page's own tracking config, installs the
// standard fbq stub itself, loads fbevents.js, inits, and fires Lead — all
// within ~1s of landing. GHL's own init later is a harmless duplicate (Meta
// ignores repeat inits of the same pixel ID), and PageView still comes from
// GHL's code as usual. No hardcoded pixel ID — works for every client and
// clones with the funnel template.
//
// DEDUPE: pages whose GHL tracking settings ALSO fire a Lead (~10s in) would
// otherwise double-count — Meta Pixel Helper shows "Lead ×2". After our early
// Lead fires, window.fbq is swapped for a same-shape wrapper that drops any
// further ("track", "Lead") calls on this page view and passes everything else
// (init, PageView, customs) straight through. fbevents.js treats the wrapper
// exactly like the standard stub, whether it loads before or after the swap.
(function () {
  if (window.__pmuLeadFired) return; // never double-fire, even if loaded twice

  // Once our Lead is out, silently swallow any later Lead fired by GHL's own
  // delayed tracking (~10s in) so each page view counts exactly one Lead.
  //
  // GHL's runtime captures its own PRIVATE reference to the fbq stub before
  // this script runs, so swapping window.fbq alone can't intercept its calls
  // (verified live). Every fbq invocation, through any reference, routes via
  // the stub object's .callMethod once fbevents.js is active — so the filter
  // is patched onto callMethod itself, on the original object AND window.fbq,
  // re-checked for 30s in case fbevents (re)attaches it later.
  function isLeadCall(args) {
    if (String(args[0]).indexOf("track") !== 0) return false; // track / trackSingle / trackCustom…
    for (var i = 1; i < args.length; i++) if (args[i] === "Lead") return true;
    return false;
  }

  function installLeadFilter() {
    var orig = window.fbq;
    if (!orig) return;
    function patch(target) {
      if (target && target.callMethod && !target.callMethod.__pmuFiltered) {
        var real = target.callMethod;
        var filtered = function () {
          if (isLeadCall(arguments)) return;
          return real.apply(this, arguments);
        };
        filtered.__pmuFiltered = true;
        target.callMethod = filtered;
      }
    }
    patch(orig);
    patch(window.fbq);
    var tries = 0;
    var timer = setInterval(function () {
      patch(orig);
      patch(window.fbq);
      if (++tries > 100) clearInterval(timer);
    }, 300);
  }

  function send() {
    if (!window.__pmuLeadFired && window.fbq) {
      window.__pmuLeadFired = true;
      window.fbq("track", "Lead");
      installLeadFilter();
    }
  }

  // The page embeds its tracking code (with the client's pixel ID) in the
  // HTML/config — grab the ID from wherever it appears, escaped or not.
  function findPixelId() {
    try {
      var html = document.documentElement.innerHTML;
      var m = html.match(/fbq\(\s*\\?['"]init\\?['"]\s*,\s*\\?['"](\d{8,20})\\?['"]/);
      return m ? m[1] : null;
    } catch (e) { return null; }
  }

  // Standard Meta Pixel base bootstrap (same as FB's official snippet): create
  // the fbq stub if the page hasn't yet, and load fbevents.js.
  function ensureFbq() {
    if (window.fbq) return;
    var n = (window.fbq = function () {
      n.callMethod ? n.callMethod.apply(n, arguments) : n.queue.push(arguments);
    });
    if (!window._fbq) window._fbq = n;
    n.push = n;
    n.loaded = true;
    n.version = "2.0";
    n.queue = [];
    var t = document.createElement("script");
    t.async = true;
    t.src = "https://connect.facebook.net/en_US/fbevents.js";
    var s = document.getElementsByTagName("script")[0];
    if (s && s.parentNode) s.parentNode.insertBefore(t, s);
    else document.head.appendChild(t);
  }

  var pixelId = findPixelId();
  if (pixelId) {
    ensureFbq();
    window.fbq("init", pixelId);
    send(); // queued if fbevents.js is still downloading — flushes on arrival
  } else {
    // No pixel ID found in the page — fall back to waiting for GHL's pixel.
    var tries = 0;
    (function fire() {
      if (window.fbq && window.fbq.callMethod) send();
      else if (tries++ < 120) setTimeout(fire, 500);
      else send();
    })();
  }
})();
