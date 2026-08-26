# Tablet preview

This fork can be built by GitHub Actions and published as a static GitHub Pages site for tablet testing.

## Deployment

Workflow:

```text
.github/workflows/deploy-pages.yml
```

On each push to `main`, the workflow:

```text
checkout
→ Node 22
→ npm ci --no-audit --no-fund
→ npm run build
→ upload dist/
→ deploy to GitHub Pages
```

The repository build is self-contained: `npm run build` generates the required icons and language files before Parcel bundles the standalone app.

## One-time GitHub Pages setup

If Pages has not yet been enabled for this repository, an administrator must do this once in GitHub:

```text
Repository Settings
→ Pages
→ Build and deployment
→ Source: GitHub Actions
```

After that, pushes to `main` deploy automatically.

Expected project-site URL:

```text
https://pokemonrgby-crypto.github.io/klecks/
```

## Tablet use

Open the Pages URL in a modern tablet browser. Klecks already supports tablet form factors, touch gestures, and pen input.

For a more app-like launch experience, the browser may be used to add the site to the tablet home screen after the Pages deployment is reachable.

## PC Control relationship

`.pc-workspace.json` declares this repository as a bounded `node-npm` PC Control workspace. PC Control can therefore validate the same source with its fixed local build sequence:

```text
npm ci --no-audit --no-fund
npm run build
```

PC Control is for real-machine build/diagnostic work. GitHub Pages is the convenient distribution path for interactive browser testing on the tablet; the tablet does not need the Windows PC to remain online once the site has been deployed.
