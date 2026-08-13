# keelnotes.com

This directory is the static public website for Keel. It is deliberately
separate from the notebook runtime and contains no user accounts, notes,
analytics, or private deployment configuration.

## Validate

```bash
npm run site:check
```

## Preview locally

```bash
npx wrangler dev --config website/wrangler.jsonc
```

## Deploy

```bash
npm run site:deploy
```

The Worker config attaches `keelnotes.com` and `www.keelnotes.com` as custom
domains. Plain HTTP redirects to HTTPS, and the `www` hostname redirects to the
apex. Security headers are added by the Worker before every static-asset response.
