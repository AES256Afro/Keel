"use client";

import { useRouter } from "next/navigation";

interface TrashItem {
  id: string;
  title: string;
  icon: string | null;
  type: string;
  archivedAt: string;
}

export default function TrashList({
  items,
  readOnly = false,
}: {
  items: TrashItem[];
  readOnly?: boolean;
}) {
  const router = useRouter();

  const restore = async (id: string) => {
    await fetch(`/api/pages/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ archived: false }),
    });
    router.refresh();
  };

  const remove = async (id: string) => {
    if (!confirm("Delete this page permanently? This cannot be undone.")) return;
    await fetch(`/api/pages/${id}`, { method: "DELETE" });
    router.refresh();
  };

  return (
    <div className="max-w-3xl mx-auto px-8 py-12">
      <h1 className="text-2xl font-bold mb-1">🗑️ Trash</h1>
      <p className="text-sm text-[var(--muted)] mb-6">
        Pages in the trash can be restored or deleted permanently. Sub-pages are restored
        together with their parent.
      </p>
      <div className="divide-y divide-[var(--border-soft)] border border-[var(--border)] rounded-lg">
        {items.map((item) => (
          <div key={item.id} className="flex items-center gap-3 px-4 py-3">
            <span>{item.icon ?? (item.type === "database" ? "🗂️" : "📄")}</span>
            <div className="flex-1 min-w-0">
              <div className="text-sm truncate">{item.title}</div>
              <div className="text-xs text-[var(--faint)]">
                Trashed {new Date(item.archivedAt).toLocaleString()}
              </div>
            </div>
            {!readOnly && (
              <>
                <button
                  onClick={() => restore(item.id)}
                  className="text-sm text-[var(--link)] hover:underline"
                >
                  Restore
                </button>
                <button
                  onClick={() => remove(item.id)}
                  className="text-sm text-[var(--danger)] hover:underline"
                >
                  Delete forever
                </button>
              </>
            )}
          </div>
        ))}
        {items.length === 0 && (
          <p className="px-4 py-10 text-sm text-[var(--faint)] text-center">The trash is empty.</p>
        )}
      </div>
    </div>
  );
}
