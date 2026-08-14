# Popup as Tab

Popup as Tab moves popup windows into your current browser window as regular tabs. It works with Chrome and Edge.

## Features

- Places a popup next to the tab that opened it.
- Can keep multiple popups in opening order or place the newest popup beside its opener.
- Can open the New Tab page next to the current tab.
- Lets you exclude sites that need to stay in a separate popup, such as sign-in or payment pages.
- Can be turned on or off from the extension popup.

## Development

Run `npm run build` to compile the service worker and copy all runtime assets into `dist/`.

To load the extension locally:

1. Run `npm run build`.
2. Open `chrome://extensions` or `edge://extensions`.
3. Enable Developer mode and choose **Load unpacked**.
4. Select the generated `dist/` directory.

After making changes, rebuild and reload the extension. Run `npm run verify` before packaging a release.
