# Keel Architecture

This document describes how the current codebase implements the
[product plan](PRODUCT_PLAN.md), the decisions that deviate from it, and what is
deliberately deferred.

## Overview

Keel is a single Next.js (App Router) application. Server components render the
workspace shell and pages; route handlers under `src/app/api/**` form the JSON API
used by the client components; Prisma talks to SQLite in development and PostgreSQL
in production.

```
src/
  app/
    (auth)/            login / register pages + server actions
    (workspace)/       authenticated shell: sidebar layout, /p/[pageId], /trash
    api/               route handlers: pages, databases, properties, records, search
  components/          client components (Sidebar, Editor, database views, …)
  lib/                 auth, prisma, page/database services, markdown & csv export
prisma/schema.prisma   data model
scripts/smoke.mjs      end-to-end browser test
```

## Data model

Implemented tables (see `prisma/schema.prisma`):

- `User`, `Session` - email/password auth with hashed passwords (bcrypt) and
  DB-backed cookie sessions.
- `Workspace`, `WorkspaceMember` - one workspace per user in v1; the member table
  carries a `role` (`owner | editor | commenter | viewer`) so sharing can be added
  without a migration of concepts.
- `Page` - the universal content unit. `type` is `document`, `database`, or
  `record`. Pages nest through `parentPageId`; `archivedAt` implements the trash;
  `sortOrder` orders siblings.
- `Database` - 1:1 with a page of type `database`.
- `DatabaseProperty` - name, `type` (`text | number | select | multiSelect | date |
  checkbox | url`), and `settings` JSON (select options with colors).
- `DatabaseRecord` - 1:1 with a page of type `record`, so **every record opens as a
  page** with structured properties plus a free-form body.
- `DatabaseValue` - one row per (record, property), value stored as JSON.

### Decision: blocks live inside the page document

The plan sketches a `blocks` table (one row per block). The editor is built on
TipTap/ProseMirror, whose native persistence format is a single JSON document per
page - so v1 stores page content in `Page.content` as that document. Blocks still
exist as first-class things in the editor (slash menu, markdown shortcuts, per-block
nodes); they are just persisted together.

Why: a per-block table only pays off with block-level permissions, block comments,
or real-time collaborative editing - all explicitly deferred by the plan. Splitting
the ProseMirror document into rows now would complicate saving/loading for no v1
feature. When block comments or live collaboration arrive, the migration path is to
introduce stable block IDs (a TipTap extension) and either index or split the
document then.

### Decision: JSON as strings

Prisma's SQLite connector has no native `Json` column type, so JSON payloads
(`Page.content`, `DatabaseProperty.settings`, `DatabaseValue.value`) are `String`
columns, parsed through `src/lib/json.ts`. This keeps one schema working across
SQLite and PostgreSQL.

## Feature notes

- **Editor** - TipTap StarterKit + task lists + links + placeholder, plus a custom
  slash-command extension (`src/components/Editor.tsx`, `SlashMenu.tsx`) built on
  `@tiptap/suggestion` with a React-rendered menu (arrow keys + Enter work).
  Autosave debounces 700 ms and PATCHes the page.
- **Sidebar** - server-computed page tree (records excluded); drag a page onto
  another page to nest it, or onto the drop zone to move it to the root. Cycle
  moves are rejected server-side.
- **Trash** - archiving sets `archivedAt` on the whole subtree; restoring clears
  it (and re-roots the page if its parent is still trashed). The sidebar offers
  a ten-second undo. Workspace owners choose a 7, 30, 90, or 365 day automatic
  purge window, or keep trash forever. Hard delete removes the subtree
  leaves-first.
- **Databases** - the database page owns view state client-side (current view,
  filter text, sort). Filter/sort run client-side over the loaded records, which
  is fine at v1 scale; push them into queries when workspaces grow.
- **Board view** - groups by a `select` property (picker appears when there are
  several), drag cards between columns to update the value.
- **Search and commands** - Cmd/Ctrl-K opens one palette for indexed page search
  and common navigation/creation actions. Page search reads maintained plain
  text rather than serialized editor JSON.
- **Export** - Markdown via a small ProseMirror-JSON→Markdown renderer
  (`src/lib/markdown.ts`); CSV via `src/lib/csv.ts` with proper quoting.

## Security

- Passwords hashed with bcrypt (cost 10); sessions are random 256-bit tokens in an
  `httpOnly`, `SameSite=Lax` cookie, expiring after 30 days.
