# Geometry Scale Tool

Standalone ArcGIS Maps SDK for JavaScript 4.x web app (Vite + React + TypeScript) for proportionally scaling polygon features and writing edits back to the same hosted feature layer.

## Default target layer

- `https://services1.arcgis.com/gGHDlz6USftL5Pau/arcgis/rest/services/extents/FeatureServer/0`

## Query parameters

- `portalUrl` (default: `https://www.arcgis.com`)
- `layerUrl` (default: target layer above)
- `where` (default: `1=1`)
- `clientId` (required for OAuth sign-in)

Example:

```text
https://aaronwright-usfs.github.io/geometry-scale-tool/?clientId=YOUR_APP_ID&layerUrl=https://services1.arcgis.com/gGHDlz6USftL5Pau/arcgis/rest/services/extents/FeatureServer/0&where=1%3D1
```

## OAuth setup (ArcGIS Online)

1. In ArcGIS Online, register an OAuth application.
2. Add this redirect URI exactly:
   - `https://aaronwright-usfs.github.io/geometry-scale-tool/oauth-callback.html`
3. Use the app's client ID as `clientId` in the tool URL.

If OAuth fails while embedded in Experience Builder iframe, the app shows a clear warning with an **Open in new tab** link to the same URL.

## Development

```bash
npm install
npm run dev
```

## Build

```bash
npm run build
```

The Vite base path is configured for GitHub Pages project hosting:

- `base: '/geometry-scale-tool/'`

## Deploy

A GitHub Actions workflow is included at `.github/workflows/deploy-pages.yml`.
It deploys the static `dist/` site to GitHub Pages on push to `main`.
