import Link from "next/link";
import type { Metadata } from "next";

import { getSiteSettingsStatus } from "@/lib/instance-settings";

export async function generateMetadata(): Promise<Metadata> {
  const site = await getSiteSettingsStatus();
  return {
    title: { default: site.name.value, template: `%s | ${site.name.value}` },
    description: site.tagline.value,
  };
}

export default async function SiteLayout({ children }: { children: React.ReactNode }) {
  const site = await getSiteSettingsStatus();
  const notesUrl = site.notesUrl.value;
  const siteName = site.name.value;
  return (
    <div className="min-h-screen bg-[var(--bg)] text-[var(--fg)]">
      <header className="border-b border-[var(--border)]">
        <nav className="max-w-5xl mx-auto px-6 h-14 flex items-center justify-between">
          <Link href="/" className="font-semibold tracking-tight">
            {siteName}
          </Link>
          <div className="flex items-center gap-5 text-sm">
            <Link href="/" className="text-[var(--muted)] hover:text-[var(--fg)]">
              Projects
            </Link>
            <Link href="/news" className="text-[var(--muted)] hover:text-[var(--fg)]">
              News
            </Link>
            <a
              href={notesUrl}
              className="rounded border border-[var(--border)] px-3 py-1.5 hover:bg-[var(--hover)]"
            >
              🔒 My Notes
            </a>
          </div>
        </nav>
      </header>
      <main className="max-w-5xl mx-auto px-6 py-10">{children}</main>
      <footer className="border-t border-[var(--border)] mt-16">
        <div className="max-w-5xl mx-auto px-6 py-6 text-xs text-[var(--faint)]">
          © {new Date().getFullYear()} {siteName}
        </div>
      </footer>
    </div>
  );
}
