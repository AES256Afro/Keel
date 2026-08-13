# Keel - Security & Performance Audit

> **Status: most of this is fixed.** The findings below are kept as the record
> of what was wrong and why. Each one now carries its resolution. See
> [CHANGELOG-HARDENING.md](CHANGELOG-HARDENING.md) for what shipped, and
> `npm test` for the suites that keep it fixed.

Audit of commit `fd2a2a4` (branch `claude/keel-workspace-design-nnkz5b`), performed
against a local production build (`npm run build && next start`). Findings marked
**[verified]** were reproduced against a running server; the rest are code-level
findings with the exploit path described.

Severity: **P0** = fix before the instance stays exposed · **P1** = fix this
milestone · **P2** = fix soon · **P3** = cleanup.

---

## Part 1 - Security

### P0-1 · Every registered user is an instance administrator **[verified]** - ✅ FIXED

`requireOwner()` checks the caller's **workspace** role, not instance ownership:

```ts
// src/lib/api.ts:29
export async function requireOwner() {
  const ctx = await requireContext();
  if (ctx.role !== "owner") throw new ApiError(403, "Only the workspace owner can do this");
  return ctx;
}
```

But `provisionUser()` gives **every** new account its own workspace with
`role: "owner"` (`src/lib/signup.ts:76-82`), and `getCurrentContext()` defaults to
the first membership by `createdAt` - which is always the user's own workspace
(`src/lib/auth.ts:108`). So `ctx.role === "owner"` is true for *every account on
the instance*, including a person you invited as **View only**.

Every route guarded by `requireOwner()` is therefore open to any authenticated
user:

| Endpoint | What an ordinary user gains |
| --- | --- |
| `PATCH /api/instance/access` | Rewrite the instance allowlist / signup lock - **locks the real owner out** |
| `POST` / `DELETE /api/instance/tunnel` | Start or stop a Cloudflare Tunnel; publish the private instance to the internet, or supply an arbitrary `--token` |
| `POST`/`PATCH`/`DELETE /api/admin/news`, `/api/admin/projects` | Publish and delete content on the optional built-in public site |
| `POST /api/admin/projects/import` | Drive GitHub API calls, including with the server's `GITHUB_TOKEN` |
| `POST /api/cloud/r2`, `GET /api/cloud/connect` | Repoint backup storage at attacker-controlled credentials |
| `GET /api/workspace/members` | Enumerate members |

Reproduced end to end. `guest@example.com` was added to the owner's workspace as
**viewer** - the most restricted role the product offers - and then:

```
--- guest -> PATCH /api/instance/access
{"access":{"allowedEmails":["guest@example.com"],"signupDisabled":true,"envLocked":false}}

--- guest -> POST /api/admin/news
{"post":{"slug":"defaced-by-guest","title":"Defaced by guest","published":true, ...}}
```

After that first call the instance allowlist contains only the guest, so
`emailAllowed()` (`src/lib/access.ts:108`) rejects the real owner at login. A
view-only invitee can permanently evict the owner from their own server.

`updateAccessSettings()` has a guard that refuses to drop the owner from the
allowlist - but it compares against `opts.ownerEmail`, which the route fills in
from **the caller** (`src/app/api/instance/access/route.ts:17,27`). The guard
protects the attacker, not the owner.

**Mitigating factor:** on the production VPS, `.env.prod` sets
`KEEL_ALLOWED_EMAILS` + `KEEL_DISABLE_SIGNUP`, which makes `envLocked` true and
blocks the `/api/instance/access` PATCH specifically. It does **not** block the
tunnel, admin-CMS, or cloud-credential routes, and it does not apply to the
desktop/local mode at all.

**Fix.** Instance ownership is a different concept from workspace ownership.
Introduce it explicitly:

