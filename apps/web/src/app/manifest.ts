import type { MetadataRoute } from "next";

// Installable on the floor tablets (Chrome "Install app"); opens full-screen without browser UI.
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "Woolrus",
    short_name: "Woolrus",
    start_url: "/",
    display: "standalone",
    orientation: "any",
    background_color: "#1d232a",
    theme_color: "#1d232a",
    icons: [{ src: "/icon.svg", sizes: "any", type: "image/svg+xml" }],
  };
}
