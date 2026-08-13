# Keel roadmap

Where Keel is, and where it could go. Current through the 1.2.4 security,
correctness, performance, packaging, and responsive-layout passes. Ordered by
value ÷ effort, not by how interesting it is to build.

## Shipped (1.x)

Editor with wikilinks/backlinks/tags · databases with table/list/board/mind-map/
timeline views · kanban with WIP limits and swimlanes · mind map ↔ board round
trip · daily notes · focus mode · split view · sequence reading · graph view ·
attachments (in-DB) · full-text search · WebAuthn 2FA · audit log · encrypted
snapshots to local/Drive/OneDrive/Azure/R2 · Litestream replication · OneNote
mirror · responsive mobile browser shell · in-app restart + update check · the
`keel` CLI · GitHub release tarballs · guided shell/PowerShell installers ·
Docker/cloud installs · migration between supported install types.

## Near term - high value, low risk

1. **Public page sharing (read-only links).** The `RichDoc` renderer built for
   sequence reading already renders stored document JSON safely server-side; a
   `/share/<token>` route over it is mostly plumbing (a `PageShare` table, a
   token, a toggle in the page header). The single most-requested notebook
   feature Keel doesn't have.
2. **Server-side database filter/sort/pagination.** Views currently sort and
   filter in memory. For databases past a few thousand rows this is the first
   real scaling wall. Push the active view's filter/sort into the Prisma query;
   the saved-view model already carries the spec.
3. **Command palette (⌘K everywhere).** Search exists; make it a jump-to-
   anything: pages, views, actions ("new daily note", "back up now"). Low
   effort, big perceived-speed win.
4. **Trash retention + undo toast.** Soft-delete exists; add "undo" after
   delete and a configurable purge age. Cheap insurance against the one
   irreversible action in the app.

## Medium term - real features, real effort

5. **Real-time collaboration.** The hard one. TipTap has a Yjs binding; the
   blocker is the single-process SQLite model - collaboration wants a shared
   awareness channel. Scoped as "two tabs of the same user first, multi-user
   later," it's tractable. Highest ceiling of anything here.
6. **Templated databases / property formulas.** A `formula` property type
   (rollups, simple arithmetic across properties). Notion's stickiest feature.
7. **Calendar view** as a sixth saved-view type, over any date property -
   reuses the timeline view's date plumbing.
8. **Import from Notion / Obsidian / Markdown folder.** The OneNote mirror
   proved the ingestion pattern; a Markdown/Notion-export importer widens the
   on-ramp enormously.

## Longer term - wishlist

9. **End-to-end encryption option** for the notebook at rest (beyond snapshot
    encryption) - a genuine differentiator, genuinely hard.
10. **Plugin/extension API** for custom blocks and property types.
11. **Independent workspace ownership and cross-instance federation.** Switching
    among workspaces that invited the same account already ships. The remaining
    work is creating and owning several independent notebooks, then optionally
    linking notebooks across Keel servers.
12. **AI, opt-in and local-only.** The README says "No AI" as a promise about
    the default, not a prohibition forever; if it ever lands it should be a
    local model the user runs, never a phone-home.

## Fixed - the mind map flattening was data loss, not a layout bug

The mind map rendered every node at x = 0, a flat column with no branches. The
obvious reading - a layout or rendering fault - was wrong, and chasing it cost
most of a day. `layoutMindMap` was correct in isolation, the template wrote a
correct tree, and `getDatabaseDTO` passed `parentRecordId` through faithfully.
Every component was right and the result was still wrong, because by the time
the page rendered **the parent links were no longer in the database**.

`ensureSchema()`, the self-migrator that makes updates seamless for installs
with no Prisma CLI, replayed any shipped migration missing from its ledger.
SQLite cannot add a foreign key with ALTER TABLE, so Prisma's migration for the
record tree does the standard rebuild: create `new_DatabaseRecord`, copy the
columns that existed when it was authored, drop the original, rename. Replayed
against a database already carrying the newer columns, every statement
succeeds - and the copy silently drops `parentRecordId`, `mapX`, `mapY` and
`collapsed`. The tree was written correctly and erased on the next boot.

Two things made it survive review. The code asserted its migrations were
"additive by policy (enforced by review, asserted by the integrity suite's
replay check)" - but no such check existed; the integrity suite only verifies
that every model appears somewhere in the migrations. And the failure is
silent: nothing errors, nothing is logged, the row count is unchanged, and only
columns added after the migration was written are affected.

The fix is `alreadySatisfied()` in `src/lib/schema-migrate.ts`: derive the
tables, columns and indexes a migration would create from its own SQL, and if
the database already has all of them, record it as applied rather than run it.
`scripts/migration-replay-check.mjs` now proves both halves - an
ahead-of-ledger database keeps its tree, and a genuinely older one still gets
migrated. Schema management also moved out of `server-init.ts` into its own
module, so it no longer drags in backups and request context.

**Who was exposed:** Docker and the installers run `prisma migrate deploy`, so
`_prisma_migrations` exists and `ensureSchema()` returns early - those installs
were never at risk. The exposure was the release-tarball or other self-migrating
path, for any database bootstrapped with `prisma db push` or restored from a
snapshot without the migration ledger.

**Worth taking from it:** a comment claiming a test exists is not a test, and a
migration that "only adds things" is a claim about the SQL, not about the
tooling that generates it.

## Known issues

Current unfixed defects and limitations live in [KNOWN-ISSUES.md](KNOWN-ISSUES.md),
kept separate from this file: that one is what is wrong today, this one is what
to build next.

## Debt worth paying down

- The attachment serve path loads the whole blob into heap (bounded by the
  50 MB cap). If attachments grow, add HTTP Range + streaming - but that fights
  the in-DB storage that makes backups atomic, so it's a real trade to weigh.
- `bin/keel.mjs` now has managed-secret portability coverage, but native
  launchd, systemd, and Windows Scheduled Task lifecycle tests would still catch
  OS-specific failures that a containerized packaging check cannot.
- The `any`-typed cheerio nodes in `onenote.ts` should get real types once the
  HTML→TipTap conversion has tests around it.
