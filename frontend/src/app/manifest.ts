import type { MetadataRoute } from "next";

// Web app manifest for "Add to Home Screen" on Android and iOS. The icons are
// copies of app/icon.png (the favicon) at the sizes installers want; keep them
// in sync if the favicon changes. The glyph sits well inside the 80% safe
// zone, so the same file doubles as the maskable icon Android crops.
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "Arturo",
    short_name: "Arturo",
    description: "AI accountability assistant — task dashboard",
    start_url: "/",
    display: "standalone",
    background_color: "#f7f7f7",
    theme_color: "#f2f2f3",
    icons: [
      { src: "/icons/icon-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
      { src: "/icons/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
      { src: "/icons/icon-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
    ],
  };
}
