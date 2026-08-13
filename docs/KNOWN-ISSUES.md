# Known issues

Everything here is real, reproduced, and currently unfixed. Maintained through
the 1.2.2 release sweep. Anything a sweep found and fixed is not listed - see
the git log and [CHANGELOG-HARDENING.md](CHANGELOG-HARDENING.md) for what closed.

Nothing here loses data. That is a deliberate bar: data-loss defects were
fixed rather than recorded, and if one ever lands in this file it should be at
the top with a date and an owner.

## Product limitations

### Windows: `keel stop` will not kill a process it cannot identify

`bin/keel.mjs`

On Windows the CLI verifies a PID by reading its command line (PowerShell CIM,
falling back to `wmic`). If neither query is available, `keel stop` refuses to
`taskkill /F /T` rather than risk killing an unrelated process that inherited a
recycled PID. The user is told exactly what to do instead.

This is the right trade - the alternative is force-killing a stranger's
process - but it does mean a Windows machine with both query methods
unavailable cannot stop a server through the CLI.

## Test and tooling notes

These are not app bugs, but they cost real time to rediscover.

### Browser and production-build requirements

The package exposes 44 named `test:*` commands. `npm test` directly invokes 35
of them, plus typecheck and lint. Run a production build first: ten included
suites launch `next start` against isolated databases.

| Suite | Needs |
|---|---|
| `npm test` | `npm run build` first |
| `test:browser` (`test:editor`, `test:graph-browser`, `test:split-browser`) | a current build and Chromium (auto-detected) |
| `test:e2e` | Chromium and a server you started yourself with `npm run build && npm start` |
| `test:authz`, `test:perf`, `test:perf-scale` | a current build; each script starts its own isolated server |

The OAuth, operator-settings, and mobile `*-ui` checks inside `npm test` are
static interface contracts and do not launch a browser. The release pass still
performs rendered browser checks separately.

### Chromium is auto-detected, not pinned

`scripts/find-chromium.mjs`

`playwright-core` launches only the exact revision it was built against, and it
ships no installer (that lives in `@playwright/test`). On a machine whose cache
holds a neighbouring revision, every browser suite died at launch with
`Executable doesn't exist … chromium_headless_shell-1228` - indistinguishable
from a broken app, and easy to mistake for one.

The suites now find whatever Chromium is actually present (cache first, then a
system Chrome), preferring full builds over headless shells. `CHROMIUM=<path>`
still overrides. None of these suites do screenshot diffing, so an exact
revision does not matter.

### Chrome's HTTPS-First Mode logs an error against a dev server

`scripts/editor-check.mjs`

Chrome speculatively re-requests a plain-HTTP origin over https and logs the
refusal as `ERR_SSL_PROTOCOL_ERROR`. That is the browser's behaviour against
`http://127.0.0.1`, not the page's, so the "no console errors after reload"
check ignores that one string specifically rather than muting the whole check.