```ts
// src/lib/api.ts - new
/** The instance operator: the owner of the FIRST workspace, or KEEL_OWNER_EMAIL. */
export async function requireInstanceOwner() {
  const ctx = await requireContext();
  const owner = (process.env.KEEL_OWNER_EMAIL ?? "").trim().toLowerCase();
  if (owner) {
    if (ctx.user.email.toLowerCase() !== owner) throw new ApiError(403, "Instance owner only");
    return ctx;
  }
  const first = await prisma.workspace.findFirst({ orderBy: { createdAt: "asc" }, select: { ownerId: true } });
  if (!first || first.ownerId !== ctx.user.id) throw new ApiError(403, "Instance owner only");
  return ctx;
}
```

Then swap `requireOwner` → `requireInstanceOwner` in **`/api/admin/**`,
`/api/instance/**`**, and in `src/app/admin/page.tsx:12`. Keep `requireOwner` for
genuinely workspace-scoped routes (`/api/workspace/members`, `/api/cloud/*`,
`/api/workspace` PATCH). Add `KEEL_OWNER_EMAIL` to `.env.prod.example` and make
it required whenever `KEEL_SITE_HOSTS` is set.

---

### P1-1 · No rate limiting anywhere **[verified]** - ✅ FIXED

`grep` for `rateLimit|throttle|attempts|lockout` across `src/` returns nothing.
`login()` (`src/app/(auth)/actions.ts:50`) will run bcrypt for every request
forever. On an internet-reachable instance this is an unbounded online password
guessing oracle, and - because bcrypt cost 10 burns ~80 ms of CPU per attempt -
also a cheap CPU-exhaustion DoS.

Equally unthrottled: `/api/auth/webauthn/authenticate/verify`, `/api/search`
(full-table `LIKE` scan, see PERF-2), `/api/workspace/import` (100 MB uploads),
and `/api/workspace/export` (full workspace snapshot).

**Fix.** A small in-process limiter keyed on IP + email for the auth paths
(5 attempts / 15 min, exponential backoff), and a global per-session budget for
the expensive endpoints. Persist counters in `AppSetting` or a `LoginAttempt`
table so a restart doesn't clear the lockout.

### P1-2 · No security headers at all **[verified]** - ✅ FIXED

```
$ curl -sD - -o /dev/null http://localhost:3111/login | grep -iE 'content-security|x-frame|strict-transport|referrer-policy'
(nothing)
```

No CSP, no `X-Frame-Options`/`frame-ancestors` (clickjacking), no
`Referrer-Policy`, no `X-Content-Type-Options`, no HSTS (the Caddyfile doesn't add
one either). `next.config.ts` has no `headers()` block.

**Fix.** Add a `headers()` block in `next.config.ts`. Keel has no third-party
scripts, so a strict CSP is achievable: `default-src 'self'; frame-ancestors
'none'; object-src 'none'; base-uri 'self'; form-action 'self'`. Next's inline
bootstrap needs a nonce or `'unsafe-inline'` for `style-src`; use the nonce
approach via the request proxy.

### P1-3 · Arbitrary filesystem write via `backupDir` **[verified]** - ✅ FIXED

`Workspace.backupDir` is free-form and set from the API with no validation:

```ts
// src/app/api/workspace/route.ts:45
if (body.backupDir === null || typeof body.backupDir === "string") {
  data.backupDir = body.backupDir?.trim() || null;
}
```

`backupDirFor()` then `path.resolve()`s it (`src/lib/backup.ts:331`) and
`runBackup()` does `fs.mkdir(dir, { recursive: true })` + writes the snapshot
there (`src/lib/backup.ts:361,382`). Verified: setting
`backupDir` to an arbitrary absolute path is accepted and echoed back as
`backupResolvedDir`.

Impact on a shared/hosted instance: create directories anywhere the Node process
can write, drop attacker-chosen JSON content at a semi-predictable filename, and
`unlink` files matching `keel-<workspaceId12>-*` in that directory during
pruning (`src/lib/backup.ts:415`). It also leaks host paths to the client.

