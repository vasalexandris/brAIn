import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "brAIn",
  description: "Μια τεχνητή νοημοσύνη με συναισθήματα, χαρακτήρα και μνήμη που ξεχνά.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="el">
      <body>{children}</body>
    </html>
  );
}
