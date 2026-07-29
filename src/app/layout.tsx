import type { Metadata } from "next";
import Link from "next/link";
import "./globals.css";

export const metadata: Metadata = {
  title: "chiapartment",
  description:
    "Real-time Chicago apartment pricing, with every listing placed in its building.",
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body className="min-h-full">
        <header className="sticky top-0 z-20 border-b border-ink-800 bg-ink-950/85 backdrop-blur">
          <div className="mx-auto flex h-14 max-w-[1600px] items-center gap-6 px-5">
            <Link href="/" className="group flex items-center gap-2.5">
              <span className="grid h-6 w-6 place-items-center rounded-sm bg-accent text-[13px] font-bold text-ink-950">
                ▲
              </span>
              <span className="text-[15px] font-semibold tracking-tight text-ink-100">
                chiapartment
              </span>
            </Link>
            <nav className="flex items-center gap-5 text-[13px] text-ink-400">
              <Link href="/" className="transition-colors hover:text-ink-100">
                Buildings
              </Link>
              <Link href="/compare" className="transition-colors hover:text-ink-100">
                Compare
              </Link>
            </nav>
          </div>
        </header>
        <main className="mx-auto max-w-[1600px] px-5 py-7">{children}</main>
      </body>
    </html>
  );
}
