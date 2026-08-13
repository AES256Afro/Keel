import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { audit } from "@/lib/audit";
import { requireJsonRequest, requireSameOriginMutation } from "@/lib/same-origin";
import { requireInstanceOwner, handleApiError, ApiError } from "@/lib/api";
import { serializeTags } from "@/lib/site";

interface GhRepo {
  name: string;
  description: string | null;
  html_url: string;
  homepage: string | null;
  topics?: string[];
  fork: boolean;
  archived: boolean;
  stargazers_count: number;
}

/** Import repositories from GitHub as draft projects (owner reviews, then
 *  publishes). Deduped by repo URL so re-running only adds new ones. With a
 *  token (body or GITHUB_TOKEN env) it can see private repos; without one it
 *  lists a username's public repos. */
export async function POST(req: NextRequest) {
  try {
    const ctx = await requireInstanceOwner();
    requireSameOriginMutation(req, "Import public projects from Keel Admin");
    requireJsonRequest(req, "Project-import requests must use application/json");
    const b = await req.json().catch(() => ({}));
    const username = String(b.username ?? "").trim();
    const bodyToken = b.token ? String(b.token).trim() : "";
    // Explicit token wins; otherwise a username means the public path, and only
    // with no username do we fall back to a server-configured GITHUB_TOKEN.
    const token = bodyToken || (username ? "" : (process.env.GITHUB_TOKEN ?? "").trim());

    if (!token && !username) {
      throw new ApiError(400, "Provide a GitHub username, or a token to import your own repos.");
    }

    const url = token
      ? "https://api.github.com/user/repos?per_page=100&sort=updated&visibility=all"
      : `https://api.github.com/users/${encodeURIComponent(username)}/repos?per_page=100&sort=updated`;

    const res = await fetch(url, {
      headers: {
        Accept: "application/vnd.github+json",
        "User-Agent": "keel",
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
    });
    if (!res.ok) {
      throw new ApiError(res.status === 401 ? 401 : 502, `GitHub API error (${res.status})`);
    }
    const repos = (await res.json()) as GhRepo[];

    const existing = new Set(
      (await prisma.project.findMany({ select: { repoUrl: true } }))
        .map((p) => p.repoUrl)
        .filter(Boolean)
    );

    let imported = 0;
    let order = 0;
    for (const r of repos) {
      if (r.fork || r.archived || existing.has(r.html_url)) continue;
      await prisma.project.create({
        data: {
          title: r.name,
          description: r.description ?? "",
          url: r.homepage || null,
          repoUrl: r.html_url,
          tags: serializeTags(Array.isArray(r.topics) ? r.topics : []),
          featured: false,
          published: false, // draft  -  owner reviews before it goes live
          sortOrder: order++,
        },
      });
      existing.add(r.html_url);
      imported++;
    }

    await audit("site.project.import", ctx.user, {
      detail: { imported, scanned: repos.length, username: username || null },
    });
    return NextResponse.json({ imported, scanned: repos.length });
  } catch (err) {
    return handleApiError(err);
  }
}
