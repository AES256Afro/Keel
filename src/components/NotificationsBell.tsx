"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";

interface NotificationDTO {
  id: string;
  message: string;
  pageId: string | null;
  read: boolean;
  createdAt: string;
}

export default function NotificationsBell({ initialUnread }: { initialUnread: number }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [unread, setUnread] = useState(initialUnread);
  const [items, setItems] = useState<NotificationDTO[]>([]);

  useEffect(() => {
    if (!open) return;
    const close = () => setOpen(false);
    window.addEventListener("click", close);
    return () => window.removeEventListener("click", close);
  }, [open]);

  const toggle = async () => {
    const next = !open;
    setOpen(next);
    if (next) {
      const res = await fetch("/api/notifications");
      if (res.ok) {
        const data = await res.json();
        setItems(data.notifications ?? []);
        if (data.unreadCount > 0) {
          await fetch("/api/notifications", { method: "POST" });
        }
        setUnread(0);
      }
    }
  };

  return (
    <div className="relative">
      <button
        aria-label="Notifications"
        title="Notifications"
        onClick={(e) => {
          e.stopPropagation();
          toggle();
        }}
        className="relative w-7 h-7 flex items-center justify-center rounded hover:bg-[var(--hover)] text-[var(--muted)]"
      >
        🔔
        {unread > 0 && (
          <span className="absolute -top-0.5 -right-0.5 min-w-4 h-4 px-0.5 rounded-full bg-[var(--danger)] text-white text-[9px] font-bold flex items-center justify-center">
            {unread > 9 ? "9+" : unread}
          </span>
        )}
      </button>
      {open && (
        <div
          onClick={(e) => e.stopPropagation()}
          className="absolute right-0 top-9 z-50 w-72 rounded-lg border border-[var(--border)] bg-[var(--elevated)] shadow-xl py-1 text-sm"
        >
          <div className="px-3 py-1.5 text-xs text-[var(--faint)] border-b border-[var(--border-soft)]">
            Notifications
          </div>
          <div className="max-h-72 overflow-y-auto">
            {items.map((n) => (
              <button
                key={n.id}
                onClick={() => {
                  setOpen(false);
                  if (n.pageId) router.push(`/p/${n.pageId}`);
                }}
                className={`w-full text-left px-3 py-2 hover:bg-[var(--hover)] ${
                  n.read ? "" : "font-medium"
                }`}
              >
                <span className="block truncate">{n.message}</span>
                <span className="block text-xs text-[var(--faint)]">
                  {new Date(n.createdAt).toLocaleString()}
                </span>
              </button>
            ))}
            {items.length === 0 && (
              <p className="px-3 py-4 text-[var(--faint)] text-center text-xs">
                Nothing yet. You’ll be notified when someone mentions you.
              </p>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
