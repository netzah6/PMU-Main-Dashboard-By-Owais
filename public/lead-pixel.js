// Fires the Facebook "Lead" conversion event exactly once, waiting up to ~10s
// for the page's Meta Pixel to load first. Loaded by funnel booking pages via
// a Custom Code element:
//   <script src="https://pmu-main-dashboard-by-owais1.vercel.app/lead-pixel.js" async></script>
// GHL custom-code elements never execute INLINE scripts (and sanitize onerror
// handlers), but they do load external ones — which is why this file exists.
// No pixel ID here: window.fbq uses whatever pixel the client's page installed,
// so the same element works for every client and clones with the funnel template.
(function () {
  if (window.__pmuLeadFired) return; // never double-fire, even if loaded twice
  var tries = 0;
  (function fire() {
    if (window.fbq) {
      if (!window.__pmuLeadFired) {
        window.__pmuLeadFired = true;
        window.fbq("track", "Lead");
      }
    } else if (tries++ < 40) {
      setTimeout(fire, 250);
    }
  })();
})();
