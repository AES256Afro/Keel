# What shipped

Everything below is on the `hardening` branch, verified by `npm test`
(268 automated checks) plus manual browser testing. Grouped by what it changes
for you.

---

## 1. Security

### The one that mattered - any invitee was an instance admin

`requireOwner()` checked the caller's **workspace** role. Every account owns its
own workspace, so that check passed for literally everyone - including a person
invited as **View only**. That granted the public-site CMS, the sign-in
allowlist and the Cloudflare tunnel controls to any account on the instance.
Reproduced end to end: a view-only invitee rewrote the allowlist to contain only
their own address, locking the real owner out permanently.

Instance ownership is now its own concept (`src/lib/instance.ts`): the address in
`KEEL_OWNER_EMAIL`, or whoever registered first. `requireInstanceOwner()` gates
`/api/admin/**`, `/api/instance/**` and `/admin`; `requireOwner()` keeps its
narrower, correct meaning for workspace settings.

**Action for you:** set `KEEL_OWNER_EMAIL` in production. Without it the fallback
is "first to register", which is right for a personal box but not something to
rely on after a database restore.

### Everything else

| Was | Now |
| --- | --- |
| No rate limiting anywhere - `/login` was an unbounded password oracle *and* a CPU-exhaustion vector via bcrypt | Sliding-window limits per IP and per account; failed logins tracked in the database with exponential lockout, so a restart can't clear it |
| No security headers at all | Nonce-based CSP (no `unsafe-inline` for scripts), `frame-ancestors 'none'`, HSTS, `Referrer-Policy`, `nosniff`, `Permissions-Policy`; framework version no longer advertised |
| 9 high-severity Next.js advisories | Zero. `npm audit --omit=dev` is clean; `postcss` and `sharp` pinned forward with `overrides` rather than downgrading Next |
| The image optimizer was live attack surface (`sharp`/libvips CVEs, SVG DoS) | Disabled - Keel renders no `<Image>` |
| `backupDir` accepted any absolute path → arbitrary directory creation and file writes | Confined to the backup root unless you are the instance owner. Existing paths are grandfathered and logged, so nobody's OneDrive-synced folder silently moves |
| `/api/auth/desktop-claim` minted a session with no authentication, reachable from the internet - a session-fixation vector | Loopback only; refuses when a proxy is in front, whatever the `Host` header claims |
| Login disclosed which emails had accounts | One generic message. A static hint points Google-only users at the right button without confirming anything |
| Username / slug / credential uniqueness enforced by `findFirst`-then-write (a race) | Real database constraints, with a migration that de-duplicates existing rows first |
| Page content accepted unbounded | 2 MB per page, 512 chars per title, 64 KB per cell, all returning 413 |
| A failed security-key attempt left a 5-minute window of unlimited retries | The pending record burns on first failure |
| OAuth errors reflected raw exception text into the URL | Development only; production logs server-side |
| `POST /api/pages` never validated `parentPageId` against the workspace | It does now |

### Account lifecycle and the audit trail

A session lasted 30 days with no way to end one early, no way to change a
password, and removing someone from the allowlist only stopped them signing in
*again* - their existing session ran to expiry. Settings now lists every browser
holding a session (never returning a usable token), ends one or all of the
others, and changes a password - which requires the current one, because a
session is "this browser", not "this person", and which ends every other session
on success.

`AuditEvent` records the privileged actions: access changes, tunnels,
public-site edits, invites and role changes, cloud connections, backups,
restores, imports and exports, password changes, session revocation. It never
blocks the action it records, never stores a credential (keys matching
`pass|secret|token|key` are redacted, and a test asserts no session token ever
appears), and has no write or delete endpoint - the record cannot be edited from
the thing it records.

### The bug with no runtime symptom

The missing backup routes were not an oversight. `.gitignore` contained
`backups/` with no leading slash, which matches a directory of that name at *any*
depth - so it swallowed `src/app/api/workspace/backups/`. `git add` skipped it
without a word, the build succeeded, the types checked, the UI rendered, and the
feature shipped calling endpoints that were not in the repository.

