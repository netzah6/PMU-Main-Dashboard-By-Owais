import type { MetadataRoute } from "next";

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "PMU Bookings — Master Dashboard",
    short_name: "PMU Dashboard",
    description: "PMU Bookings On Demand Master Dashboard",
    start_url: "/clients",
    display: "standalone",
    background_color: "#eef2f7",
    theme_color: "#15B7AE",
    icons: [
      { src: "/icon", sizes: "512x512", type: "image/png", purpose: "any" },
      { src: "/apple-icon", sizes: "180x180", type: "image/png" },
    ],
  };
}
