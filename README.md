# Popup as Tab

Popup as Tab converts popup windows into regular tabs in your current Chrome or Edge window.

## Features

- Turn popup windows into regular tabs automatically.
- Choose whether popup tabs stay in opening order or appear beside the tab that opened them.
- Open new tabs beside the current tab or keep the browser default position.
- Keep converted popups outside the pinned-tab area and preserve tab groups when possible.
- Add exclusion rules for websites, specific pages, or wildcard URL patterns that should remain in popup windows.

## Permissions

- `alarms`: clears temporary diagnostic badges after a set time, even if the service worker restarts.
- `storage`: saves the enabled state, placement preferences, exclusion rules, diagnostics, and session state.
- `tabs`: identifies, reads, moves, orders, activates, and groups popup and New Tab pages.

## Development

Install dependencies and build the extension:

```powershell
npm ci
npm run build
```

`npm run build` cleans `dist/`, compiles the TypeScript service worker, and copies the manifest, popup UI, and icons into `dist/`.

### Load unpacked

1. Run `npm run build`.
2. Open `chrome://extensions` or `edge://extensions`.
3. Enable Developer mode and choose **Load unpacked**.
4. Select the generated `dist/` directory.
5. Rebuild and reload the extension after making changes.

### Commands

- `npm run typecheck`: run TypeScript checks without generating files.
- `npm test`: build the extension and run the automated test suite.
- `npm run verify`: run type checking, tests, a clean build, and deployment validation.
- `npm run package`: verify the project and create the release ZIP.

## Release

Run `package-extension.bat` on Windows or run:

```powershell
npm run package
```

The verified archive is written to `release/popup-as-tab-<version>.zip`. Upload this ZIP rather than the project root or `dist/` directory.