`npm run test:integrity` now asserts no source file is unreachable from git,
every `/api/` URL the client references has a handler, every model appears in
both migration sets and the desktop bootstrap SQL, instance-wide routes use
`requireInstanceOwner`, every other route authenticates (with the public
exceptions listed explicitly), and no secret is tracked. It has already caught
three files mid-session.

### Still open, deliberately

- **`KEEL_COOKIE_DOMAIN=.example.com`** shares your session with every
  subdomain. One XSS or one stale DNS record anywhere under that apex takes the
  notebook with it. Removing it breaks the seamless "My Notes" link, so it's your
  call - the alternative is a short-lived handoff token.
- **bcrypt cost 10.** Fine, but 12+ is the current recommendation.
- **Viewers can still export the whole workspace.** Consistent with read access,
  but probably not what "View only" implies to the person granting it.

---

## 2. The backup feature was dead

`SettingsClient.tsx` called three endpoints that **did not exist anywhere in the
repository** and never had:

- `POST /api/workspace/backups` - the "Back up now" button
- `POST /api/workspace/backups/restore` - the Restore links
- `GET /api/cloud/backups` - the cloud backup list

All 404. The backup *list* rendered (server-computed) and scheduled backups ran,
so the page looked fine - but every button on it failed silently. Meanwhile the
README advertised "One-click backup" as a working feature.

All three now exist and are covered by a round-trip test: create content → back
up → list → restore → verify it came back, including the encrypted path and four
path-traversal attempts.

---

## 3. Mind map + kanban

Built as **two views of the same records**, which is the decision everything else
follows from. A task is a card *and* a node: the parent relation gives the tree,
the status property gives the columns. Decompose in the map, run it on the board,
same rows.

**New foundation**
- `DatabaseView` - saved views with per-view type, grouping, filters, sort, WIP
  limits, column order and layout. Replaces view state that lived only in React
  and vanished on reload.
