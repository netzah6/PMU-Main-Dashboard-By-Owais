// Fires the Facebook "Lead" conversion event IMMEDIATELY on page load, exactly
// once. Loaded by funnel booking pages via a Custom Code element:
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
(function () {
  if (window.__pmuLeadFired) return; // never double-fire, even if loaded twice

  function send() {
    if (!window.__pmuLeadFired && window.fbq) {
      window.__pmuLeadFired = true;
      window.fbq("track", "Lead");
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
