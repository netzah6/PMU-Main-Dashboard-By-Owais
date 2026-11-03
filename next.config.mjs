/** @type {import('next').NextConfig} */
const nextConfig = {
  experimental: {
    /* The reel judge runs ffmpeg (static binary from ffmpeg-static) to take
       frames from inside each reel — ship the binary with that function. */
    outputFileTracingIncludes: {
      "/api/cron/ig-reels": ["./node_modules/ffmpeg-static/ffmpeg"],
      /* …and to fingerprint every saved picture (repeat check, 11/03/2026). */
      "/api/cron/ig-fetch": ["./node_modules/ffmpeg-static/ffmpeg"],
      "/api/onebox/ig-widget": ["./node_modules/ffmpeg-static/ffmpeg"],
      "/api/onboarding/[id]/setup": ["./node_modules/ffmpeg-static/ffmpeg"],
      "/api/agent/worker/finish": ["./node_modules/ffmpeg-static/ffmpeg"],
    },
  },
  async headers() {
    return [
      {
        /* The funnel engine is version-busted in the served HTML
           (onebox.js?v=NN bumps every engine deploy), so the file itself
           can cache forever — without this, every visitor re-validated
           it on the critical render path (the page body is empty until
           the engine runs). */
        source: "/onebox.js",
        headers: [
          { key: "Cache-Control", value: "public, max-age=31536000, immutable" },
        ],
      },
    ];
  },
};

export default nextConfig;
