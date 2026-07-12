import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Pessaro Bridge",
  description: "Puente TradingView → Supabase → MT4 (despachador manual)",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="es">
      <body>{children}</body>
    </html>
  );
}