**Fix.** Confine backup directories to an allowed root
(`KEEL_BACKUP_ROOT`, default `<cwd>/backups`) and reject any resolved path that
escapes it. Keep the free-form path only when `KEEL_ALLOW_ANY_BACKUP_DIR=1`
(desktop/local single-user mode).

### P1-4 · Nine high-severity advisories in `next` **[verified]** - ✅ FIXED

`npm audit --omit=dev` on the pinned tree reports 3 high-severity packages
(`next`, `postcss`, `sharp`) covering 9 Next.js advisories. Two matter directly
here:

- `GHSA-955p-x3mx-jcvp` - unauthenticated disclosure of internal Server Function
  endpoints. Keel's login/register/logout are Server Actions.
- `GHSA-68g3-v927-f742` / `GHSA-4633-3j49-mh5q` - cache confusion of response
  bodies for requests with bodies.

Installed `next@16.2.10`; `16.2.12` is available on the same minor, and
`npm audit fix` resolves all three packages.

**Fix.** `npm audit fix`, re-run the smoke test, and add `npm audit --omit=dev
--audit-level=high` to CI so this doesn't drift again.

### P1-5 · Session cookie is shared across every subdomain - ⚠️ DOCUMENTED, NOT CHANGED

An operator can set `KEEL_COOKIE_DOMAIN=.example.com`, which scopes
the `keel_session` cookie to the apex and *all* subdomains
(`src/lib/auth.ts:30-42`). One XSS on the public marketing site, one stale DNS
record on any `*.example.com` name, or one future subdomain app, and the
notebook session is stolen.

**Fix.** Drop the shared cookie. Make "My Notes" a normal link to
`notes.example.com`; the user signs in there once and stays signed in. If
cross-subdomain SSO is a hard requirement, mint a short-lived, single-use
handoff token instead of widening the session cookie's scope.

### P1-6 · Account lifecycle is missing its safety valves - ✅ FIXED

There is no password change, no password reset, no email verification, no session
list, and no "sign out everywhere". `Session` rows are only ever deleted by
`destroySession()` for the *current* token (`src/lib/auth.ts:66`); expired rows
are checked at read time (`src/lib/auth.ts:86`) but never pruned, so the table
grows without bound and a leaked 30-day token cannot be revoked by the user.

`emailAllowed()` is enforced only at *login*, so revoking someone from
`KEEL_ALLOWED_EMAILS` leaves their existing session valid for up to 30 days.

**Fix.** Add password change (invalidating all other sessions), a sessions list
with per-session revoke, a `DELETE FROM Session WHERE expiresAt < now()` sweep in
the `server-init` tick, and an `emailAllowed()` re-check inside `getCurrentUser()`
(cached briefly).

---

### P2-1 · Session fixation via the unauthenticated desktop handoff **[verified]** - ✅ FIXED

`GET /api/auth/desktop-claim?id=…` is unauthenticated and *sets a session cookie*
(`src/app/api/auth/desktop-claim/route.ts:7`). `GET /api/auth/desktop-status?id=…`
is an unauthenticated oracle for whether an id is claimable.

The handoff id itself is 32 random bytes (`desktop/main.js:133`), so guessing is
not the risk. The risk is the reverse direction: an attacker signs in on their
own machine with `?desktop=<id>` to park a session, then gets a victim to
navigate to `https://notes.example.com/api/auth/desktop-claim?id=<id>`. Because
this is a top-level GET, `SameSite=Lax` sends nothing but the response *sets*
the attacker's session - the victim is now silently logged into the attacker's
account and any notes they write land in the attacker's workspace.

**Fix.** These endpoints only make sense for the desktop shell talking to its own
localhost server. Gate them: return 404 unless the request arrives on a loopback
host, or unless `KEEL_DESKTOP_HANDOFF=1` is set (the Electron shell sets it when
it spawns the server). They should never be reachable on the VPS or via Tailscale.

