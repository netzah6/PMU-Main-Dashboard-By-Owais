/** @type {import('next').NextConfig} */
const nextConfig = {
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
