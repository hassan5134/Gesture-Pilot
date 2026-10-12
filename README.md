# Gesture Pilot

**Record mouse & keyboard actions in your browser → save them as step scripts → replay them on a schedule.**

A Manifest V3 extension for Microsoft Edge and Chromium browsers, built for automating repetitive page operations.

[English](README.md) · [简体中文](README.zh-CN.md)

---

## Features

- **Event groups** — a task is a chain of events; each one is either a recorded gesture or a piece of custom JS, freely mixed
- **Per-event entry conditions** — wait for a URL, wait for an element; failing skips just that event and the rest keep going
- **Per-step match conditions** — constrain a click with something like `.green[href]` so a same-named element elsewhere doesn't get hit
- **Debug execution log** — step-by-step records in a standalone viewer with filtering and JSON export
- **Google Drive backup** — tasks and settings into your own Drive, restorable on another machine
- **Two replay engines** — synthetic DOM events (`isTrusted=false`) and real CDP input (`isTrusted=true`)
- **Live in-page HUD** — mouse trail, click ripples, drag lines, keystroke and input echo, during both recording and replay
- **Robust locators** — `data-testid` > id > name > aria > placeholder > CSS path; coordinates are never used for targeting
- **Drag recording and replay** — paths stored as offsets from the start point, so small layout shifts still land right
- **Page-load triggers** — allowed domains, delay, wait-for-element, wait-for-focus, cooldown, once per load
- **iframe aware**, with sub-minute scheduling driven by an offscreen document

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
- **Domains** — when set, a timed run that lands on a page outside the allowed range is **skipped and reported**, so it never clicks around on the wrong site

### Managing scripts

| Action | How |
|---|---|
| **Rename** | Click the card title directly, or edit "Script name" once expanded |
| **Disable / enable** | The checkbox at the left of the card. Disabling stops timers and page triggers; **manual runs still work** |
| **Tune step delay** | The "delay xxx ms" box on each step, saved immediately |
| **Reorder steps** | The `↑` `↓` buttons per step; the ends are disabled automatically |
| **Duplicate / delete a step** | The `＋` / `✕` buttons per step |
| **Add a wait** | "＋ Insert wait" at the bottom of the step list, for slow-rendering pages |
| **Export / import** | Per script via "Export this script"; everything via **Settings → Backup & restore** |

### Event groups and custom JS

A task is no longer "a list of gestures" but an **event group**: several events chained in order.

| Event type | What it holds |
|---|---|
| **Gesture** | A recorded run of clicks / typing / drags |
| **JS** | A piece of JavaScript (Tampermonkey-style) |

The two mix freely. A typical flow: a gesture event opens the page → a JS event scrapes or computes something → another gesture event types the result into a different form.

**Every event can have its own entry condition** (checked before that event runs):

| Condition | Meaning |
|---|---|
| **URL match** | Wait until the page navigates somewhere matching. Same syntax as allowed domains: `/detail`, `detail.example.com`, `https://a.com/x` |
| **Wait for element** | Wait until this CSS selector shows up — far more reliable than a fixed delay |
| **Timeout** | Upper bound in seconds for the two conditions above |

Failing to reach a condition skips **only that event**; the rest still run. "The page happened to render slowly this time" should not take down the whole flow. Skipped events are reported in the run result.

#### JS events

Code runs in the **page's main world**, so it can reach the page's own variables (jQuery, React instances, …). The bridge object is `gp`:

| Usage | Meaning |
|---|---|
| `gp.$(sel)` / `gp.$$(sel)` | Query one / all elements |
| `gp.waitFor(sel, ms)` | Wait for an element, returns `null` on timeout |
| `gp.sleep(ms)` | Wait |
| `gp.log(...)` | Write to the execution log |
| `gp.url` / `gp.title` / `gp.task` | Current URL / title / task name |

`await` works at the top level, and `return` hands a value back (it lands in the log, which is usually how you confirm what a scraper actually found).

```js
// Pull the order ids off a list page
const rows = gp.$$('.order-row');
gp.log('rows:', rows.length);
return rows.map((r) => r.dataset.orderId);
```

**There are two execution paths.** By default it tries a lightweight injection first (fast, leaves no trace on the page). If the site's CSP forbids `eval`, it automatically falls back to the debugger interface and retries — that one shows the "being debugged" bar at the top of the page. The log records which path was actually used. You can also pin an event to "always use the debugger interface".

"Edit code" in the popup opens a separate page: the popup is 420px wide, and a few lines is all you can see.

> The code is yours and it runs unsandboxed in the page. Only run code you trust.

#### Per-step match conditions

The locator is picked automatically at record time. The moment a page has two buttons with the same label — or a list where every row looks alike — it can hit the wrong one.

Any step can carry an **extra match condition** (a CSS selector). The target element has to satisfy it too, or it does not count as found:

| Condition | Meaning |
|---|---|
| `.green` | Has the class `green` |
| `[href]` | Has an `href` attribute |
| `a.green[href^="/detail"]` | Several conditions at once |
| `:not(.disabled)` | Excludes disabled state |

