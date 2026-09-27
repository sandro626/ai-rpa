# AIVane Browser Bridge Extension

This Manifest V3 extension lets the AIVane JVM runtime control an attended
Chrome, Edge, or compatible Chromium browser profile without launching an
automation-specific browser process. The browser keeps ownership of cookies
and login state. AIVane opens and closes only the tabs owned by each AIVane
session.

## Development installation

1. Start an AIVane local runtime or Local Workbench.
2. Open `chrome://extensions`, `edge://extensions`, or the compatible
   browser's extension-management page.
3. Enable developer mode and choose **Load unpacked**.
4. Select this `browser-extension` directory.
5. Open the extension's **Options** page and confirm that the bridge is
   connected. Change the profile label only when an Application explicitly
   selects that label.

No **Allow User Scripts** switch is required. Application JavaScript executes
through Chrome DevTools Protocol in a named isolated world.

The default profile label is `default`. Install or enable the extension in the
browser profile whose website login state AIVane should reuse. Each profile
generates its own client identity and 256-bit bridge secret.

## Production distribution

### Shared language setting

Choose **Settings → Language** in the extension, the language control in
Recorder's sidebar, or Workbench's language menu. The local components share
one per-user preference at `~/AIVane/config/ui-language.json`:

- **Automatic (browser language)** uses the browser that first connects, or
  the browser in which Automatic was last selected. Other browsers follow
  that choice, avoiding conflicting automatic updates. Before a browser has
  connected, the desktop host uses its system display language.
- **English** and **Simplified Chinese** override automatic detection across
  the extension, local Workbench, Recorder web UI, native toolbar, and new
  Recorder AI requests. Unsupported automatic languages fall back to English.

Open pages synchronize within a few seconds without reloading or discarding
draft input. An offline extension uses its last synchronized language; saving
a new choice requires the local Recorder service. SaaS account preferences
remain account-scoped. Existing workflow names, recorded website text and
previous AI replies retain their original content.

Chrome controls the extension's name and description using the browser locale
and the packaged `_locales` catalogs. Manual language selection controls the
extension's own interface.

### Installation

`Load unpacked` is a development path, not a production installer.

- On Windows, Workbench's **Browser...** action can register the signed CRX
  for an explicitly selected Chrome or Edge browser. It writes only the
  current-user external-extension registration and then opens the browser's
  Extensions page for confirmation. Modern Chrome can disable an externally
  registered CRX that is not recognized as a Chrome Web Store installation.
- A normal Chrome installation must use the Chrome Web Store listing and let
  the user confirm installation. Use the Edge Add-ons listing or the
  user-confirmed local-CRX path for Edge.
- A managed enterprise may use the browser vendor's extension-install policy.
- A desktop installer should detect the operating system's default HTTPS
  browser. If it is a supported Chromium browser, that browser is the first
  installation target; otherwise the setup UI should offer installed Chrome
  and Edge explicitly.
- Do not silently write browser policy or local-CRX registry keys. The
  Workbench action is deliberately user-confirmed and scopes registration to
  the browser the user chose.
- The user must select the browser profile whose login state the workflow
  should reuse. Installing into every profile would increase both privilege
  and user friction.

The root Gradle task `browserExtensionZip` creates the deterministic store
submission archive:

```sh
./gradlew browserExtensionZip
```

A release installer still needs the stable Chrome Web Store and Edge Add-ons
IDs. Until those IDs exist, the packaged unpacked directory is for acceptance
and developer use only.

## Recorder wake-up with Native Messaging

Extension version 0.6 uses the `com.aivane.recorder` Native Messaging Host.
When the user clicks **Start recording** while the Recorder is offline, the
extension asks the installed Windows application to start and then continues
the recording request automatically. The installed application presents a
frameless always-on-top native toolbar; the extension no longer creates a
browser popup for that toolbar. Native Messaging does not carry recording
events or browser commands; those continue to use the loopback APIs.

For a development installation:

```sh
./gradlew :recorder-local-windows:installNativeMessagingHost
```

This builds a Windows application image and writes current-user Host
registration for Chrome and Edge. Reload the unpacked extension after changing
its manifest. The development extension ID is
`jboakpibbikbmjlcgopadnmfnjpgpnkc`; a store release must update the Host
allowlist to the final store ID.

## Configuration

The options page stores configuration in extension-local storage. The
extension creates and persists `clientId` and `bridgeSecret` automatically;
neither value is shown in the options UI.

