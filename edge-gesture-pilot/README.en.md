# Gesture Pilot

**Record mouse & keyboard actions in your browser → save them as step scripts → replay them on a schedule.**

A Manifest V3 extension for Microsoft Edge and Chromium browsers, built for automating repetitive page operations.

[English](README.md) · [简体中文](README.zh-CN.md)

---

## Features

- **Record once, replay forever** — captures clicks, typing, selects, key presses, scrolling and **drags**
- **Two replay engines** — synthetic events (lightweight, no extra prompts) or real CDP input via `chrome.debugger` (`isTrusted === true`)
- **Three ways to fire** — manual, timer (`chrome.alarms` / offscreen), or **page-load triggers** with domain rules
- **Live on-page HUD** — mouse trail, click ripples, drag lines, keystroke pills, all while recording *and* replaying
- **Robust element locators** — `data-testid` → stable id → name → aria → placeholder → CSS path. Coordinates are *never* used for targeting
- **iframe aware** — records and replays across frames
- **Fails loudly** — every error surfaces in the popup; no silent no-ops

---

## Install

### From a release build (recommended)

1. Download and unzip `edge-gesture-pilot-<version>.zip` — you get an `edge-gesture-pilot/` folder
2. Open `edge://extensions/` (`chrome://extensions/` on Chrome)
3. Turn on **Developer mode** (top-right / bottom-left)
4. Click **Load unpacked** and select that `edge-gesture-pilot` folder

A blue cursor icon appears in the toolbar. **It turns red while recording**, so you can tell the state at a glance even with the popup closed.

> To automate `file://` pages, enable **Allow access to file URLs** on the extension's detail page.

### From source

```bash
python build-extension.py
```

This regenerates `icons/` (pure-stdlib PNG rendering, zero dependencies), syncs the READMEs, validates that everything the manifest references actually exists, and writes `dist/edge-gesture-pilot-<version>.zip`.

Then load the `edge-gesture-pilot/` folder as above.

### Why there is no `.crx`

Windows Edge blocks `.crx` installs from outside the store — Microsoft has publicly moved to restrict sideloaded extensions, and Edge Canary has already removed the "Allow extensions from other stores" toggle. Dragging a `.crx` onto the extensions page will usually just fail, and packing one yourself via `edge://extensions` → **Pack extension** doesn't help either; installation is blocked all the same.

The only path to a genuine one-click install is publishing to the Edge Add-ons store (free developer account + review + privacy policy), which takes a few days.

> **If you do pack your own `.crx`:** the `.pem` file it generates is your **private signing key**. Never commit it, never share it. Anyone who has it can sign updates as your extension ID. It is listed in `.gitignore` for exactly this reason.

### Permission warnings

Two warnings appear on install. Both are expected, not misconfiguration:

| Warning | Cause |
|---|---|
| Read and change all your data on all websites | `host_permissions: <all_urls>` — recording/replaying requires injecting into arbitrary pages |
| Debug this browser | `debugger` permission — needed by the CDP input engine |

If you only use the synthetic engine, remove `"debugger"` from `permissions` in `manifest.json` and the second warning disappears. The CDP option in settings will stop working.

---

## Usage

### Recording

1. Open the target page and navigate to the starting state
2. Click the extension icon → **Start recording** (the icon turns red; you can close the popup, recording continues in the page)
3. Perform the flow normally: clicks, typing, selects, Enter, scrolling, drags
4. Click the icon again → **Stop & save**

The captured script appears in the popup's list.

### Scheduling

Expand a script card and tick **Run on a schedule**:

| Interval | Mechanism | Notes |
|---|---|---|
| **≥ 60 s** | `chrome.alarms` | Persistent, survives service worker eviction |
| **< 60 s** | `setInterval` in an offscreen document | The SW can't stay alive that long |

- **Every** — a number plus a unit (seconds / minutes)
- **Daily** — a time of day. Uses a one-shot alarm that re-arms itself after each run, which handles DST correctly

### Replay engines