- Every API handler resolves the session and checks the target row belongs to the
  caller's workspace (`src/lib/api.ts`).
- No secrets in the repo; `.env` is gitignored.

## Backups, theming, templates (added after MVP)

- **Snapshot engine** (`src/lib/backup.ts`) - one JSON snapshot format powers
  workspace backup files, download/upload export, restore, and page duplication
  (snapshot a subtree → restore with fresh IDs). Restores are non-destructive.
- **Encryption** - AES-256-GCM with scrypt KDF (`.keelbak` envelope). Scheduled
  encrypted backups use the instance owner's write-only managed passphrase, with
  `KEEL_BACKUP_PASSPHRASE` taking priority as a locked host override. Manual
  backups accept a passphrase for that backup.
- **Scheduler & crash safety** (`src/lib/server-init.ts`, kicked off lazily from
  the first server-side request via `ensureServerInit()` in `src/lib/auth.ts` -
  not a Next.js instrumentation hook, because `next dev` also bundles
  instrumentation.ts for non-Node contexts where `fs` cannot resolve) - enables
  SQLite WAL mode and runs due backups every 5 minutes. WAL journal mode is
  persistent in the database file, so lazy init does not weaken crash safety. Backup writes are atomic (tmp file + rename) and pruned to
  `backupKeep`. The backup folder is configurable per workspace; pointing it at a
  OneDrive/Google Drive-synced folder gives off-site copies without OAuth. Keel
  also supports direct Google Drive, OneDrive, Azure Blob, and R2 uploads.
- **Theming** - semantic CSS variables in `globals.css` with three modes:
  explicit light/dark (`data-theme` on `<html>`) or system
  (`prefers-color-scheme`). The choice is stored in a cookie and rendered by
  the server onto `<html>`, so there is no flash and no inline bootstrap
  script (React 19 warns about script tags rendered from components).
- **Screenshot-safe identity** - the workspace UI never renders the user's
  real name. The sidebar shows an avatar circle (first letter of the
  username) whose menu shows `@username`, Settings, and Sign out. Usernames
  are auto-derived from the email at registration and editable via
  `/api/account`; uniqueness is enforced in the API layer.
- **Templates** (`src/lib/templates.ts`) - built-in document and database templates
  created via `/api/pages/from-template`; any page can also be deep-duplicated.

## Sharing (phase 5)

- **Invites** (`WorkspaceInvite`) - the owner invites by email from Settings →
  Members & sharing. If the email already has an account, the membership is
  created instantly. Otherwise the invitation remains pending. A verified
  Google signup may accept it automatically; a password signup does not prove
  mailbox ownership, so the owner confirms that account by inviting it again.
  No email delivery is required for v1.
- **Roles** - `owner` (settings, backups, members), `editor` (all content
  operations), `viewer` (read/search/export only). Enforcement is server-side:
  every mutating route goes through `requireEditor()` / `requireOwner()` in
  `src/lib/api.ts`; the UI additionally hides create/edit affordances and
  renders pages read-only for viewers.
- **Workspace switcher** - users own one workspace and can be members of
  others; the active workspace is a cookie (`keel-workspace`) validated
  against membership on every request, switchable from the sidebar header.
- **Public document links** (`PageShare`) - a workspace owner can generate one
  read-only capability URL per active Keel document. Only the SHA-256 token
  digest is stored. Replacing or revoking a link invalidates it immediately;
  optional expiry is checked on every read. Shared attachment reads are scoped
  to the exact page and workspace. Public responses are `no-store` and
  `noindex`; databases, records, trash, and external mirrors cannot be shared.
- Per-page permissions and permission inheritance (beyond workspace roles)
  remain deferred, as does the `commenter` role until comments exist. Public
  links are bearer capabilities, not a new workspace role.

## Comments, notifications, favorites (phase 5 tail + phase 6)

- **Comments** (`Comment`) - page-level comments on every page type, with
  resolve/reopen and delete (author or workspace owner). Editors and owners
  can write; viewers read. Block-level comments are deferred until the editor
  has stable block IDs.
- **Mentions & notifications** (`Notification`) - `@username` in a comment
  notifies matching workspace members (never the author). The sidebar bell
  shows the unread count; opening it marks all read. In-app only - no email.
- **Favorites & recents** (`Favorite`, `RecentVisit`) - per-user star toggle in
  the page header and a visit tracker; the sidebar shows Favorites plus the
  five most recent pages in the active workspace.