### P2-2 · Account enumeration on both auth paths - ✅ FIXED

`register()` returns *"An account with that email already exists"*
(`src/app/(auth)/actions.ts:36`) and `login()` returns *"This account uses Google
sign-in"* (`:59`). Both distinguish registered from unregistered addresses.
Combined with the missing rate limit (P1-1), the user list is enumerable.

**Fix.** Return one generic message from `login()`. For `register()`, on a
private instance the message is acceptable - but move the `signupAllowed()` check
*before* the existence check so a locked-down instance reveals nothing.

### P2-3 · App-layer uniqueness with no database constraint - ✅ FIXED

`User.username`, `NewsPost.slug` and `Credential.credentialId` are all documented
as "enforced in the API layer" to keep `prisma db push` non-destructive
(`prisma/schema.prisma:20,42,89`). Each check is a `findFirst` followed by a
write, with no transaction - a classic check-then-act race. Two concurrent
registrations can produce duplicate usernames, which then breaks `@mention`
resolution (`src/app/api/pages/[pageId]/comments/route.ts:75`) because mentions
match on username.

**Fix.** Production is already `prisma migrate`-managed (`docker/entrypoint.sh:23`),
so add real `@unique` constraints in a migration and catch `P2002`. The
"db-push-safe" constraint only applies to the desktop bootstrap path, which
creates the schema from `prisma/schema.sql` anyway.

### P2-4 · Second-factor weaknesses - 🟡 PARTIAL

- The pending-2FA record is only consumed on **success**
  (`src/app/api/auth/webauthn/authenticate/verify/route.ts:32`), so a stolen
  password grants a 5-minute window of unlimited security-key attempts.
- The challenge cookie `keel_wa_chal` is not bound to the pending token, and it
  is shared between the registration and authentication flows.
- Pending state, desktop handoffs and tunnel state all live in
  `globalThis` maps (`src/lib/pending-2fa.ts:20`, `desktop-handoff.ts:19`,
  `tunnel.ts:22`) - correct for one process, silently broken behind more than one.

**Fix.** Consume the pending record on the first failed verify too; bind the
challenge to the pending token (store it *in* the pending record rather than a
separate cookie); document the single-process assumption or move the state to the
database.

### P2-5 · No request-size limits on user content - ✅ FIXED

`PATCH /api/pages/[pageId]` accepts `body.content` as an unbounded string
(`src/app/api/pages/[pageId]/route.ts:41`) and writes it straight to SQLite. So
do `Comment.body` (capped at 5 000 - good) and `DatabaseValue.value` (uncapped).
A single request can push an arbitrarily large document; the search endpoint then
`LIKE`s over it on every query.

**Fix.** Cap `content` (e.g. 2 MB), `title` (512), and property values (64 KB) in
the route handlers, and set `serverActions.bodySizeLimit` in `next.config.ts`.

### P2-6 · No audit trail - ✅ FIXED

Nothing records who changed access settings, started a tunnel, connected cloud
storage, invited a member, or restored a backup. After a P0-1-style compromise
there is no way to reconstruct what happened. `docs/ARCHITECTURE.md:217` already
lists this as deferred.

**Fix.** An `AuditEvent` table written from the API layer for every
`requireInstanceOwner` / `requireOwner` route, surfaced read-only in Settings.

### P2-7 · Viewers can exfiltrate the entire workspace - ⚠️ RATE-LIMITED, BEHAVIOUR UNCHANGED

`POST /api/workspace/export` uses `requireContext()`, not `requireEditor()`
(`src/app/api/workspace/export/route.ts:8`), so a **View only** member can
download a complete snapshot of every page and database. Arguably consistent with
read access, but it is not what "View only" implies to the person granting it,
and there's no record it happened.

**Fix.** Decide deliberately: either restrict to editor+, or keep it and log it
(P2-6) and say so in the sharing UI.

---

### P3-1 · `parentPageId` is not validated on page creation **[verified]** - ✅ FIXED

