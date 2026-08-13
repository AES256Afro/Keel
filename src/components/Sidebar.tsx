"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import type { PageTreeNode } from "@/lib/types";
import { localDayKey } from "@/lib/writing";
import SaveIndicator from "@/components/SaveIndicator";
import SearchDialog from "@/components/SearchDialog";
import KeelMark from "@/components/KeelMark";
import TemplatePicker from "@/components/TemplatePicker";
import NotificationsBell from "@/components/NotificationsBell";

interface Membership {
  id: string;
  name: string;
  role: string;
}

interface PageLink {
  id: string;
  title: string;
  icon: string | null;
  type: string;
}

function PageLinkList({
  label,
  pages,
  activeId,
}: {
  label: string;
  pages: PageLink[];
  activeId: string | null;
}) {
  if (pages.length === 0) return null;
  return (
    <div className="px-2 pt-2">
      <span className="px-0 text-xs font-medium text-[var(--faint)] uppercase tracking-wide">
        {label}
      </span>
      {pages.map((p) => (
        <Link
          key={p.id}
          href={`/p/${p.id}`}
          className={`flex items-center gap-1.5 rounded px-1 py-[3px] text-sm min-w-0 ${
            p.id === activeId ? "bg-[var(--hover)] font-medium" : "hover:bg-[var(--hover)]"
          }`}
        >
          <span className="shrink-0">
            {p.icon ?? (p.type === "database" ? "🗂️" : "📄")}
          </span>
          <span className="truncate text-[var(--fg)]">{p.title || "Untitled"}</span>
        </Link>
      ))}
    </div>
  );
}

/**
 * Send a tree action and come back with either its JSON or a sentence to show.
 *
 * The server's own message is used whenever it sent one: the whole point of a
 * restore refusal being a 400 that names the limit, rather than an opaque 500,
 * is that the sentence reaches the person who can act on it. A transport
 * failure carries no such message - "Failed to fetch" is not something to put
 * in front of anyone - so that falls back to the caller's plain wording.
 */
async function send<T>(
  url: string,
  init: RequestInit,
  fallback: string
): Promise<{ ok: true; data: T } | { ok: false; message: string }> {
  let res: Response;
  try {
    res = await fetch(url, init);
  } catch {
    return { ok: false, message: fallback };
  }
  const body = (await res.json().catch(() => null)) as { error?: unknown } | null;
  if (!res.ok) {
    const stated = typeof body?.error === "string" ? body.error.trim() : "";
    return { ok: false, message: stated || fallback };
  }
  return { ok: true, data: (body ?? {}) as T };
}

/** Attachments a restore (or duplicate) chose not to bring in, across reasons. */
function skippedCount(skipped: unknown): number {
  const s = skipped as { empty?: unknown; tooLarge?: unknown } | null | undefined;
  return (Number(s?.empty) || 0) + (Number(s?.tooLarge) || 0);
}

