import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Sonora — Open music, your library",
  description: "A Sonora music experience powered by YouTube discovery and embedded playback.",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="en"><body>{children}</body></html>;
}
