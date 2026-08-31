# Learning Artefact Due Dates — Chrome Extension

Shows each Learning Artefact's `Next Due` date as a card on Google
Calendar (Week view) in Chrome — entirely locally, with no Google
account access and nothing leaving this machine.

This is one half of a pair of repos:

- **This repo** — the Chrome extension (`extension/`).
- **[learning-artefact-obsidian-plugin](../learning-artefact-obsidian-plugin-git-repo)**
  — the companion Obsidian plugin that scans your vault and serves the
  due-date data this extension reads. It must be installed and enabled,
  and Obsidian must be open, for chips to appear.

## How it works

- `background.js` polls the Obsidian plugin's local server (default
  `http://127.0.0.1:8756/artefacts.json`) every 5 minutes and caches the
  result in `chrome.storage.local`.
- `content.js` runs on `calendar.google.com`, finds the currently
  visible day columns, and draws a card under each date that has a due
  artefact — positioned below Google's own all-day events and Tasks
  lane, never on top of them. A single due/overdue artefact on a day
  shows its title directly; multiple artefacts on the same day collapse
  into one card ("3 Learning Artefacts Due Today", "2 Learning
  Artefacts Overdue", etc.) that opens a scrollable list when clicked.
  Overdue artefacts always show on **today**, in red, rather than
  staying stuck on their original due date.
- Clicking a single artefact's title (in its detail popover, or inside
  the list dialog) opens the latest Shell file directly in a new
  Obsidian tab.
- This is **a visual overlay only** — it never touches a real Calendar
  event, so there's no OAuth, no Calendar API, no write access needed.

## Setup

1. Install and enable the companion Obsidian plugin (see its own
   README) and make sure Obsidian is open.
2. **Load the extension.** In Chrome, go to `chrome://extensions`, turn
   on **Developer mode**, click **Load unpacked**, and select this
   repo's `extension/` folder.
3. Open Google Calendar in Week view. Any due date on screen gets a
   card. Click the toolbar icon for status, to change the plugin's
   port, or to trigger an immediate poll.

## If the chips stop appearing

Google occasionally changes Calendar's markup, which can break the part
of `content.js` that locates day columns (`findDayColumns()`). To check:

1. Open the extension's popup and click **Toggle column outline on this
   tab** — pink dashed outlines with a date label should appear over
   each visible day column. If nothing appears, detection failed.
2. Open DevTools (Cmd+Opt+I) on the Calendar tab, Console panel — look
   for `[artefact-due]` warnings.
3. If it's broken, the fix is almost always inside `findDayColumns()` in
   `content.js`: it looks for header cells with a full accessible date
   in their `aria-label` (e.g. "Monday, August 31"), preferring the
   real `<h2>` header over Google's small circular date-number button
   which carries an identical label. Inspect a day header cell in
   DevTools to confirm that signal still holds.

Also check `http://127.0.0.1:8756/health` and `/artefacts.json` (or
whatever port you've set) to rule out the plugin side first — if
Obsidian isn't open, or the plugin isn't enabled, those won't respond.

## Privacy / scope

- No network calls except the extension talking to `127.0.0.1`.
- No Google account permissions of any kind.
- The Obsidian plugin only reads files — it never writes into your notes.