`POST /api/pages` accepts any `parentPageId` string without checking it belongs
to the caller's workspace (`src/app/api/pages/route.ts:13`) - `PATCH` does check
(`[pageId]/route.ts:45`). Verified: a user created a page in their own workspace
parented to a page in a *different* workspace. No data leaks (the row's
`workspaceId` is still the caller's, and `getPageTree` re-roots orphans), but it
corrupts the tree and will break any future recursive query.

**Fix.** `await requirePage(parentPageId, workspace.id)` when it's non-null.

### P3-2 · OAuth error details reflected into the URL - ✅ FIXED

`fail()` puts up to 200 characters of the raw exception into
`/login?error=…&detail=…` (`src/app/api/auth/google/callback/route.ts:15`).
Useful in development, but it echoes internal error text to the browser and into
any referrer/proxy log.

**Fix.** Keep `detail` behind `NODE_ENV !== "production"`; log the full error
server-side and show the user a stable code.

### P3-3 · bcrypt cost 10 - ❌ OPEN

`hashPassword()` uses cost 10 (`src/lib/auth.ts:11`). OWASP's current floor is 10
but the practical recommendation is 12+. Since the app already ships
`scrypt` for backups, moving to `scrypt`/`argon2id` for passwords is also on the
table.

---

## Part 2 - Correctness

### C-1 · The entire manual backup UI calls endpoints that don't exist **[verified]** - ✅ FIXED

`SettingsClient.tsx` calls three routes that have no handler anywhere in the
repo - and have never existed in git history:

| Called from | Endpoint | Live result |
| --- | --- | --- |
| `SettingsClient.tsx:261` - **"Back up now"** | `POST /api/workspace/backups` | **404** |
| `SettingsClient.tsx:550` - **"Restore"** | `POST /api/workspace/backups/restore` | **404** |
| `SettingsClient.tsx:211` - cloud backup list | `GET /api/cloud/backups` | **404** |

Verified against the running server. The backup *list* renders (it's
server-computed via `listBackups()` in `settings/page.tsx:12`) and *scheduled*
backups work (the `server-init` tick calls `runBackup()` directly), so the page
looks functional - but every button on it fails. `README.md:61-63` advertises
"One-click backup - Settings → *Back up now*" as a working feature.

This is the single highest-impact non-security bug: the app's data-safety story
is half-wired.

**Fix.** Add the three handlers. They're thin wrappers over code that already
exists - `runBackup()`, `readBackupFile()` + `parseBackup()` + `restoreSnapshot()`,
and `listCloudBackups()`. Note `readBackupFile()` already sanitizes with
`path.basename` + prefix check (`src/lib/backup.ts:450`), so the restore route
must go through it rather than joining the filename itself.

### C-2 · `npm run lint` cannot run - ✅ FIXED

`package.json:11` defines `"lint": "next lint"` but there is no ESLint config in
the repo and no `eslint` dependency. There is also no typecheck script, no unit
tests, and no CI workflow that builds or tests - `.github/workflows/` only has
`deploy.yml` and `desktop.yml`.

**Fix.** Add `eslint` + `eslint-config-next`, a `"typecheck": "tsc --noEmit"`
script, and a `ci.yml` that runs build + typecheck + lint + `npm audit` on every
push.

---

## Part 3 - Performance

Keel is fast at demo scale. Each item below is where it stops being fast.

### PERF-1 · A record page loads the entire database - ✅ FIXED

Opening any single record calls `getDatabaseDTO(record.databaseId)`
(`src/app/(workspace)/p/[pageId]/page.tsx:66`), which loads **every** record,
**every** page row, and **every** value in that database, plus a full member
query (`src/lib/pages.ts:176-198`), then serializes the lot into the RSC payload
to render one row's properties. A 5 000-row task tracker means a multi-megabyte
payload every time you click a task.

The same DTO backs the database page itself with no pagination, and
`/api/databases/[id]/export`.

**Fix.** Split the DTO: `getDatabaseSchema()` (properties + member options) for
record pages, and a paginated `getDatabaseRecords({ cursor, take })` for views.
Move filter/sort server-side (see PERF-3) and stream CSV export instead of
building it in memory.

### PERF-2 · Search is a full-table `LIKE` over raw ProseMirror JSON **[verified]** - ✅ FIXED

```ts
// src/app/api/search/route.ts:14
OR: [{ title: { contains: q } }, { content: { contains: q } }]
```

Two problems. First, no index can serve `LIKE '%q%'`, so every search scans every
page row and every stored document - with `orderBy: updatedAt` on an unindexed
column on top.

Second, `content` is the **serialized ProseMirror document**, so structural JSON
keys are searchable. Verified against a page whose only text was "Revenue was
up.":

```
q=paragraph  -> ['Quarterly notes']     ← matched the JSON, not the text
q=doc        -> ['Quarterly notes']
q=heading    -> []
q=Revenue    -> ['Quarterly notes']     ← the only correct hit
```

Every page in a workspace matches `paragraph`, `doc`, `text`, and `type`.

**Fix.** Store a derived `Page.plainText` column (flatten the doc on save - the
walker in `src/lib/markdown.ts` already does most of it) and index *that*. Then
SQLite FTS5 (or Postgres `tsvector`) over `title + plainText`, with snippets and
ranking. This also unlocks the search operators listed in the roadmap.

### PERF-3 · Database views filter and sort entirely in the browser - ❌ OPEN

`visibleRecords` (`src/components/DatabasePage.tsx:178-207`) filters and sorts the
full record array client-side, and `TableView`/`BoardView` render every row with
no virtualization. `docs/ARCHITECTURE.md:81` acknowledges this ("fine at v1
scale"). At a few thousand rows the page ships megabytes and then blocks the main
thread on every keystroke in the filter box.

**Fix.** Push filter/sort/group into the query alongside PERF-1's pagination, and
virtualize the table and board bodies.

### PERF-4 · `collectSubtreeIds` scans the whole workspace, per call - ❌ OPEN

```ts
// src/lib/api.ts:59
const pages = await prisma.page.findMany({ where: { workspaceId }, select: { id, parentPageId } });
```

Called on every archive, every hard delete, and every page **move**
(`pages/[pageId]/route.ts:23,46,73`) - the move path calls it once per drag.

**Fix.** A recursive CTE (`WITH RECURSIVE`) returns the subtree in one query on
both SQLite and Postgres. Alternatively store a materialized `path` column and
range-scan it, which also makes breadcrumbs free.

### PERF-5 · Snapshot is quadratic; restore is one round-trip per row - ✅ FIXED

```ts
// src/lib/backup.ts:128
values: values.filter((v) => inScopeRecords.some((r) => r.id === v.recordId))
```

`Array.some` inside `filter` - O(values × records). A workspace with 10 000
records × 10 properties is 100 000 × 10 000 = 10⁹ comparisons per backup, and the
scheduler runs this every interval.

`restoreSnapshot()` (`src/lib/backup.ts:138-263`) then does one sequential
`await prisma.*.create()` per page, property, record, and value - no
`createMany`, no transaction. Restoring that same workspace is ~120 000
sequential round-trips, and a crash halfway leaves a partial tree.

**Fix.** Replace the `some()` with a `Set` of record ids (one-line change, drops
it to O(n)). Batch the restore into `createMany` chunks inside a single
`prisma.$transaction`, keeping the id remapping in memory.

### PERF-6 · `getCurrentContext()` runs twice per page request - ✅ FIXED

`layout.tsx:9` and `p/[pageId]/page.tsx:16` each call it, and each call issues a
session lookup + a memberships lookup with `include: { workspace: true }`
(`src/lib/auth.ts:82,100`). API routes on the same navigation add a third. Next
dedupes `fetch`, not Prisma.

**Fix.** Wrap `getCurrentUser` and `getCurrentContext` in React's `cache()` -
roughly a six-line change that halves the per-navigation query count.

### PERF-7 · `getPageTree` is O(n²) - ✅ FIXED

```ts
// src/lib/pages.ts:135
const parentExists = key !== null && pages.some((x) => x.id === key);
```

`some()` over all pages, inside a loop over all pages - and this runs in the
sidebar layout on **every** navigation.

**Fix.** Build a `Set` of ids first. Same one-line class of fix as PERF-5.

### PERF-8 · Autosave rewrites the whole document every 700 ms - ❌ OPEN

`Editor.onUpdate` serializes the entire doc (`src/components/Editor.tsx:97`) and
`DocumentPage` PATCHes all of it (`src/components/DocumentPage.tsx:19-26`). On a
long page, sustained typing means a full multi-hundred-KB body every 700 ms, each
one a full-row SQLite rewrite. There is also no failure handling - the "Saved"
indicator flips to saved regardless of the response status, and no `beforeunload`
guard, so a failed save is silent data loss.

**Fix.** Short term: check `res.ok`, surface failures, and add a
`beforeunload` guard while dirty. Medium term: send ProseMirror steps rather than
the full document (this is also the groundwork for page history and, later,
collaborative editing).

### PERF-9 · Missing indexes and unbounded tables - ✅ FIXED

- `Page.updatedAt` - ordered by in search, unindexed.
- `Session.expiresAt` - never queried or pruned; table grows forever.
- `User.username`, `NewsPost.slug` - looked up with `findFirst` on unindexed,
  non-unique columns; `generateUsername()` and `uniqueNewsSlug()` loop with one
  query per collision (`src/lib/signup.ts:50`, `src/lib/site.ts:24`).
- `Notification` - never pruned.
- `RecentVisit` - one row per user × page forever, to show five entries.

**Fix.** Add the indexes in a migration; add retention sweeps to the existing
`server-init` tick (sessions, notifications > 90 days, visits beyond the newest
50 per user).

### PERF-10 · No compression, caching, or connection tuning - ❌ OPEN

`next.config.ts` is three lines. No `compress` (Caddy does gzip for the VPS, but
not for desktop/local or Tailscale-direct), no cache headers on export routes, no
Prisma connection-pool config for the Postgres path, and `PrismaClient` is only
cached on `globalThis` in development (`src/lib/prisma.ts:7`) - fine for
`next start`, a leak risk for any future serverless target.

---

## A finding with no runtime symptom

**C-1's root cause** turned out to be `.gitignore`. The rule `backups/` had no
leading slash, so it matched a directory of that name at *any* depth - including
`src/app/api/workspace/backups/`. `git add` skipped those route files silently,
nothing failed, and the feature shipped calling endpoints that were not in the
repository.

Nothing in a normal pipeline catches that: the build succeeds, the types check,
the UI renders. `scripts/integrity-check.mjs` now asserts that no source file is
unreachable from git, that every `/api/` URL the client references has a handler,
that every model appears in both migration sets, and that privileged routes use
the right guard.

## Suggested order of work

1. **P0-1** - instance-owner split. Nothing else matters while any invitee is an admin.
2. **C-1** - the three missing backup routes. The data-safety promise is currently false.
3. **P1-4**, **P1-2**, **P1-1** - dependency bump, headers, rate limiting. Cheap, high coverage.
4. **P1-3**, **P2-1** - backup path confinement, desktop endpoints gated to loopback.
5. **C-2** - CI with build + typecheck + lint + audit, so 3 and 4 stay fixed.
6. **PERF-5**, **PERF-7**, **PERF-6** - three small changes (`Set`, `Set`, `cache()`) with outsized effect.
7. **PERF-2**, **PERF-1**, **PERF-3** - the search and database-scale rewrite; this is M2/M4 work, not a patch.
