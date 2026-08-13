import Link from "next/link";

import { keelEnv } from "@/lib/env";

const NOTES_URL = keelEnv("NOTES_URL") ?? "/";
const SITE_NAME = keelEnv("SITE_NAME") ?? "My projects";

export default function SiteLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-screen bg-[var(--bg)] text-[var(--fg)]">
      <header className="border-b border-[var(--border)]">
        <nav className="max-w-5xl mx-auto px-6 h-14 flex items-center justify-between">
          <Link href="/" className="font-semibold tracking-tight">
            {SITE_NAME}
          </Link>
          <div className="flex items-center gap-5 text-sm">
            <Link href="/" className="text-[var(--muted)] hover:text-[var(--fg)]">
              Projects
            </Link>
            <Link href="/news" className="text-[var(--muted)] hover:text-[var(--fg)]">
              News
            </Link>
            <a
              href={NOTES_URL}
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
          © {new Date().getFullYear()} {SITE_NAME}
        </div>
      </footer>
    </div>
  );
}