- Record tree - `parentRecordId` as a first-class indexed column with cycle
  prevention enforced server-side (walking up from the proposed parent, bounded
  by the record count so bad data can't hang it).

**Kanban v2** - WIP limits with over-limit highlighting, swimlanes (a second
grouping property), card order persisted *within* a column via server-computed
midpoints, collapsible columns, reorderable columns, sub-task counts on cards.

**Mind map** - pan/zoom canvas, tidy-tree auto-layout with manual override,
drag a node onto another to re-parent, fold branches, and the keyboard model
everyone already knows: Tab child, Enter sibling, F2 rename, Space fold, arrows
to navigate.

**A bug this caught:** folded branches were skipped by the layout walk entirely,
so their nodes fell through to the unreachable-node fallback and rendered stacked
at the canvas origin. Found by running it, fixed, and pinned by a unit test.

---

## 4. Deploy anywhere

| Target | How |
| --- | --- |
| macOS, Debian/Ubuntu, Arch, Fedora, openSUSE, Alpine | `curl … install.sh \| bash -s -- --service` |
| Windows | `irm … install.ps1 \| iex` |
| Desktop app | `npm run desktop:build` (unchanged) |
| Home server | Tailscale Serve or Cloudflare Tunnel |
| DigitalOcean, Linode, Hetzner, Vultr, EC2, Azure VM | cloud-init one-liner → Docker + Caddy + Litestream |
| Azure Container Apps, App Runner, ECS, Fly, Railway, Render, K8s | The container image |
| Cloudflare | Tunnel + R2 today. Full Workers hosting is a milestone, not a config change - see below |

**Installers** detect the platform, offer to install Node, write a `.env` with a
generated backup passphrase at mode 600, build, and register a launchd agent /
systemd user unit / Scheduled Task. Re-running updates in place and never
overwrites your `.env`. Verified end to end against a real clone.

**PostgreSQL support** - the schema hardcoded `provider = "sqlite"`, which
blocked every managed host. There are now two migration sets generated from one
source schema, selected automatically from `DATABASE_URL`. CI runs the full
authorization and backup suites against a real PostgreSQL service.

**Container image** - multi-stage, non-root, no build tooling or source in the
runtime layer, `HEALTHCHECK`, and it refuses to start if built for the wrong
dialect rather than failing at the first query.

**A bug this caught:** `next start` ignores `PORT` from `.env`, so an installer
that wrote `PORT=8080` served on 3000 anyway. `npm start` now goes through
`scripts/start.mjs`, which loads the env file first and passes the port as a flag
- cross-platform, unlike a shell one-liner.

### Cloudflare, honestly

Keel does not run on Workers today. It's a Node server: `fs` for backups,
`child_process` for the tunnel manager, `scryptSync` for encryption, and
in-process state for pending 2FA and rate limits. Getting there means moving
backups to the R2 API, moving in-memory state to the database, switching to
Hyperdrive or D1, and adopting OpenNext. That's real work, and pretending
otherwise would waste your time. Cloudflare Tunnel and R2 - which you already
use - work now.

---

## 5. Search actually works now

Search `LIKE`'d over `Page.content` - the serialized editor document. Querying
`paragraph`, `doc`, `type` or `text` returned **every page in the workspace**,
and a word split across two marks (`Quar**ter**ly`, which is what bolding
mid-word produces) matched nothing at all. Results were ordered purely by
`updatedAt`, so the page you meant sat below whatever you edited this morning.

`Page.plainText` holds the flattened text, maintained on every write path and
backfilled in the background on first boot. Pages stay findable by title while
that runs. Flattening walks iteratively (a deep document should not risk the
stack), keeps code blocks, and indexes link targets - which live on a text
node's *marks*, not its attrs; a test caught that reading `attrs` alone indexed
no links at all.

Adds operators - `in:title`, `type:`, `updated:7d`, `"quoted phrases"` - with
unknown operators falling through as search terms. Results are ranked (exact
title, prefix, whole word, then body frequency with diminishing returns) and
carry a highlighted snippet.

## 6. Performance

Measured, not asserted. `npm run test:perf` seeds 400 pages and a
500-record × 8-property database and holds each operation to a budget.

| Was | Now |
| --- | --- |
| `snapshotWorkspace` filtered values with `Array.some` inside `filter` - O(values × records), ~10⁹ comparisons on a 10k-record workspace, on a timer | Set membership. Full export: **29 ms** |
| `restoreSnapshot` did one `await` per property and per value - ~110k sequential round trips | `createMany` in chunks of 100. Restore: **264 ms** |
| `getPageTree` called `pages.some()` inside a loop over pages, on every navigation | Set. Sidebar: **9 ms** |
| `getCurrentContext` ran twice per render (layout + page), each a session lookup plus a memberships query | React `cache()` |
| Opening one record loaded **every** record, page row and value in the database | Schema-only DTO plus that record's values. Payload carries **3** record titles instead of 500; page renders in **9 ms** |

## 7. The link layer

The biggest gap against Obsidian, and it needs no infrastructure. Typing `[[`
opens a picker over page titles; accepting inserts a finished link, and if no
page has that title it offers to create one - so writing forward costs the same
keystrokes as linking back. `#tags` get a browser page. Every page shows what
links to it, with the sentence around each link.

`PageLink` and `PageTag` are **derived** from the document and rebuilt on every
save. The document stays the truth; these exist as rows because "what links
here" is a reverse lookup, and answering it by scanning every page is what makes
backlinks feel slow elsewhere. A link to a page that doesn't exist yet is kept
unresolved and attaches itself when that page appears; renaming detaches links
that named the old title rather than silently re-pointing them.

Tag extraction is the easy thing to get wrong, so it is tested against the cases
that make a naive `#`-regex useless: `C#` and `F#` aren't tags, `#123` is an
issue reference, a URL fragment isn't a tag, and `#ff0000` is a colour - while
`#decaf`, hex-shaped but word-length, still is.

**Three bugs this found.** A headless editor suite was needed because the
pickers are ProseMirror suggestion plugins that can't be driven from the API.
It immediately caught one that took the entire editor down: TipTap keys every
`Suggestion` plugin as `suggestion$`, so adding a second one threw
"Adding different instances of a keyed plugin" at mount. Reviewing the new code
then found that `syncPageLinks` loaded every page in the workspace on every save
- a regression I'd introduced an hour earlier - and that Prisma leaves LIKE
wildcards unescaped, so searching `%` returned every page.

## 8. Autosave stopped lying

The indicator flipped to "Saved" as soon as the request settled, whatever the
response said. A 413, a 403, a dropped connection and a success all looked
identical, so a page you believed was written could simply be gone on reload -
with the UI having told you it was fine. Closing the tab mid-save was allowed.

Failures are now shown with their reason and a Try again button, and stay shown
until a save succeeds. Transient failures retry with backoff; a 4xx stops
immediately, because a rejected payload won't fix itself. `beforeunload` warns
while anything is unsaved, and unmount flushes rather than dropping the last
700ms of typing. Titles go through the same path.

The failure path is tested by intercepting saves and asserting the UI says so -
the old behaviour passes every test that only checks the happy path, which is
why it survived.

## 9. Tests and CI

There was no CI, no test runner, and `npm run lint` was broken (no ESLint config,
no dependency). Now:

```bash
npm test   # typecheck → lint → 268 checks
```

| Suite | Covers |
| --- | --- |
| `test:mindmap` (35) | Layout, folding, pinned positions, cycles, orphans, tree helpers |
| `test:authz` (62) | Every route × {instance owner, workspace owner, editor, viewer, other workspace, anonymous} |
| `test:backup` (25) | Backup → list → restore round trip, encryption, path traversal |
| `test:auth` (38) | Headers, CSP nonce rotation, desktop gating, enumeration, rate limits, size caps, password change, session revocation |
| `test:search` (45) | Flattening, operators, ranking, snippets, backfill, and the `paragraph`-matches-everything regression |
| `test:integrity` (10) | Files hidden from git, orphaned endpoints, migration coverage, route guards, tracked secrets |
| `test:links` (36) | Wikilink and tag extraction, backlinks, forward-link resolution, rename behaviour, workspace isolation |
| `test:editor` (17) | The `[[` picker, the slash menu, autosave failure reporting, CSP violations - in a real browser |
| `test:perf` | Upper bounds on the five paths that were quadratic or N+1 |

CI additionally builds both container images, boots one and probes it, proves the
dialect-mismatch guard fires, and runs the installer inside a clean Debian
container. The authorization matrix is the specific thing that would have caught
P0-1 - it now runs on every push.

Also fixed while linting: three genuine React correctness issues (a ref mutated
during render in `useDebounced`, and effect-driven state sync in `SearchDialog`,
`PropertyValueCell` and `ThemeSelect` that caused cascading renders). `ThemeSelect`
now takes the theme as a prop from the server instead of sniffing the DOM after
mount - one less flash, one less hydration risk.

---

## Not done

Honestly listed, because they are the next things that will bite:

- **Attachments.** No images, no files. Blocks gallery views and cover images,
  and it is the most-felt gap against all three reference products.
- **Server-side database filter/sort/pagination.** Board and table views still
  load and filter every record client-side. The record page no longer does, but
  the views themselves do.
- **Autosave still sends the whole document** every 700 ms of typing. It now
  reports failure honestly, but sending ProseMirror steps instead is the real
  fix - and the groundwork for page history and collaborative editing.
- **Daily notes and a graph view** - the rest of the Obsidian cluster.
- **The cross-subdomain session cookie**, unchanged pending your decision.

These are the M2 items in [ROADMAP.md](ROADMAP.md).