Click **＋⌕** on a step to add one. Recording also stashes the target's classes and attributes, so the UI offers clickable chips — one tap builds `.green` for you instead of sending you back to DevTools to copy a selector by hand.

When the condition does not hold the step is treated as "not found yet", so it **keeps waiting** rather than clicking the wrong element. A malformed selector is reported immediately, rather than showing up as "element not found" and sending you off to suspect the page.

### Keyboard shortcuts and context menu

For when you'd rather not go hunting for the toolbar icon:

| Action | Default |
|---|---|
| Start / stop recording | `Ctrl+Shift+E` |
| Run the script matching the current page | `Ctrl+Shift+K` |

Right-clicking anywhere on a page also gives you **Record / stop this page** and **Run script ▸** (listing every enabled script; past 15 it points you to the panel instead).

Rebind them at `edge://extensions/shortcuts`.

"Run the script matching the current page" picks the first hit in this order: a matching page-trigger rule → a matching schedule domain → a same-origin `targetUrl`. If nothing matches it tells you why rather than **running some arbitrary script**.

### Backup and restore

Under **Settings → Backup & restore**:

- **Export all scripts** — downloads a JSON file with the complete configuration and steps of every script
- **Paste from clipboard** — fills the box for you (falls back to manual paste if clipboard access is refused)
- **Import** — validates script by script: **ids that already exist are skipped, never overwritten**, and structurally broken entries are skipped too

Import is additive by design, so re-importing the same backup is idempotent and can't clobber your existing setup.

### Cloud backup (Google Drive)

Local export is fine for moving things around once; across machines it gets tedious. Cloud backup keeps your tasks in your own Google Drive.

**You need to create an OAuth client first** (one time, free):

