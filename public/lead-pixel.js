// Fires the Facebook "Lead" conversion event exactly once. Loaded by funnel
// booking pages via a Custom Code element:
//   <script src="https://pmu-main-dashboard-by-owais1.vercel.app/lead-pixel.js" async></script>
// GHL custom-code elements never execute INLINE scripts (and sanitize onerror
// handlers), but they do load external ones — which is why this file exists.
//
// Timing matters: GHL initializes the Meta Pixel LAZILY (~10s after load), and
// a track() call made before fbq('init') is processed gets silently dropped.
// So we wait until the pixel is demonstrably live — fbevents.js attached
// (fbq.callMethod) AND at least one event request actually sent to
// facebook.com/tr — before firing. Last-resort fallback fires anyway at ~60s.
// No pixel ID here: window.fbq uses whatever pixel the client's page
// installed, so the same element works for every client and clones with the
// funnel template.
(function () {
  if (window.__pmuLeadFired) return; // never double-fire, even if loaded twice
  var tries = 0;
  function send() {
    if (!window.__pmuLeadFired && window.fbq) {
      window.__pmuLeadFired = true;
      window.fbq("track", "Lead");
    }
  }
  function pixelLive() {
    try {
      if (!window.fbq || !window.fbq.callMethod) return false;
      return performance.getEntriesByType("resource").some(function (e) {
        return e.name.indexOf("facebook.com/tr") !== -1;
      });
    } catch (e) {
      return !!window.fbq;
    }
  }
  (function fire() {
    if (pixelLive()) send();
    else if (tries++ < 120) setTimeout(fire, 500);
    else send(); // pixel never proved itself — fire anyway as a last resort
  })();
})();
