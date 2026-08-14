import { notFound } from "next/navigation";
import RichDoc from "@/components/RichDoc";
import KeelMark from "@/components/KeelMark";
import { resolvePageShare } from "@/lib/page-share";
import { clientIp, rateLimit, UNIDENTIFIED_IP } from "@/lib/rate-limit";

export const dynamic = "force-dynamic";

export default async function SharedPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const ip = await clientIp();
  if (ip !== UNIDENTIFIED_IP && !rateLimit(`public-page-share:${ip}`, 180, 60_000).ok) notFound();
  const share = await resolvePageShare(token);
  if (!share) notFound();

  const sharedImageSrc = (src: string) => {
    const match = /^\/api\/attachments\/([A-Za-z0-9_-]+)$/.exec(src);
    return match ? `/share/${token}/attachments/${match[1]}` : null;
  };

  return (
    <main className="min-h-screen bg-[var(--bg)] px-5 py-8 sm:px-8 sm:py-12">
      <article className="mx-auto max-w-3xl">
        <header className="mb-10 border-b border-[var(--border)] pb-6">
          <div className="mb-8 flex items-center gap-2 text-sm font-semibold text-[var(--muted)]">
            <KeelMark size={28} />
            Shared with Keel Notes
          </div>
          <div className="mb-3 text-5xl" aria-hidden="true">{share.page.icon ?? "📄"}</div>
          <h1 className="text-4xl font-bold tracking-tight sm:text-5xl">
            {share.page.title || "Untitled"}
          </h1>
          <p className="mt-3 text-xs text-[var(--faint)]">
            Read-only public link · updated {share.page.updatedAt.toLocaleDateString()}
          </p>
        </header>
        <div className="text-[var(--fg)]">
          <RichDoc content={share.page.content} imageSrc={sharedImageSrc} />
        </div>
        <footer className="mt-14 border-t border-[var(--border)] pt-5 text-xs text-[var(--faint)]">
          This link can be revoked by the workspace owner at any time.
        </footer>
      </article>
    </main>
  );
}
