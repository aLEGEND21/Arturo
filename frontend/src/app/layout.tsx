import type { Metadata, Viewport } from "next";
import { Barlow, Barlow_Condensed } from "next/font/google";
import { Toaster } from "sonner";
import { Nav } from "@/components/nav";
import "./globals.css";

const barlow = Barlow({
  variable: "--font-barlow",
  weight: ["400", "500", "700"],
  subsets: ["latin"],
});

const barlowCondensed = Barlow_Condensed({
  variable: "--font-barlow-condensed",
  weight: ["400", "600"],
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "Arturo Dashboard",
  applicationName: "Arturo",
  description: "AI accountability assistant — task dashboard",
  // Home-screen name and standalone mode on iOS, which ignores most of the
  // manifest; the icon comes from app/apple-icon.png. Android reads the
  // manifest (app/manifest.ts) instead.
  appleWebApp: {
    capable: true,
    title: "Arturo",
    statusBarStyle: "default",
  },
  // `capable` above emits the modern mobile-web-app-capable tag, which iOS 17+
  // reads; older iOS only knows the apple- prefixed one.
  other: { "apple-mobile-web-app-capable": "yes" },
};

export const viewport: Viewport = {
  themeColor: "#f2f2f3",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html
      lang="en"
      className={`${barlow.variable} ${barlowCondensed.variable} h-full`}
    >
      <body className="flex min-h-full flex-col">
        <Nav />
        <main className="mx-auto w-full max-w-[1280px] flex-1">{children}</main>
        <Toaster position="bottom-right" toastOptions={{ style: { borderRadius: 0 } }} />
      </body>
    </html>
  );
}