1. Create a project in the [Google Cloud Console](https://console.cloud.google.com/)
2. Enable the **Google Drive API**
3. Credentials → create an **OAuth client ID**, type **Web application**
4. Paste the **redirect URI** shown in the extension's settings (looks like `https://<your-extension-id>.chromiumapp.org/`) into its "Authorized redirect URIs"
5. Paste the resulting Client ID back into the extension and hit "Connect Google Drive"

Why not ship a built-in Client ID: an open repository cannot hold client credentials, and the redirect address has to change with the extension ID. Enter it once and it keeps working.

| Button | What it does |
|---|---|
| **Connect Google Drive** | OAuth2 + PKCE; the refresh token is stored locally so you stay signed in |
| **Back up now** | Uploads every task and your settings, **keeping only the newest 20** |
| **Cloud backups** | Lists the files, each with a "Restore" button |
| **Disconnect** | Clears the local token only; cloud files are untouched |

Backups land in a Drive folder named **Gesture Pilot Backups** — visible to you, downloadable, deletable. The scope is `drive.file`, so the extension **only ever sees files it created itself** and nothing else in your Drive.

Restore is additive: tasks with an id that already exists are skipped, never overwritten, so restoring the same backup twice is harmless. The backup format is identical to the local export — the two are interchangeable.

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

## Debug: the execution log

When something goes wrong the question is always "how far did it get, and where did it stop". Turn on **Settings → Debug** and it records:

- task start / finish, target page, engine in use, what triggered it
- whether each event's entry condition was met, and which selector it was waiting on when it wasn't
- every step's type, delay and actual elapsed time
- which execution path a JS event took, what it returned, and anything it sent to `console.log`
- on failure, the exact event and step index

**Settings → Open log viewer** opens a standalone page: filter by task or level, search, clear, export as JSON.

Logs live locally (`storage.local`) in a rolling buffer that drops the oldest entries past the limit (1000 by default). With Debug off, every instrumentation point returns on the first line, so the overhead is negligible — leave it off and switch it on when you need it.

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
| **Domains** | Empty = every domain. Separated by commas / semicolons / whitespace. The schedule section has its own copy — the two paths are independent |
| **Wait N seconds after load** | Delay before acting, giving SPAs time to render |
| **Wait for element** | A CSS selector. When set, the script waits for it and **gives up if it never appears** — far more reliable than a fixed delay |
| **Wait until tab is focused** | Background tabs won't trigger until you switch to them |
| **Cooldown (seconds)** | Minimum gap between two **automatic** firings — page load, refresh and scheduled runs all count. **A manual run ignores it** |
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

A task may navigate, and navigation re-satisfies the trigger condition — done naively that is an infinite loop. Three gates:

1. **Once per page load** — each content-script instance generates a `loadId`; the background remembers which one already fired
2. **Cooldown** — applies to every **automatic** path: page load, refresh, scheduled runs
3. **Skip while another task is running**, so two automations never fight over the same page

**Only manual execution bypasses the cooldown.** Clicking "Run" or pressing `Ctrl+Shift+K` is an explicit intent and should not be blocked by a de-duplication gate.

> v0.5.1 briefly exempted user-initiated reloads from the cooldown. That turned into "every refresh fires it", which is harder to reason about than the original problem, so 0.6.0 reverted it: automatic is automatic, manual is manual.

The navigation source (`transitionType` from `chrome.webNavigation.onCommitted`) is still recorded in the log and the trigger record, so you can check afterwards whether a given load came from a refresh or from the page navigating itself.

All three gates live in the service worker on purpose: a content script is a fresh instance on every page load and cannot remember "I just ran", yet these gates specifically need memory that spans page loads.

Skip reasons go to the page console (prefixed `[Gesture Pilot]`) **and are shown right in the popup's trigger section** — "last skipped: cooling down, 8s to go". No need to open DevTools and guess.

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

```bash
node tools/mock-harness.mjs      # Service worker: recording/scheduling/replay/CDP/drag/event groups/JS/CSP fallback/triggers/logging/Drive (149)
node tools/content-harness.mjs   # Content scripts: loading, HUD, drag record/replay, domain rules, trigger behaviour, match conditions (157)
node tools/popup-harness.mjs     # Popup: loading, binding, error visibility, version self-check, event-group editing, backup (82)
```

The suites build fake `chrome.*` APIs and DOM shims and *actually execute* the code, catching the class of bug `node --check` misses: undefined references, misspelled fields, state machines walking off the end, errors swallowed silently, and CSP fallback paths that never run.

Real defects found and fixed this way:/n/n- `broadcast()` called but never defined (pressing record did nothing)
- `SCRIPT_UPDATE` forgot to call `syncAlarms()`, so sub-minute intervals never took effect
- Recording state kept in a service-worker module variable, so eviction silently dropped every step
- `flushInput` compared against a stale "initial value", discarding single-character input entirely
- The HUD kept redrawing at 60 fps after the pointer stopped
- Synthetic events used top-level viewport coordinates, so `clientX` was wrong inside iframes
- `runStep` waited 8 seconds for a nonexistent element on locator-less key steps

## Project layout

```
lib/storage.js             Task / event CRUD, settings, run state, structure normalisation
lib/logger.js              Execution log (ring buffer, only written when debug is on)
lib/jsruntime.js           Custom JS execution (lightweight injection, CDP fallback on CSP)
lib/drive.js               Google Drive backup (OAuth2 + PKCE, upload / list / download)
lib/domains.js             Allowed-domain matching (shared by popup and background)
lib/cdp.js                 CDP engine (chrome.debugger wrapper)
content/selector.js        Locating, coordinate maths, controlled-component writes, match validation
content/hud.js             In-page HUD (mouse trail / click ripples / keystroke pills)
content/recorder.js        Recorder (statically injected into every frame)
content/replayer.js        Synthetic-event replay (injected on demand)
content/trigger.js         Page-load trigger engine (top frame only, document_idle)
offscreen/                 Host for sub-minute timers
popup/                     Main UI
editor/                    Code editor for JS events (standalone page)
logs/                      Execution log viewer (standalone page)
```

## Script data format

```
{
  "id": "s_m1x2y3",
  "name": "Order check · 10-12 09:30",
  "enabled": true,                   // master switch: false stops timers and triggers, manual still runs
  "targetUrl": "https://example.com/orders",
  "engine": null,                    // null = inherit the global setting
  "createdAt": 1791000000000,

  "events": [                        // the event group, executed in order
    {
      "id": "e_a1",
      "name": "Open detail",
      "type": "gesture",             // gesture | js
      "enabled": true,
      "wait": {                      // entry conditions for this event
        "url": "",                   // URL match; empty = don't care
        "selector": "",              // wait for element; empty = don't wait
        "timeoutSec": 20
      },
      "steps": [
        {
          "type": "click",
          "locator": { "kind": "attr", "attr": "data-testid", "value": "row-1", "tag": "tr" },
          "rel": { "x": 0.51, "y": 0.48 },
          "match": ".green",         // extra match condition (optional)
          "el": { "tag": "tr", "cls": ["green"], "attrs": [{ "name": "data-testid", "value": "row-1" }] },
          "delay": 0
        }
      ]
    },
    {
      "id": "e_b2",
      "name": "Scrape order ids",
      "type": "js",
      "enabled": true,
      "wait": { "url": "/orders", "selector": ".order-row", "timeoutSec": 20 },
      "code": "return gp.$$('.order-row').length;",
      "world": "auto"                // auto = try injection then fall back; cdp = always debugger
    }
  ],

  "trigger": {                       // page-load trigger
    "enabled": true,
    "domains": ["example.com"],
    "delaySec": 3,
    "readySelector": "#app-ready",
    "readyTimeoutSec": 20,
    "requireVisible": false,
    "once": true,
    "cooldownSec": 10                // shared by every automatic path; manual runs are exempt
  },

  "schedule": {                      // timed runs
    "enabled": false,
    "mode": "interval",              // interval | daily
    "everySec": 1800,                // < 60 goes to offscreen, >= 60 to alarms
    "time": "09:30",
    "domains": []
  }
}
```

> Tasks written by older versions only have a flat `steps` array and no `events`. On read they are wrapped into a single gesture event — no migration step, and neither the UI nor the background needs compatibility branches.

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
