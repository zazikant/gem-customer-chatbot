import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";
import { Toaster } from "@/components/ui/toaster";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "GEM Customer Chatbot — LangGraph Live",
  description:
    "Conversational customer-support chatbot rebuilt on LangGraph: LeadCaptureGraph (LG1) → ChatGraph (LG2) with GLM-5.1 reducer and live SSE streaming.",
  keywords: [
    "LangGraph",
    "GLM-5.1",
    "Next.js",
    "RAG",
    "lead capture",
    "customer chatbot",
  ],
  authors: [{ name: "Shashikant Zarekar" }],
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body
        className={`${geistSans.variable} ${geistMono.variable} antialiased bg-background text-foreground`}
      >
        {children}
        <Toaster />
      </body>
    </html>
  );
}
