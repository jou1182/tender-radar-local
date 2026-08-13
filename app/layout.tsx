import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "رادار المنافسات | البحث والتحليل",
  description: "منصة محلية للبحث المتقدم في منافسات اعتماد وفرز أسعار الكراسات وتحليل قرارات المشاركة.",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="ar" dir="rtl"><body>{children}</body></html>;
}