```js
await chrome.storage.local.set({
  bridgeBaseUrl: "http://127.0.0.1:32146/aivane/browser/v1/",
  profileId: "taobao-monitor",
  browserName: "chrome",
  pollWaitMs: 25000
});
```

The bridge endpoint must use HTTP loopback (`localhost`, `127.0.0.1`, or
`::1`). Configuration changes restart the connector.

Applications do not need to enumerate these clients before opening a browser.
Set `web_type` to `chrome` or `edge` on `web.create` or `web.get` to select that
connected browser directly. Add `profileId` only when more than one profile of
the same browser is connected.

## HTTP bridge contract

All endpoints are `POST` requests with JSON bodies. Every request contains the
extension-generated `bridgeSecret`.

- `connect`: `{clientId, bridgeSecret, profileId, browserName,
  extensionVersion}`
- `poll`: `{clientId, bridgeSecret, waitMs}`
- `respond`: `{clientId, bridgeSecret, type:"response",
  protocolVersion:"1.0", id, ok, result?, error?}`
- `disconnect`: `{clientId, bridgeSecret}`

`poll` returns either `request: null` or:

```json
{
  "ok": true,
  "request": {
    "type": "request",
    "protocolVersion": "1.0",
    "id": "request-id",
    "deadlineEpochMs": 1784894000000,
    "method": "element.click",
    "params": {
      "sessionId": "session-id",
      "tabId": 7,
      "locator": {
        "strategy": "css",
        "value": "[data-sku-id='123']",
        "index": 0
      }
    }
  }
}
```

The extension rejects an expired command before performing a browser side
effect. The JVM removes an unpolled command when its deadline expires.

The first valid extension origin pairs with a bridge process. Subsequent
requests require the client-specific secret, and a different extension origin
is rejected for the lifetime of that bridge process. This is a loopback
trust-on-first-use boundary; a future managed release can provision an
installer-generated pairing token.

## Supported commands

- `bridge.ping`
- `session.attach`, `session.get`, `session.detach`
- `tab.list`, `tab.get`, `tab.create`, `tab.activate`, `tab.close`,
  `tab.navigate`, `tab.reload`, `tab.back`, `tab.forward`, `tab.wait`
- `element.get`, `element.getAll`, `element.query`, `element.queryAll`,
  `element.click`, `element.hover`, `element.input`, `element.select`,
  `element.getText`, `element.getAttribute`, `element.wait`,
  `element.setInputFiles`
- `script.execute`
- `screenshot.capture`
- `snapshot.capture`

Element locators accept CSS, XPath, and the recorder compatibility subset
`text=...`, `:visible`, `:has-text("...")`, and `>> nth=N`.

Navigation uses `chrome.tabs` plus pre-armed `chrome.webNavigation` listeners.
Fixed DOM helpers run through `chrome.scripting` in the extension `ISOLATED`
world. Application scripts run through `Page.createIsolatedWorld` and
`Runtime.evaluate`. Clicks, hover, text input, background/full-page/element
screenshots, and file input assignment use Chrome DevTools Protocol. A viewport
screenshot of the active session tab uses `chrome.tabs.captureVisibleTab`.

## Security and browser limitations

- The extension does not hide automation or modify browser fingerprints.
- Chrome may display a debugger notification while a debugger command is
  active.
- Chrome internal pages, extension stores, and other protected pages cannot be
  scripted.
- Active viewport screenshots avoid debugger attachment. Background,
  full-page, and element screenshots use `Page.captureScreenshot`, so an
  AIVane-owned background tab does not need to become the user's active tab.
- Debugger commands are serialized by their real tab ID and guarded by an
  overall action deadline. A late attach remains a recovery barrier until it
  can be detached. After a timed-out command, a confirmed detach releases the
  tab even if Chrome never settles the old command promise. An unconfirmed
  detach quarantines that tab instead of risking a newer debugger generation.
- File uploads require absolute paths on the same computer. The JVM validates
  path containment before the extension calls `DOM.setFileInputFiles`.
- The extension receives broad site access because workflows can target
  arbitrary pages. Enable it only in profiles the user intends AIVane to
  control.
- One bridge process binds one configured loopback port and pairs with one
  extension origin. Concurrent local runtimes must use different bridge ports.

## Tests

The unit tests use only Node.js built-ins:

```sh
npm test
```
