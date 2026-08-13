"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

interface ProjectDTO {
  id: string;
  title: string;
  description: string;
  url: string | null;
  repoUrl: string | null;
  tags: string[];
  featured: boolean;
  published: boolean;
}

interface NewsDTO {
  id: string;
  title: string;
  slug: string;
  excerpt: string;
  body: string;
  published: boolean;
}

const emptyProject = {
  id: "",
  title: "",
  description: "",
  url: "",
  repoUrl: "",
  tags: "",
  featured: false,
  published: true,
};
const emptyNews = { id: "", title: "", excerpt: "", body: "", published: false };

const input =
  "w-full rounded border border-[var(--border)] bg-[var(--elevated)] px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500";
const btn =
  "rounded bg-[var(--btn-bg)] text-[var(--btn-fg)] px-4 py-2 text-sm font-medium hover:bg-[var(--btn-hover)] disabled:opacity-50";
const ghost = "rounded border border-[var(--border)] px-3 py-1.5 text-sm hover:bg-[var(--hover)]";

export default function AdminClient({
  projects: initialProjects,
  news: initialNews,
  notesUrl,
}: {
  projects: ProjectDTO[];
  news: NewsDTO[];
  notesUrl: string;
}) {
  const router = useRouter();
  const [tab, setTab] = useState<"projects" | "news">("projects");
  const [projects, setProjects] = useState(initialProjects);
  const [news, setNews] = useState(initialNews);
  const [msg, setMsg] = useState<{ kind: "ok" | "error"; text: string } | null>(null);
  const [busy, setBusy] = useState(false);

  const [pForm, setPForm] = useState({ ...emptyProject });
  const [nForm, setNForm] = useState({ ...emptyNews });
  const [ghUser, setGhUser] = useState("");
  const [ghToken, setGhToken] = useState("");

  const say = (kind: "ok" | "error", text: string) => setMsg({ kind, text });

  const api = async (url: string, method: string, body?: unknown) => {
    setBusy(true);
    setMsg(null);
    const res = await fetch(url, {
      method,
      headers: body ? { "Content-Type": "application/json" } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    });
    setBusy(false);
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      say("error", data.error ?? "Something went wrong");
      return null;
    }
    return data;
  };

  // ---- Projects ----
  const saveProject = async () => {
    const payload = {
      title: pForm.title,
      description: pForm.description,
      url: pForm.url || null,
      repoUrl: pForm.repoUrl || null,
      tags: pForm.tags.split(",").map((t) => t.trim()).filter(Boolean),
      featured: pForm.featured,
      published: pForm.published,
    };
    const data = pForm.id
      ? await api(`/api/admin/projects/${pForm.id}`, "PATCH", payload)
      : await api("/api/admin/projects", "POST", payload);
    if (!data) return;
    setPForm({ ...emptyProject });
    say("ok", pForm.id ? "Project updated." : "Project added.");
    router.refresh();
    await refreshProjects();
  };

  const refreshProjects = async () => {
    const list = await api("/api/admin/projects", "GET");
    if (list?.projects)
      setProjects(
        list.projects.map((p: ProjectDTO & { tags: string | null }) => ({
          ...p,
          tags: safeTags(p.tags),
        }))
      );
  };

  const importGithub = async () => {
    const data = await api("/api/admin/projects/import", "POST", {
      username: ghUser.trim(),
      token: ghToken.trim() || undefined,
    });
    if (!data) return;
    setGhToken("");
    say("ok", `Imported ${data.imported} new project(s) as drafts (scanned ${data.scanned}).`);
    await refreshProjects();
    router.refresh();
  };

  const editProject = (p: ProjectDTO) =>
    setPForm({
      id: p.id,
      title: p.title,
      description: p.description,
      url: p.url ?? "",
      repoUrl: p.repoUrl ?? "",
      tags: p.tags.join(", "),
      featured: p.featured,
      published: p.published,
    });

  const deleteProject = async (id: string) => {
    if (!confirm("Delete this project?")) return;
    if (await api(`/api/admin/projects/${id}`, "DELETE")) {
      setProjects(projects.filter((p) => p.id !== id));
      if (pForm.id === id) setPForm({ ...emptyProject });
    }
  };

  const toggleProject = async (p: ProjectDTO, field: "featured" | "published") => {
    const data = await api(`/api/admin/projects/${p.id}`, "PATCH", { [field]: !p[field] });
    if (data)
      setProjects(projects.map((x) => (x.id === p.id ? { ...x, [field]: !p[field] } : x)));
  };

  // ---- News ----
  const saveNews = async () => {
    const payload = {
      title: nForm.title,
      excerpt: nForm.excerpt,
      body: nForm.body,
      published: nForm.published,
    };
    const data = nForm.id
      ? await api(`/api/admin/news/${nForm.id}`, "PATCH", payload)
      : await api("/api/admin/news", "POST", payload);
    if (!data) return;
    setNForm({ ...emptyNews });
    say("ok", nForm.id ? "Post updated." : "Post added.");
    router.refresh();
    const list = await api("/api/admin/news", "GET");
    if (list?.news) setNews(list.news);
  };

  const editNews = (n: NewsDTO) =>
    setNForm({
      id: n.id,
      title: n.title,
      excerpt: n.excerpt,
      body: n.body,
      published: n.published,
    });

  const deleteNews = async (id: string) => {
    if (!confirm("Delete this post?")) return;
    if (await api(`/api/admin/news/${id}`, "DELETE")) {
      setNews(news.filter((n) => n.id !== id));
      if (nForm.id === id) setNForm({ ...emptyNews });
    }
  };

  const toggleNewsPublished = async (n: NewsDTO) => {
    const data = await api(`/api/admin/news/${n.id}`, "PATCH", { published: !n.published });
    if (data) setNews(news.map((x) => (x.id === n.id ? { ...x, published: !n.published } : x)));
  };

  return (
    <div className="max-w-3xl mx-auto px-6 py-10">
      <div className="flex items-center justify-between mb-6">
        <h1 className="text-2xl font-bold">Admin</h1>
        <a href={notesUrl} className={ghost}>
          🔒 My Notes
        </a>
      </div>

      {msg && (
        <div
          className={`mb-4 rounded border px-4 py-2 text-sm ${
            msg.kind === "ok"
              ? "border-[var(--border)] bg-[var(--panel)]"
              : "border-[var(--danger-border)] bg-[var(--danger-bg)] text-[var(--danger)]"
          }`}
        >
          {msg.text}
        </div>
      )}

      <div className="flex gap-2 mb-6">
        {(["projects", "news"] as const).map((t) => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className={`rounded px-3 py-1.5 text-sm capitalize ${
              tab === t ? "bg-[var(--btn-bg)] text-[var(--btn-fg)]" : "hover:bg-[var(--hover)]"
            }`}
          >
            {t}
          </button>
        ))}
      </div>

      {tab === "projects" ? (
        <div className="space-y-6">
          <section className="rounded-lg border border-[var(--border)] p-4 space-y-3">
            <h2 className="font-semibold">Import from GitHub</h2>
            <p className="text-xs text-[var(--muted)]">
              Pulls repos in as <strong>drafts</strong> to review, then publish. A token
              (or the <code>GITHUB_TOKEN</code> env) imports your private repos too;
              otherwise it lists a username&apos;s public repos.
            </p>
            <div className="flex flex-wrap items-center gap-2">
              <input
                className={`${input} flex-1 min-w-40`}
                placeholder="GitHub username"
                value={ghUser}
                onChange={(e) => setGhUser(e.target.value)}
              />
              <input
                className={`${input} flex-1 min-w-40`}
                type="password"
                placeholder="Token (optional, for private repos)"
                value={ghToken}
                onChange={(e) => setGhToken(e.target.value)}
              />
              <button
                onClick={importGithub}
                disabled={busy || (!ghUser.trim() && !ghToken.trim())}
                className={ghost}
              >
                Import
              </button>
            </div>
          </section>

          <section className="rounded-lg border border-[var(--border)] p-4 space-y-3">
            <h2 className="font-semibold">{pForm.id ? "Edit project" : "Add project"}</h2>
            <input
              className={input}
              placeholder="Title"
              value={pForm.title}
              onChange={(e) => setPForm({ ...pForm, title: e.target.value })}
            />
            <textarea
              className={input}
              placeholder="Description"
              rows={2}
              value={pForm.description}
              onChange={(e) => setPForm({ ...pForm, description: e.target.value })}
            />
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <input
                className={input}
                placeholder="Live URL (https://…)"
                value={pForm.url}
                onChange={(e) => setPForm({ ...pForm, url: e.target.value })}
              />
              <input
                className={input}
                placeholder="Repo URL (https://github.com/…)"
                value={pForm.repoUrl}
                onChange={(e) => setPForm({ ...pForm, repoUrl: e.target.value })}
              />
            </div>
            <input
              className={input}
              placeholder="Tags (comma separated)"
              value={pForm.tags}
              onChange={(e) => setPForm({ ...pForm, tags: e.target.value })}
            />
            <div className="flex flex-wrap items-center gap-4">
              <label className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  className="h-4 w-4 accent-blue-600"
                  checked={pForm.featured}
                  onChange={(e) => setPForm({ ...pForm, featured: e.target.checked })}
                />
                Featured
              </label>
              <label className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  className="h-4 w-4 accent-blue-600"
                  checked={pForm.published}
                  onChange={(e) => setPForm({ ...pForm, published: e.target.checked })}
                />
                Published
              </label>
              <div className="ml-auto flex gap-2">
                {pForm.id && (
                  <button onClick={() => setPForm({ ...emptyProject })} className={ghost}>
                    Cancel
                  </button>
                )}
                <button onClick={saveProject} disabled={busy || !pForm.title.trim()} className={btn}>
                  {pForm.id ? "Save" : "Add"}
                </button>
              </div>
            </div>
          </section>

          <ul className="divide-y divide-[var(--border-soft)] rounded-lg border border-[var(--border)]">
            {projects.length === 0 && (
              <li className="px-4 py-3 text-sm text-[var(--faint)]">No projects yet.</li>
            )}
            {projects.map((p) => (
              <li key={p.id} className="flex items-center gap-3 px-4 py-3 text-sm">
                <span className="min-w-0 flex-1">
                  <span className="block truncate font-medium">
                    {p.title}
                    {!p.published && (
                      <span className="ml-2 text-xs text-[var(--faint)]">(draft)</span>
                    )}
                  </span>
                  {p.description && (
                    <span className="block truncate text-xs text-[var(--muted)]">
                      {p.description}
                    </span>
                  )}
                </span>
                <button onClick={() => toggleProject(p, "featured")} className={ghost} title="Feature">
                  {p.featured ? "★" : "☆"}
                </button>
                <button onClick={() => toggleProject(p, "published")} className={ghost}>
                  {p.published ? "Unpublish" : "Publish"}
                </button>
                <button onClick={() => editProject(p)} className={ghost}>
                  Edit
                </button>
                <button
                  onClick={() => deleteProject(p.id)}
                  className="text-xs text-[var(--danger)] hover:underline"
                >
                  Delete
                </button>
              </li>
            ))}
          </ul>
        </div>
      ) : (
        <div className="space-y-6">
          <section className="rounded-lg border border-[var(--border)] p-4 space-y-3">
            <h2 className="font-semibold">{nForm.id ? "Edit post" : "New post"}</h2>
            <input
              className={input}
              placeholder="Title"
              value={nForm.title}
              onChange={(e) => setNForm({ ...nForm, title: e.target.value })}
            />
            <input
              className={input}
              placeholder="Excerpt (one-line summary)"
              value={nForm.excerpt}
              onChange={(e) => setNForm({ ...nForm, excerpt: e.target.value })}
            />
            <textarea
              className={`${input} font-mono`}
              placeholder="Body - plain text; blank lines separate paragraphs, URLs become links"
              rows={8}
              value={nForm.body}
              onChange={(e) => setNForm({ ...nForm, body: e.target.value })}
            />
            <div className="flex items-center gap-4">
              <label className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  className="h-4 w-4 accent-blue-600"
                  checked={nForm.published}
                  onChange={(e) => setNForm({ ...nForm, published: e.target.checked })}
                />
                Published
              </label>
              <div className="ml-auto flex gap-2">
                {nForm.id && (
                  <button onClick={() => setNForm({ ...emptyNews })} className={ghost}>
                    Cancel
                  </button>
                )}
                <button onClick={saveNews} disabled={busy || !nForm.title.trim()} className={btn}>
                  {nForm.id ? "Save" : "Add"}
                </button>
              </div>
            </div>
          </section>

          <ul className="divide-y divide-[var(--border-soft)] rounded-lg border border-[var(--border)]">
            {news.length === 0 && (
              <li className="px-4 py-3 text-sm text-[var(--faint)]">No posts yet.</li>
            )}
            {news.map((n) => (
              <li key={n.id} className="flex items-center gap-3 px-4 py-3 text-sm">
                <span className="min-w-0 flex-1">
                  <span className="block truncate font-medium">
                    {n.title}
                    {!n.published && (
                      <span className="ml-2 text-xs text-[var(--faint)]">(draft)</span>
                    )}
                  </span>
                  <span className="block truncate text-xs text-[var(--faint)]">/{n.slug}</span>
                </span>
                <button onClick={() => toggleNewsPublished(n)} className={ghost}>
                  {n.published ? "Unpublish" : "Publish"}
                </button>
                <button onClick={() => editNews(n)} className={ghost}>
                  Edit
                </button>
                <button
                  onClick={() => deleteNews(n.id)}
                  className="text-xs text-[var(--danger)] hover:underline"
                >
                  Delete
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

function safeTags(tags: string | null): string[] {
  if (!tags) return [];
  try {
    const parsed = JSON.parse(tags);
    return Array.isArray(parsed) ? parsed.filter((t) => typeof t === "string") : [];
  } catch {
    return [];
  }
}
