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

## Refresh the product screenshots

The homepage screenshots come from a real Keel browser session backed by an
isolated database containing synthetic data. The capture removes that scratch
database when it finishes, so no local notebook content reaches the website.

```bash
npm run build
npm run site:capture
npm run site:check
```

## Deploy

```bash
npm run site:deploy
```

The Worker config attaches `keelnotes.com` and `www.keelnotes.com` as custom
domains. Plain HTTP redirects to HTTPS, and the `www` hostname redirects to the
apex. Security headers are added by the Worker before every static-asset response.
