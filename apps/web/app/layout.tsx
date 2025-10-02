import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Safepocket",
  description: "Personal finance intelligence with secure Plaid integration",
};

interface RootLayoutProps {
  children: React.ReactNode;
}

export default function RootLayout({ children }: RootLayoutProps) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