| | Synthetic (default) | CDP real input |
|---|---|---|
| How | `dispatchEvent` inside a content script | `chrome.debugger` + `Input.dispatchMouseEvent` |
| `isTrusted` | `false` | `true` |
| Extra permission prompt | no | yes (`debugger`) |
| Page banner | none | "is being debugged" strip at the top |
| With DevTools open | works | **mutually exclusive** |
| Cross-origin iframes | supported | **not supported** (coordinates can't be resolved) |
| Best for | internal tools, legacy pages | complex SPAs, "must look exactly like a human" |

Set the global default in **Settings**, or override per script (the script wins).

---

## In-page live HUD

While recording — and while replaying — a transparent overlay shows what's happening. It never blocks interaction and can be turned off in settings.

| Element | Position | Description |
|---|---|---|
| **Status badge** | top-right | `● Recording · N steps`, pulsing red dot. Top frame only |
| **Mouse trail** | follows the pointer | Blue fading trail plus a pointer ring |
| **Click ripple** | at the click point | Expanding ring — **left = blue, middle = green, right = amber** — with a label naming the target element |
| **Drag line** | from press to release | Amber animated dashed line, labelled `drag · recorded` |
| **Keystrokes** | bottom-centre | Transparent pills: combos like `Ctrl`+`Shift`+`S` stay lit for a second; `Enter`/`Tab`/`←` likewise; printable characters flash briefly |
| **Input echo** | bottom-centre | A pill like `input hello world` showing what an `input`/`select` step wrote |

### Keyboard echo works in both directions

The two engines need different plumbing:

- **Synthetic engine** — `pressKey()` calls `GX_HUD.key()` directly; `input`/`select` steps call `GX_HUD.input()`
- **CDP engine** — key presses are delivered by the service worker via `Input.dispatchKeyEvent`. **The page never sees the events at all**, so the background has to push the echo in with `GX_HUD_KEY` / `GX_HUD_INPUT` messages
- **Where modifiers come from** — while recording, `Ctrl` has its own real keydown/keyup. During replay there is only a single `key` step, so `Ctrl` must be *synthesized* from the `ctrl`/`alt`/`shift`/`meta` flags on `step.key`. Synthesized modifiers have **no matching keyup**, so they must fade out together with the main key — otherwise they pile up at the bottom of the page forever

### Implementation notes

- The whole layer lives in a **Shadow DOM** and is `pointer-events: none` — page CSS can't touch it, and it can't steal the page's mouse events (which would record clicks on the HUD itself)
- The trail and ripples draw to a **canvas** (avoids churning hundreds of DOM nodes); text pills are DOM
- Every frame draws in its own coordinate space, so actions inside iframes get feedback too — but the **status badge only renders in the top frame**, otherwise a page with many iframes would sprout a row of them
- Frames smaller than 240×160 opt out entirely (sites often embed 1×1 tracking iframes)
- Every HUD entry point swallows its own exceptions: **a broken overlay must never break recording**
- Under the CDP engine only the top frame draws ripples — CDP works in top-level viewport coordinates, which would be wrong inside a subframe

Toggle it off via **Settings → Show live overlay while recording**.

---

## Triggers

Besides timers, a script can **run automatically when a matching page loads**. Configure it by expanding a script card.

| Setting | Description |
|---|---|
| **Trigger on page load** | Master switch |
| **Domains** | Empty = every domain. Separated by commas / semicolons / whitespace |
| **Wait N seconds after load** | Delay before acting, giving SPAs time to render |
| **Wait for element** | A CSS selector. When set, the script waits for it and **gives up if it never appears** — far more reliable than a fixed delay |
| **Wait until tab is focused** | Background tabs won't trigger until you switch to them |
| **Cooldown (seconds)** | Minimum gap between two trigger firings |
| **Only once per page load** | On by default. Counted per page load, so a refresh counts as a new one |

### Domain patterns

| Pattern | Matches |
|---|---|
| `example.com` | `example.com` and all subdomains (`a.example.com`, `a.b.example.com`) |
| `*.example.com` | Subdomains only, not `example.com` itself |
| `10.0.0.5:8080` | A host with a port |
| `https://a.com/admin` | With a scheme, matched as a whole-URL prefix (paths allowed) |

`notexample.com`, `evil-example.com` and `example.com.evil.com` all **fail** to match `example.com` — suffix spoofing is explicitly blocked by the matcher.

While a card is expanded the UI shows **"current page matches / doesn't match"** in real time, so you don't have to guess why nothing fired.

### How triggers stay under control

A script may navigate, and navigation re-satisfies the trigger condition — done naively that's an infinite loop. Three gates:

1. **Once per page load** — each content-script instance generates a `loadId`; the background remembers which one already fired
2. **Cooldown** — a minimum gap between firings
3. **Skip while another script is running**, so two automations never fight over the same page

All three live in the service worker on purpose: a content script is a fresh instance on every page load and cannot remember "I just ran", yet these gates specifically need memory that spans page loads.

Skip reasons are logged to the page console with a `[Gesture Pilot]` prefix.

---

## Drag

Drags are recorded as their own `drag` step and replayed along the original path.

- **The path is stored as offsets relative to the drag's start point**, so minor layout shifts still land somewhere sensible
- Sampled every 25 ms, then decimated to at most 48 points before saving (raw sampling can reach several hundred points — bulky and slower to replay, with no visible difference)
- Replayed `mousemove` events carry `buttons: 1` — **without it, a page's drag logic treats them as plain movement**
- Events are dispatched to the element under the pointer (`elementFromPoint`), covering both implementations that listen on `document` and those that listen on themselves
- **Recording and replay look identical** — same fading trail, plus an amber animated dashed line during the drag itself

> **Native HTML5 drag & drop is not supported.** `draggable="true"` with `dragstart`/`dragover`/`drop` is a browser-internal mechanism that synthetic events cannot drive (it needs CDP's `Input.dispatchDragEvent`, not currently implemented). Sliders, canvas drags, and custom drags that listen for mousedown/mousemove/mouseup themselves all work fine.

---

## Troubleshooting

### Which version is actually running?

The **`v0.4.0`** chip in the popup header is the current version; hover it to see "UI vX | background vY".

If the two disagree, the popup shows a **yellow warning** below the header telling you what to do. It's detected automatically:

- The background returns its own version alongside every `SCRIPT_LIST`
- A mismatch (or a missing version field = the background is stale code) raises the warning
- Errors containing `is not defined` / `is not a function` are also classified as stale-backend

### Always reload after changing code

On `edge://extensions`, click the **↻ reload** icon on the extension's card.

> **Note:** under MV3, reloading after editing `background.js` **sometimes does not restart the service worker** — it looks like nothing changed (new popup, old background).
>
> If the version chip still disagrees after reloading, **remove** the extension and **Load unpacked** again. That always works.

### Refresh already-open tabs after installing

The classic MV3 trap: **static content scripts only apply to pages opened or reloaded after the extension loaded.**

`RECORD_START` now injects on demand (`ensureRecorderInjected`) before broadcasting, so older tabs should work too. If it still does nothing, hit **F5** on the target page — that's the fastest way to rule it out.

### "Nothing happens" now always tells you why

Earlier versions of `popup.js` had a `try/finally` with no `catch`, so a background exception became a silent no-op. Now:

- Every failure renders a red banner at the top of the popup
- If the background can't be reached at all, the message points you to `edge://extensions` → Errors and the service worker console
- `unhandledrejection` / `error` listeners guarantee no exception is ever swallowed

### Reading the real service worker logs

`edge://extensions` → this extension's card → click the **service worker** link. All `chrome.runtime.lastError`s and uncaught exceptions show up there.

### Error reference

| Symptom | Cause | Fix |
|---|---|---|
| Yellow "background is running stale code" | Files changed but the service worker didn't restart | Click ↻ reload; if that fails, remove and re-add |
| `xxx is not defined` in an error | Same — stale background | Same |
| "Cannot inject scripts into this page" | You're on `edge://`, an extension page, or a store page | Switch to a regular web page |
| "Injected but no response" | Special page, or injection blocked by CSP | Refresh and retry |
| "This page doesn't support recording" | `file://` not permitted | Enable "Allow access to file URLs" |
| "**N frames responded**, but no actions were captured" | The recording channel is fine — nothing was actually operated | Make sure you interacted with the current tab; typing inside a field is only flushed into a step **after you leave the field** |
| "**No frames responded**" | Page closed or navigated away, or injection failed | Refresh the target page |
| Element not found on replay | Locator too brittle (page structure changed) | Expand the script and pick an earlier-tier locator, or add `data-testid` to the target |
| Replay clicks but the page ignores it | The site checks `isTrusted` | Switch to the **CDP real input** engine (close DevTools first) |
| CDP mode reports "in use by DevTools" | DevTools is open | Close DevTools and retry |

### Why recording state must live in `storage.session`

An MV3 service worker is evicted after roughly **30 seconds** of idle. In practice, the moment you hit "Start recording" the popup closes (so it stops polling), and you go operate the page — the SW **will** have been evicted.

If recording state lives in SW module variables, eviction zeroes it and the steps reported by each frame are **silently dropped**. The symptom is "recording succeeded but captured zero steps".

So the current design is:

- Recording state lives in `chrome.storage.session` and survives a SW restart
- The recorder **streams steps as they happen** (250 ms debounce) and flushes again on `pagehide`, so mid-recording navigation loses nothing
- A final full report is sent on stop; the two paths are deduplicated by a per-step `sid`
- A page that reloads during recording **auto-resumes** on the same origin (via `chrome.storage.session.setAccessLevel`, so content scripts can read the recording flag)

---

## Testing

No browser is available in the sandbox, so the project ships three Node smoke-test suites that build fake `chrome.*` APIs and DOM shims, then **actually execute** the code.

```bash
node tools/mock-harness.mjs      # Service worker: recording/scheduling/replay/CDP/drag/offscreen/triggers/failure paths (67)
node tools/content-harness.mjs   # Content scripts: loading, HUD drawing & echo, drag record/replay, domain rules, trigger behaviour (138)
node tools/popup-harness.mjs     # Popup: loading, event binding, error visibility, version self-check, trigger UI (31)
```

These catch what `node --check` cannot: undefined references, misspelled fields, state machines that fall through, and errors swallowed silently.

Real defects found and fixed this way:

- `broadcast()` called but never defined (clicking "Start recording" did nothing)
- `SCRIPT_UPDATE` omitted `syncAlarms()`, so sub-minute schedules never took effect
- Recording state in SW module variables — all steps lost after SW eviction ("recording succeeded but captured zero steps")
- `flushInput` compared against a stale "initial value", discarding any single-character input
- `runStep` waited for an element on `key` steps with no locator — page-level shortcuts stalled 8 s then failed
- Synthesized modifier pills in the HUD had no keyup and accumulated forever at the bottom of the page
- Synthetic events used top-level viewport coordinates instead of frame-local ones, shifting `clientX` inside iframes
- The HUD kept redrawing at 60 fps after the pointer stopped, draining battery on long recordings

Domain matching exists twice — a reusable module (`lib/domains.js`) and an inlined copy (`content/trigger.js`, since content scripts can't `import`). `tools/content-harness.mjs` **cross-checks both against 23 shared cases** so they can't drift apart.

---

## Project layout

```
manifest.json              MV3 manifest
background.js              Service worker: message routing, scheduling, replay orchestration
lib/storage.js             Script CRUD, settings, run state, trigger defaults
lib/cdp.js                 CDP engine (chrome.debugger wrapper)
lib/domains.js             Domain matching (shared with the popup; trigger.js has an equivalent copy)
content/selector.js        Element locators + coordinate maths + controlled-component writes (all frames)
content/hud.js             In-page live overlay (trail / ripples / key pills)
content/recorder.js        Recorder (all frames)
content/replayer.js        Synthetic-event replay (injected on demand)
content/trigger.js         Page-load trigger engine (top frame only, document_idle)
offscreen/                 Sub-minute timer host
popup/                     UI
icons/                     Generated by build-extension.py (icon* = idle, rec* = recording)
tools/                     Node smoke-test harnesses
build-extension.py         Icon generation, validation, packaging
```

---

## Script data format

```jsonc
{
  "id": "s_lx8f3a",
  "name": "Orders · 10-09 14:52",
  "targetUrl": "https://example.com/orders",
  "engine": null,                    // null = inherit the global setting
  "schedule": {
    "enabled": true,
    "mode": "interval",              // interval | daily
    "everySec": 1800,                // < 60 goes to offscreen, >= 60 to alarms
    "time": "09:30"                  // used by daily mode
  },
  "trigger": {
    "enabled": true,
    "domains": ["example.com", "*.internal.test"],
    "delaySec": 3,
    "readySelector": "#app-ready",
    "readyTimeoutSec": 20,
    "requireVisible": false,
    "once": true,
    "cooldownSec": 120
  },
  "steps": [
    { "type": "click",  "locator": {}, "rel": { "x": 0.51, "y": 0.48 }, "delay": 0 },
    { "type": "input",  "locator": {}, "value": "ORD-2026", "delay": 1240 },
    { "type": "select", "locator": {}, "value": "SHIPPED",  "delay": 620 },
    { "type": "key",    "locator": {}, "key": { "key": "Enter", "code": "Enter", "vk": 13 }, "delay": 300 },
    { "type": "wheel",  "deltaY": 900, "delay": 800 },
    { "type": "drag",   "locator": {}, "rel": { "x": 0.1, "y": 0.5 },
      "path": [{ "x": 0, "y": 0 }, { "x": 60, "y": 10 }, { "x": 150, "y": 0 }], "delay": 200 }
  ]
}
```

### Locator tiers

Ordered from most to least durable:

| kind | Example | Notes |
|---|---|---|
| `attr` | `[data-testid="submit-order"]` | Explicit test attribute — the most stable option |
| `css` | `#order-filter` | Stable id (volatile ids like `btn-1697123456789` are filtered out) |
| `attr` | `[name="orderNo"]` | Form name |
| `aria` | `「Submit order」` | Accessible name / visible text, fuzzy matched |
| `attr` | `[placeholder="Order number"]` | Placeholder |
| `css` | `div:nth-of-type(2) > button:nth-of-type(1)` | Last resort, most brittle |

**Coordinates are never used for targeting** — only a relative offset inside the element (0–1) is stored for the click point, so a different window size doesn't shift anything.

---

## Implementation notes

### The service worker gets evicted

An MV3 SW is killed after ~30 s idle, therefore:

- ❌ Never schedule with `setTimeout` / `setInterval` inside the SW
- ✅ Scheduling goes through `chrome.alarms` or an offscreen document
- ✅ Run state is written to `chrome.storage.session`; the popup polls it for progress
- ✅ A per-minute watchdog alarm re-creates the offscreen document if it gets closed

### Writing to controlled components

React / Vue hijack the `value` setter on the prototype, so assigning `input.value = x` never fires `onChange`. `selector.js#setNativeValue` calls the native setter via the prototype, then dispatches `input` **and** `change`.

### Why a click also calls `el.click()`

Synthetic `mousedown` / `mouseup` only reach listeners — **link navigation, form submission and label activation are default actions that never fire**. So the code dispatches `mousedown`/`mouseup` and then calls `el.click()`. The latter dispatches *only* a `click` event, so nothing is double-triggered.

### Humanized mouse movement

On by default. A Bézier-ish curve with ease-in-out pacing plus small jitter, avoiding the "straight line at constant speed" signature of naive automation. Can be disabled in settings.

### iframes

- The recorder and selector helpers are injected into **every frame** (`all_frames: true`)
- Steps from non-top frames carry a `frameUrl`; they're reported over runtime messaging and merged by the SW in timestamp order
- On replay, `webNavigation.getAllFrames` builds a `url → frameId` map and each step is dispatched to the correct frame
- Top-frame steps deliberately omit `frameUrl` so SPA route changes don't break the match

---

## Known limitations

| Limitation | Notes |
|---|---|
| **Native HTML5 drag & drop** | `draggable="true"` + dragstart/drop can't be driven by synthetic events; needs CDP's `Input.dispatchDragEvent` |
| **Cross-frame drags** | The path is stored in the starting frame's coordinate space and isn't translated when dragging into another frame |
| **`<select>` dropdowns** | Recorded via the `change` event; the act of picking inside a native popup isn't itself captured |
| **CDP + cross-origin iframes** | Coordinates can't be resolved (`frameElement` is unreadable cross-origin); it errors out clearly rather than clicking the wrong place |
| **CDP + `<select>`** | Would need keyboard arrow simulation; falls back to synthetic events |
| **File inputs** | Setting files requires CDP's `DOM.setFileInputFiles`; only a hook point exists today |
| **SPA route changes** | Only the initial `targetUrl` is recorded; in-app navigation is treated as ordinary page state |
| **`isTrusted` checks** | Sites that verify it reject synthetic events — a hard browser limit; use the CDP engine |
| **Run failures** | After retries are exhausted: pause + desktop notification + screenshot evidence (configurable) |

### A note on offscreen `reasons`

`chrome.offscreen.createDocument`'s `reasons` enum **has no entry for "timer"**. The code passes `'WORKERS'`, the least-intrusive valid option. This is a gap in Chrome's API design, not a workaround for a mistake.

---

## Tuning reference

| Symptom | Suggestion |
|---|---|
| Slow page, elements appear late | Increase **step timeout** (default 8000 ms) |
| Element is clearly there but "not found" | Check whether you need to log in manually first; raise the timeout and retry count |
| Replay is too slow | Increase **speed** (>1 is faster), or lower the **max gap** |
| Replay is too fast, the page can't keep up | Increase **minimum gap** (default 180 ms) |
| Needs to look more human | Keep **humanized mouse** on and raise the **jitter** ceiling |
| Site validates `isTrusted` | Switch to the **CDP real input** engine (close DevTools first) |

---

## License

[MIT](LICENSE)