function TreeItem({
  node,
  depth,
  activeId,
  canEdit,
  onCreate,
  onMove,
  onDuplicate,
  onTrash,
}: {
  node: PageTreeNode;
  depth: number;
  activeId: string | null;
  canEdit: boolean;
  onCreate: (parentId: string | null, type: "document" | "database") => void;
  onMove: (pageId: string, parentId: string | null) => void;
  onDuplicate: (pageId: string) => void;
  onTrash: (pageId: string) => void;
}) {
  const [expanded, setExpanded] = useState(depth === 0);
  const [dragOver, setDragOver] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const isActive = node.id === activeId;

  useEffect(() => {
    if (!menuOpen) return;
    const close = () => setMenuOpen(false);
    window.addEventListener("click", close);
    return () => window.removeEventListener("click", close);
  }, [menuOpen]);

  return (
    <div>
      <div
        draggable={canEdit}
        onDragStart={(e) => {
          e.dataTransfer.setData("text/keel-page", node.id);
          e.stopPropagation();
        }}
        onDragOver={(e) => {
          if (canEdit && e.dataTransfer.types.includes("text/keel-page")) {
            e.preventDefault();
            setDragOver(true);
          }
        }}
        onDragLeave={() => setDragOver(false)}
        onDrop={(e) => {
          e.preventDefault();
          e.stopPropagation();
          setDragOver(false);
          const draggedId = e.dataTransfer.getData("text/keel-page");
          if (canEdit && draggedId && draggedId !== node.id) onMove(draggedId, node.id);
        }}
        className={`group relative flex items-center gap-1 rounded px-1 py-[3px] text-sm cursor-pointer select-none ${
          isActive ? "bg-[var(--hover)] font-medium" : "hover:bg-[var(--hover)]"
        } ${dragOver ? "ring-2 ring-blue-400" : ""}`}
        style={{ paddingLeft: 4 + depth * 14 }}
      >
        <button
          aria-label={expanded ? "Collapse" : "Expand"}
          onClick={(e) => {
            e.preventDefault();
            setExpanded((v) => !v);
          }}
          className="w-4 h-4 flex items-center justify-center text-[var(--faint)] hover:bg-[var(--hover)] rounded text-[10px] shrink-0"
        >
          {node.children.length > 0 ? (expanded ? "▾" : "▸") : "·"}
        </button>
        <Link href={`/p/${node.id}`} className="flex-1 truncate flex items-center gap-1.5 min-w-0">
          <span className="shrink-0">{node.icon ?? (node.type === "database" ? "🗂️" : "📄")}</span>
          <span className="truncate text-[var(--fg)]">{node.title || "Untitled"}</span>
        </Link>
        {canEdit && (
          <>
            <button
              aria-label="Page actions"
              title="Page actions"
              onClick={(e) => {
                e.stopPropagation();
                setMenuOpen((v) => !v);
              }}
              className="opacity-0 group-hover:opacity-100 w-5 h-5 flex items-center justify-center text-[var(--muted)] hover:bg-[var(--hover)] rounded shrink-0"
            >
              ⋯
            </button>
            <button
              aria-label="Add page inside"
              title="Add page inside"
              onClick={() => {
                setExpanded(true);
                onCreate(node.id, "document");
              }}
              className="opacity-0 group-hover:opacity-100 w-5 h-5 flex items-center justify-center text-[var(--muted)] hover:bg-[var(--hover)] rounded shrink-0"
            >
              +
            </button>
          </>
        )}
        {menuOpen && (
          <div className="absolute right-1 top-7 z-40 w-44 rounded-lg border border-[var(--border)] bg-[var(--elevated)] shadow-xl py-1 text-sm">
            <button
              onClick={() => {
                setMenuOpen(false);
                onDuplicate(node.id);
              }}
              className="w-full text-left px-3 py-1.5 hover:bg-[var(--hover)]"
            >
              ⧉ Duplicate
            </button>
            <button
              onClick={() => {
                setMenuOpen(false);
                setExpanded(true);
                onCreate(node.id, "database");
              }}
              className="w-full text-left px-3 py-1.5 hover:bg-[var(--hover)]"
            >
              🗂️ New database inside
            </button>
            <button
              onClick={() => {
                setMenuOpen(false);
                onTrash(node.id);
              }}
              className="w-full text-left px-3 py-1.5 hover:bg-[var(--hover)] text-[var(--danger)]"
            >
              🗑 Move to trash
            </button>
          </div>
        )}
      </div>
      {expanded &&
        node.children.map((child) => (
          <TreeItem
            key={child.id}
            node={child}
            depth={depth + 1}
            activeId={activeId}
            canEdit={canEdit}
            onCreate={onCreate}
            onMove={onMove}
            onDuplicate={onDuplicate}
            onTrash={onTrash}
          />
        ))}
    </div>
  );
}