## Task manager (person & progress properties)

- **Person** - value is a member's userId. Options are injected server-side
  from the workspace member list into the property DTO, so the entire select
  machinery (chips, board grouping, filtering, CSV export) works unchanged;
  boards can group by assignee. Setting a person value notifies the assignee
  (`type: "assignment"` notification), never the setter.
- **Progress** - a 0–100 number rendered as a slider in cells and as progress
  bars on board cards; sorts numerically and exports as "60%".

## Desktop app

`desktop/main.js` (Electron) runs the Next.js **standalone** server as a child
process on a free localhost port with `DATABASE_URL` pointed at the OS
user-data folder, then opens a BrowserWindow on it. Because the packaged app
has no Prisma CLI, the schema ships as `prisma/schema.sql` (regenerated by
`npm run db:sql` / the desktop build) and `initServer` applies it when the
tables are missing - the same path also makes any fresh deployment
self-bootstrapping. `scripts/desktop-build.mjs` assembles the bundle (static
assets, Prisma engines, schema, local data scrubbed) and electron-builder
packages NSIS `.exe` / AppImage / deb; `.github/workflows/desktop.yml` builds
both platforms in CI and attaches artifacts (releases on `v*` tags).

## Google sign-in & cloud backups

- **OAuth** (`src/lib/oauth.ts`) - plain authorization-code flow over fetch,
  no SDK. Google powers sign-in (`openid email profile`) and Drive backups
  (`drive.file` - app-created files only); Microsoft powers OneDrive backups
  (`Files.ReadWrite.AppFolder` - app folder only). The instance owner may save
  encrypted client credentials in Settings, while environment values remain
  higher-priority locked overrides.
- **Sign-in** - `/api/auth/google` resolves Google's stable subject and verified
  email together. It never auto-links a password account based only on matching
  email; a signed-in account-self link flow proves both sides explicitly.
  `passwordHash` is nullable for Google-only accounts.
- **Cloud storage** (`src/lib/cloud.ts`) - provider-agnostic upload/list/
  download. `runBackup` uploads each backup after writing it locally; upload
  failures surface in Settings without failing the backup. Restore downloads
  from the drive and feeds the standard snapshot-restore path. Refresh tokens,
  OneNote tokens, Azure SAS URLs, and R2 keys use AES-256-GCM envelopes in the
  existing workspace columns. AAD binds each envelope to its workspace,
  provider, purpose, and envelope version. The master key stays outside the
  database. Legacy plaintext is atomically encrypted before first use, and
  provider-rotated tokens are written back only as ciphertext.

## Version 1 target - status

Every item from the plan's "Version 1 Feature Target" now works: account,
workspace, pages, nesting, blocks, databases, records-as-pages, table/list/
board views, templates, sharing with roles, comments with mentions, search,
and Markdown/CSV export. Block reordering is keyboard/cut-paste rather than
drag-handles (see below).

## Deferred (in plan order)

| Area | Status |
| --- | --- |
| Custom user templates ("save page as template") | Deep duplicate covers the workflow for now; a saved-template library is the follow-up. |
| Per-page permissions & inheritance | Workspace roles, invitations, and revocable public document links ship. Signed-in page ACL inheritance remains deferred. |
| Block-level comments | Page comments, mentions, and notifications ship; block anchoring needs stable block IDs in the editor. |
| Direct OneDrive / Google Drive API upload | Both ship, alongside Azure, R2, synced-folder, and local backups. |
| More property types (email, phone, file, created-by/time) | Person and progress ship. The remaining types need explicit editor, import, and export semantics. |
| Calendar and gallery views | Timeline and saved views ship. Calendar can reuse date-property plumbing; gallery still needs a media-card contract. |
| Block drag-handle reordering | Blocks reorder via cut/paste and keyboard today; a drag handle extension is the follow-up editor task. |
| HTML/PDF export | Markdown, CSV, complete JSON import/export, and encrypted snapshots ship. Print-oriented HTML/PDF remains deferred. |
| Real-time editing, offline, native mobile, formulas, automations | Responsive mobile web ships; the remaining items are explicitly outside v1. |

## Verification

`npm run test:e2e` (`scripts/smoke.mjs`) drives a real Chromium through: register →
block editing (slash menu, markdown shortcuts) → nested page creation → database
creation → record + select value → board view → record-as-page → search → Markdown
and CSV export → trash/restore → logout/login. All 16 checks pass against a
production build.
