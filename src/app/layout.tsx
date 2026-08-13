import type { Metadata } from "next";
import { cookies } from "next/headers";
import "./globals.css";

export const metadata: Metadata = {
  title: "Keel",
  description: "A Notion-like workspace for pages, blocks, and databases. No AI.",
};

// The theme preference lives in a cookie so the server can render the <html>
// attribute directly  -  no flash of the wrong theme and no inline bootstrap
// script (React 19 warns about script tags inside components).
export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const store = await cookies();
  const themeCookie = store.get("keel-theme")?.value;
  const theme = themeCookie === "dark" || themeCookie === "light" ? themeCookie : undefined;
  return (
    <html lang="en" data-theme={theme} suppressHydrationWarning>
      <body className="antialiased">{children}</body>
    </html>
  );
}