export default function Sidebar({
  workspaceId,
  workspaceName,
  role,
  memberships,
  username,
  tree,
  favorites,
  recents,
  unreadNotifications,
  logoutAction,
  needsBackupSetup = false,
}: {
  workspaceId: string;
  workspaceName: string;
  role: string;
  memberships: Membership[];
  /** Public handle shown in the account menu  -  the real name never appears in the UI. */
  username: string;
  tree: PageTreeNode[];
  favorites: PageLink[];
  recents: PageLink[];
  unreadNotifications: number;
  logoutAction: () => Promise<void>;
  /** True when no off-machine backup is connected - shows a quiet nag dot. */
  needsBackupSetup?: boolean;
}) {
  const router = useRouter();
  const params = useParams<{ pageId?: string }>();
  const activeId = params?.pageId ?? null;
  const canEdit = role !== "viewer";
  const [searchOpen, setSearchOpen] = useState(false);
  const [templatesOpen, setTemplatesOpen] = useState(false);
  const [rootDragOver, setRootDragOver] = useState(false);
  const [accountOpen, setAccountOpen] = useState(false);
  const [switcherOpen, setSwitcherOpen] = useState(false);

  useEffect(() => {
    if (!accountOpen && !switcherOpen) return;
    const close = () => {
      setAccountOpen(false);
      setSwitcherOpen(false);
    };
    window.addEventListener("click", close);
    return () => window.removeEventListener("click", close);
  }, [accountOpen, switcherOpen]);

  /**
   * Every tree action here writes to the server and then acts as though it
   * agreed - duplicate navigates to the copy, trash walks away from the page.
   * They used to drop a refusal on the floor (`if (!res.ok) return`, or no
   * check at all), so a duplicate refused for storage said nothing at all and
   * the user just clicked again. Same contract as PageHeader: report the
   * failure, in the server's own words when it gave any, and offer the whole
   * action again.
   */
  const [actionError, setActionError] = useState<string | null>(null);
  const retryAction = useRef<() => void>(() => {});
  const actionFailed = useCallback((message: string, retry: () => void) => {
    retryAction.current = retry;
    setActionError(message);
  }, []);

  /**
   * Something landed but left part of itself behind - a duplicate whose
   * attachments were skipped. Not an error (the copy exists) and not silent
   * either, so it gets its own dismissible pill rather than the Try-again one.
   */
  const [warning, setWarning] = useState<string | null>(null);

  const createPage = useCallback(
    async (parentId: string | null, type: "document" | "database") => {
      const run = async (): Promise<void> => {
        const res = await send<{ page: { id: string } }>(
          "/api/pages",
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ parentPageId: parentId, type }),
          },
          "Couldn't create that page."
        );
        if (!res.ok) {
          actionFailed(res.message, () => void run());
          return;
        }
        setActionError(null);
        router.push(`/p/${res.data.page.id}`);
        router.refresh();
      };
      await run();
    },
    [router, actionFailed]
  );

  const movePage = useCallback(
    async (pageId: string, parentId: string | null) => {
      const run = async (): Promise<void> => {
        const res = await send<unknown>(
          `/api/pages/${pageId}`,
          {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ parentPageId: parentId }),
          },
          "Couldn't move that page."
        );
        if (!res.ok) {
          actionFailed(res.message, () => void run());
          return;
        }
        setActionError(null);
        router.refresh();
      };
      await run();
    },
    [router, actionFailed]
  );

  const duplicatePage = useCallback(
    async (pageId: string) => {
      const run = async (): Promise<void> => {
        const res = await send<{ pageId: string; skippedAttachments?: unknown }>(
          `/api/pages/${pageId}/duplicate`,
          { method: "POST" },
          "Couldn't duplicate this page."
        );
        if (!res.ok) {
          actionFailed(res.message, () => void run());
          return;
        }
        setActionError(null);
        // A skipped attachment is deliberately left out of the copy's id map,
        // so the copy keeps pointing at the ORIGINAL's row - it looks fine
        // until the original is deleted. Say so rather than let it look clean.
        const skipped = skippedCount(res.data.skippedAttachments);
        setWarning(
          skipped > 0
            ? `${skipped} attachment(s) were not copied into the duplicate - it still points at the original's files, which will break if the original is deleted.`
            : null
        );
        router.push(`/p/${res.data.pageId}`);
        router.refresh();
      };
      await run();
    },
    [router, actionFailed]
  );

  const trashPage = useCallback(
    async (pageId: string) => {
      const run = async (): Promise<void> => {
        const res = await send<unknown>(
          `/api/pages/${pageId}`,
          {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ archived: true }),
          },
          "Couldn't move that page to the trash."
        );
        if (!res.ok) {
          actionFailed(res.message, () => void run());
          return;
        }
        setActionError(null);
        // Only leave the page once the server agrees it's in the trash - walking
        // away from a failed PATCH is how a page looks deleted and isn't.
        if (pageId === activeId) router.push("/");
        router.refresh();
      };
      await run();
    },
    [router, activeId, actionFailed]
  );

  const switchWorkspace = async (id: string) => {
    setSwitcherOpen(false);
    if (id === workspaceId) return;
    await fetch("/api/workspace/switch", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ workspaceId: id }),
    });
    router.push("/");
    router.refresh();
  };

  return (
    <aside className="w-64 shrink-0 bg-[var(--panel)] border-r border-[var(--border)] flex flex-col">
      <div className="px-3 py-3 border-b border-[var(--border)] flex items-center gap-2">
        <div className="relative flex-1 min-w-0">
          <button
            onClick={(e) => {
              if (memberships.length <= 1) return;
              e.stopPropagation();
              setSwitcherOpen((v) => !v);
            }}
            title={workspaceName}
            className={`w-full text-left font-semibold text-sm truncate rounded px-1 -mx-1 ${
              memberships.length > 1 ? "hover:bg-[var(--hover)] cursor-pointer" : "cursor-default"
            }`}
          >
            <KeelMark size={16} className="mr-1.5" />
            {workspaceName}
            {memberships.length > 1 && <span className="text-[var(--faint)] ml-1">▾</span>}
          </button>
          {switcherOpen && (
            <div
              onClick={(e) => e.stopPropagation()}
              className="absolute left-0 top-8 z-50 w-56 rounded-lg border border-[var(--border)] bg-[var(--elevated)] shadow-xl py-1 text-sm"
            >
              <div className="px-3 py-1 text-[10px] uppercase tracking-wide text-[var(--faint)]">
                Workspaces
              </div>
              {memberships.map((m) => (
                <button
                  key={m.id}
                  onClick={() => switchWorkspace(m.id)}
                  className="w-full flex items-center gap-2 px-3 py-1.5 text-left hover:bg-[var(--hover)]"
                >
                  <span className="flex-1 truncate">{m.name}</span>
                  <span className="text-[10px] text-[var(--faint)] capitalize">{m.role}</span>
                  {m.id === workspaceId && <span className="text-xs">✓</span>}
                </button>
              ))}
            </div>
          )}
        </div>
        <NotificationsBell initialUnread={unreadNotifications} />
        <div className="relative shrink-0">
          <button
            aria-label="Account menu"
            title="Account"
            onClick={(e) => {
              e.stopPropagation();
              setAccountOpen((v) => !v);
            }}
            className="w-7 h-7 rounded-full bg-[var(--btn-bg)] text-[var(--btn-fg)] text-xs font-semibold flex items-center justify-center hover:opacity-90"
          >
            {(username[0] ?? "?").toUpperCase()}
          </button>
          {accountOpen && (
            <div
              onClick={(e) => e.stopPropagation()}
              className="absolute right-0 top-9 z-50 w-48 rounded-lg border border-[var(--border)] bg-[var(--elevated)] shadow-xl py-1 text-sm"
            >
              <div className="px-3 py-1.5 text-xs text-[var(--faint)] border-b border-[var(--border-soft)] truncate">
                @{username}
              </div>
              <Link
                href="/settings"
                onClick={() => setAccountOpen(false)}
                className="block px-3 py-1.5 hover:bg-[var(--hover)]"
              >
                ⚙️ Settings
              </Link>
              <form action={logoutAction}>
                <button className="w-full text-left px-3 py-1.5 hover:bg-[var(--hover)] text-[var(--muted)]">
                  ← Sign out
                </button>
              </form>
            </div>
          )}
        </div>
      </div>

      <div className="px-2 py-2 space-y-0.5 text-sm">
        <button
          onClick={() => setSearchOpen(true)}
          className="w-full flex items-center gap-2 rounded px-2 py-1 hover:bg-[var(--hover)] text-[var(--muted)]"
        >
          🔍 Search
          <span className="ml-auto text-[10px] text-[var(--faint)] border border-[var(--border)] rounded px-1">
            ⌘K
          </span>
        </button>
        {canEdit && (
          <button
            onClick={() => setTemplatesOpen(true)}
            className="w-full flex items-center gap-2 rounded px-2 py-1 hover:bg-[var(--hover)] text-[var(--muted)]"
          >
            📋 Templates
          </button>
        )}
        <Link
          href="/settings"
          className="w-full flex items-center gap-2 rounded px-2 py-1 hover:bg-[var(--hover)] text-[var(--muted)]"
        >
          ⚙️ Settings
        </Link>
        <Link
          href="/today"
          onClick={(e) => {
            // "Today" is a client-side fact - the server may sit in another
            // timezone. The href stays static (a date in it would make the
            // server and client render different HTML); the real date rides
            // along at click time instead.
            e.preventDefault();
            router.push(`/today?d=${localDayKey()}`);
          }}
          className="w-full flex items-center gap-2 rounded px-2 py-1 hover:bg-[var(--hover)] text-[var(--muted)]"
        >
          📅 Today
        </Link>
        <Link
          href="/graph"
          className="w-full flex items-center gap-2 rounded px-2 py-1 hover:bg-[var(--hover)] text-[var(--muted)]"
        >
          ◍ Graph
        </Link>
        <Link
          href="/setup"
          title={
            needsBackupSetup
              ? "Your notes have no off-machine backup yet - the guide takes a few minutes"
              : "Setup guide - everything optional, with breadcrumbs"
          }
          className="w-full flex items-center gap-2 rounded px-2 py-1 hover:bg-[var(--hover)] text-[var(--muted)]"
        >
          ✳ Setup
          {needsBackupSetup && (
            <span
              aria-label="needs attention"
              className="ml-auto h-2 w-2 rounded-full bg-[var(--danger)]"
            />
          )}
        </Link>
        <Link
          href="/tags"
          className="w-full flex items-center gap-2 rounded px-2 py-1 hover:bg-[var(--hover)] text-[var(--muted)]"
        >
          🏷️ Tags
        </Link>
        <Link
          href="/trash"
          className="w-full flex items-center gap-2 rounded px-2 py-1 hover:bg-[var(--hover)] text-[var(--muted)]"
        >
          🗑️ Trash
        </Link>
      </div>

      <PageLinkList label="Favorites" pages={favorites} activeId={activeId} />
      <PageLinkList label="Recent" pages={recents} activeId={activeId} />

      <div className="px-2 pt-2 pb-1 flex items-center justify-between">
        <span className="text-xs font-medium text-[var(--faint)] uppercase tracking-wide">Pages</span>
        {canEdit && (
          <div className="flex gap-1">
            <button
              title="New database"
              onClick={() => createPage(null, "database")}
              className="w-5 h-5 flex items-center justify-center text-[var(--muted)] hover:bg-[var(--hover)] rounded text-xs"
            >
              🗂️
            </button>
            <button
              title="New page"
              onClick={() => createPage(null, "document")}
              className="w-5 h-5 flex items-center justify-center text-[var(--muted)] hover:bg-[var(--hover)] rounded"
            >
              +
            </button>
          </div>
        )}
      </div>

      <nav className="flex-1 overflow-y-auto px-2 pb-2">
        {tree.map((node) => (
          <TreeItem
            key={node.id}
            node={node}
            depth={0}
            activeId={activeId}
            canEdit={canEdit}
            onCreate={createPage}
            onMove={movePage}
            onDuplicate={duplicatePage}
            onTrash={trashPage}
          />
        ))}
        {tree.length === 0 && (
          <p className="text-xs text-[var(--faint)] px-2 py-2">
            {canEdit ? "No pages yet. Create one above." : "No pages yet."}
          </p>
        )}
        {canEdit && (
          <div
            onDragOver={(e) => {
              if (e.dataTransfer.types.includes("text/keel-page")) {
                e.preventDefault();
                setRootDragOver(true);
              }
            }}
            onDragLeave={() => setRootDragOver(false)}
            onDrop={(e) => {
              e.preventDefault();
              setRootDragOver(false);
              const draggedId = e.dataTransfer.getData("text/keel-page");
              if (draggedId) movePage(draggedId, null);
            }}
            className={`mt-2 rounded border border-dashed px-2 py-2 text-[11px] text-[var(--faint)] text-center ${
              rootDragOver ? "border-blue-400 bg-[var(--hover)]" : "border-transparent"
            }`}
          >
            {rootDragOver ? "Move to top level" : "Drag a page here to move it to the top level"}
          </div>
        )}
      </nav>

      {/* Slot 3: the sidebar outlives the page beneath it, which may already be
          showing its own pills in slots 0-2 (content autosave, title, header
          action). Not cleared by Try again - only the action's own outcome
          clears it, so a retry that fails again leaves the warning standing. */}
      {actionError && (
        <SaveIndicator
          state="error"
          error={actionError}
          onRetry={() => retryAction.current()}
          slot={3}
          label="Action failed"
        />
      )}
      {/* Slot 4, stacked above the error pill by the same 44px step. Dismissed
          rather than retried: the copy exists, and running the duplicate again
          would only make a second one. */}
      {warning && (
        <div
          role="status"
          style={{ bottom: `${12 + 4 * 44}px` }}
          className="fixed right-4 z-40 flex max-w-sm items-center gap-2 rounded-lg border border-[var(--opt-yellow-fg)] bg-[var(--opt-yellow-bg)] px-3 py-2 text-xs text-[var(--opt-yellow-fg)] shadow-lg"
        >
          <span className="shrink-0">⚠</span>
          <span className="min-w-0 flex-1">{warning}</span>
          <button
            onClick={() => setWarning(null)}
            className="shrink-0 rounded border border-[var(--opt-yellow-fg)] px-2 py-0.5"
          >
            Dismiss
          </button>
        </div>
      )}

      <SearchDialog open={searchOpen} onClose={() => setSearchOpen(false)} />
      <TemplatePicker open={templatesOpen} onClose={() => setTemplatesOpen(false)} />
    </aside>
  );
}
