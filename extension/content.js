// Renders due-artefact chips (and an Anki-due chip) on Google Calendar's
// day columns.
//
// This is a *visual overlay only* -- it does not read, create, or modify
// any real Google Calendar event. Chips are positioned in fixed screen
// coordinates derived from the real day-header cells and the real
// pinned top area's own measured height (all-day events + Google Tasks
// lane), so they sit right below whatever Google is already showing
// there instead of covering it.
//
// Rendering is diff-based, not clear-and-rebuild: every render() call
// computes the desired set of cards and only touches the DOM elements
// whose position, size, or content actually changed. Nothing is ever
// blanked as a first step, which is what used to cause visible flashing
// on every scroll/resize/mutation tick.
//
// The fragile part of this file is column/row detection (the functions
// under "finding calendar day columns" and "finding the pinned top
// area"): Google can change Calendar's markup at any time. See the
// README's "If the chips stop appearing" section for how to fix it, and
// the `debugMode` toggle (from the popup) for a live diagnostic overlay.

(function () {
  const OVERLAY_ID = 'artefact-due-overlay-root';
  const RENDER_DEBOUNCE_MS = 200;
  const SAFETY_NET_MS = 5000;
  const MIN_COLUMN_WIDTH = 60;
  const MAX_PINNED_ROW_HEIGHT = 40; // compact all-day/task rows vs tall hour rows

  let artefacts = [];
  let ankiDecks = [];
  let ankiTotal = 0;
  let debugMode = false;

  function isoDate(d) {
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  }

  // ---- reading artefact + Anki data ----

  function loadFromStorage() {
    chrome.storage.local.get(['artefacts', 'ankiDecks', 'ankiTotal'], (res) => {
      artefacts = res.artefacts || [];
      ankiDecks = res.ankiDecks || [];
      ankiTotal = res.ankiTotal || 0;
      scheduleRender();
    });
  }

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    let dirty = false;
    if (changes.artefacts) { artefacts = changes.artefacts.newValue || []; dirty = true; }
    if (changes.ankiDecks) { ankiDecks = changes.ankiDecks.newValue || []; dirty = true; }
    if (changes.ankiTotal) { ankiTotal = changes.ankiTotal.newValue || 0; dirty = true; }
    if (dirty) scheduleRender();
  });

  // ---- finding calendar day columns ----

  const MONTHS = ['January','February','March','April','May','June','July','August','September','October','November','December'];
  const MONTH_RE = MONTHS.map((m) => m.slice(0, 3)).join('|');

  // Full accessible date labels are the most reliable signal Google exposes
  // (aria-label on the header cell), e.g. "Monday, August 31, today" or
  // "Monday, August 31, 2026".
  function parseFullLabel(label) {
    const re = new RegExp(`^\\w+,?\\s+(${MONTH_RE})[a-z]*\\s+(\\d{1,2})(?:,?\\s+(\\d{4}))?`, 'i');
    const m = label.match(re);
    if (!m) return null;
    const monthIdx = MONTHS.findIndex((mo) => mo.toLowerCase().startsWith(m[1].toLowerCase()));
    if (monthIdx === -1) return null;
    const day = parseInt(m[2], 10);
    const explicitYear = m[3] ? parseInt(m[3], 10) : null;
    return { monthIdx, day, explicitYear };
  }

  function resolveYear(monthIdx, day, explicitYear) {
    if (explicitYear) return explicitYear;
    const now = new Date();
    let best = now.getFullYear();
    let bestDiff = Infinity;
    for (const y of [now.getFullYear() - 1, now.getFullYear(), now.getFullYear() + 1]) {
      const d = new Date(y, monthIdx, day);
      const diff = Math.abs(d.getTime() - now.getTime());
      if (diff < bestDiff) { bestDiff = diff; best = y; }
    }
    return best;
  }

  // EVERY day header cell carries a duplicate: a small circular
  // date-number <button> next to (or inside) the real <h2> header, and
  // both share the exact same aria-label -- not just "today"'s badge.
  // <h2> is the reliable signal Google actually uses for the real header
  // cell, so prefer it outright; width is only a tie-breaker among
  // same-tag candidates. Anything narrower than MIN_COLUMN_WIDTH is
  // never trusted as a real column at all -- better to skip a date for
  // one pass than freeze a chip at a bogus, tiny position.
  function findDayColumns() {
    const scope = document.querySelector('[role="main"]') || document.body;
    const candidates = Array.from(scope.querySelectorAll('[aria-label]')).filter((el) => {
      const rect = el.getBoundingClientRect();
      if (rect.width < MIN_COLUMN_WIDTH || rect.height < 10 || rect.top > 260) return false;
      return parseFullLabel(el.getAttribute('aria-label') || '') !== null;
    });

    const byDate = new Map();
    for (const el of candidates) {
      const rect = el.getBoundingClientRect();
      const parsed = parseFullLabel(el.getAttribute('aria-label') || '');
      const year = resolveYear(parsed.monthIdx, parsed.day, parsed.explicitYear);
      const date = new Date(year, parsed.monthIdx, parsed.day);
      const key = isoDate(date);
      const isHeader = el.tagName === 'H2';
      const existing = byDate.get(key);
      if (!existing
          || (isHeader && !existing.isHeader)
          || (isHeader === existing.isHeader && rect.width > existing.rect.width)) {
        byDate.set(key, { rect, date, isHeader });
      }
    }
    return Array.from(byDate.values()).sort((a, b) => a.rect.left - b.rect.left);
  }

  // The pinned top area below the header can hold several compact rows
  // -- real all-day events *and* Google's own Tasks lane -- stacked on
  // top of each other, all the way down to where the tall, scrollable
  // hour grid begins. We want the bottom of ALL of those compact rows,
  // not just the first one, so our chips never land on top of a task or
  // a second/third all-day event. Hour-grid cells are much taller than
  // any all-day/task row, so filtering by height cleanly separates the
  // two without needing to know how many pinned rows Google is showing.
  function findPinnedAreaBottom(headerBottom) {
    const cells = Array.from(document.querySelectorAll('[role="gridcell"]'))
      .map((el) => el.getBoundingClientRect())
      .filter((r) => r.width > 0
        && r.height > 0
        && r.height <= MAX_PINNED_ROW_HEIGHT
        && r.top >= headerBottom - 6
        && r.top <= headerBottom + 200);
    if (!cells.length) return headerBottom;
    return Math.max(...cells.map((r) => r.bottom));
  }

  // Lowest common ancestor of the day-header cells -- a small, low-noise
  // container to MutationObserve for "the view just navigated" signals.
  function headerRowContainer() {
    const scope = document.querySelector('[role="main"]') || document.body;
    const headers = Array.from(scope.querySelectorAll('[aria-label]')).filter((el) => {
      const rect = el.getBoundingClientRect();
      return rect.width > 10 && rect.top < 260 && parseFullLabel(el.getAttribute('aria-label') || '') !== null;
    });
    if (!headers.length) return document.body;
    function ancestors(el) { const a = []; let c = el; while (c) { a.push(c); c = c.parentElement; } return a; }
    let common = ancestors(headers[0]);
    for (const h of headers.slice(1)) {
      const set = new Set(ancestors(h));
      common = common.filter((a) => set.has(a));
    }
    return common[0] || document.body;
  }

  // ---- overlay root ----

  function ensureOverlayRoot() {
    let root = document.getElementById(OVERLAY_ID);
    if (!root) {
      root = document.createElement('div');
      root.id = OVERLAY_ID;
      root.style.position = 'fixed';
      root.style.inset = '0';
      root.style.pointerEvents = 'none';
      root.style.zIndex = '40';
      document.body.appendChild(root);
    }
    return root;
  }

  function todayIso() { return isoDate(new Date()); }

  // ---- detail popover (single artefact) ----

  let openPopover = null; // the single-detail box, or a list dialog
  function closePopover() {
    if (openPopover) { openPopover.remove(); openPopover = null; }
  }
  document.addEventListener('click', (e) => {
    if (openPopover && !openPopover.contains(e.target)) closePopover();
  });

  function makeTitleLink(a) {
    if (a.obsidianUri) {
      const link = document.createElement('a');
      link.className = 'artefact-due-detail-title artefact-due-detail-link';
      link.href = a.obsidianUri;
      link.textContent = a.title;
      link.title = 'Open the latest shell in Obsidian (new tab)';
      link.addEventListener('click', (e) => e.stopPropagation());
      return link;
    }
    const titleEl = document.createElement('div');
    titleEl.className = 'artefact-due-detail-title';
    titleEl.textContent = a.title;
    return titleEl;
  }

  function showDetail(a, anchorEl) {
    closePopover();
    const box = document.createElement('div');
    box.className = 'artefact-due-detail';
    positionBelow(box, anchorEl);
    box.appendChild(makeTitleLink(a));

    const rows = [
      ['Due', a.dueDate],
      ['Course', a.course],
      ['Shape', a.shape],
      ['Level', a.level],
      ['State', a.state],
      ['Grade', a.grade],
      ['Slug', a.slug],
      ['Shell', a.shellBuild ? `Build ${a.shellBuild} · Level ${a.shellLevel}` : null],
    ].filter(([, v]) => v);

    for (const [k, v] of rows) {
      const row = document.createElement('div');
      row.className = 'artefact-due-detail-row';
      const kEl = document.createElement('span');
      kEl.className = 'k';
      kEl.textContent = k + ':';
      const vEl = document.createElement('span');
      vEl.className = 'v';
      vEl.textContent = v;
      row.appendChild(kEl);
      row.appendChild(vEl);
      box.appendChild(row);
    }

    document.body.appendChild(box);
    openPopover = box;
  }

  // ---- scrollable list dialog (grouped artefact card) ----

  function showList(groupLabel, items, anchorEl) {
    closePopover();
    const box = document.createElement('div');
    box.className = 'artefact-due-list-dialog';
    positionBelow(box, anchorEl);

    const heading = document.createElement('div');
    heading.className = 'artefact-due-list-heading';
    heading.textContent = groupLabel;
    box.appendChild(heading);

    const list = document.createElement('div');
    list.className = 'artefact-due-list-scroll';
    for (const a of items) {
      const row = document.createElement('div');
      row.className = 'artefact-due-list-row';
      row.appendChild(makeTitleLink(a));
      const caption = document.createElement('div');
      caption.className = 'artefact-due-list-caption';
      caption.textContent = [a.dueDate, a.course].filter(Boolean).join(' · ');
      row.appendChild(caption);
      list.appendChild(row);
    }
    box.appendChild(list);

    document.body.appendChild(box);
    openPopover = box;
  }

  // ---- scrollable list dialog (Anki per-deck breakdown) ----

  function showAnkiList(label, decks, anchorEl) {
    closePopover();
    const box = document.createElement('div');
    box.className = 'artefact-due-list-dialog';
    positionBelow(box, anchorEl);

    const heading = document.createElement('div');
    heading.className = 'artefact-due-list-heading';
    heading.textContent = label;
    box.appendChild(heading);

    const list = document.createElement('div');
    list.className = 'artefact-due-list-scroll';
    for (const d of decks) {
      const row = document.createElement('div');
      row.className = 'artefact-due-list-row';
      const nameEl = document.createElement('div');
      nameEl.className = 'artefact-due-detail-title';
      nameEl.textContent = d.name;
      const caption = document.createElement('div');
      caption.className = 'artefact-due-list-caption';
      caption.textContent = `${d.due} due`;
      row.appendChild(nameEl);
      row.appendChild(caption);
      list.appendChild(row);
    }
    box.appendChild(list);

    document.body.appendChild(box);
    openPopover = box;
  }

  function positionBelow(box, anchorEl) {
    const rect = anchorEl.getBoundingClientRect();
    box.style.left = `${Math.round(rect.left)}px`;
    box.style.top = `${Math.round(rect.bottom + 6)}px`;
  }

  // ---- building card descriptors ----

  const WEEKDAY_FMT = { weekday: 'long' };

  function describeGroup(kind, items, dateKey, today) {
    const count = items.length;
    if (count === 1) {
      return { label: items[0].title, isOverdue: kind === 'overdue', items, isGroup: false };
    }
    let label;
    if (kind === 'overdue') {
      label = `${count} Learning Artefacts Overdue`;
    } else if (dateKey === today) {
      label = `${count} Learning Artefacts Due Today`;
    } else {
      const [y, m, d] = dateKey.split('-').map((n) => parseInt(n, 10));
      const weekday = new Date(y, m - 1, d).toLocaleDateString(undefined, WEEKDAY_FMT);
      label = `${count} Learning Artefacts Due ${weekday}`;
    }
    return { label, isOverdue: kind === 'overdue', items, isGroup: true };
  }

  function describeAnki(total, decks) {
    return {
      label: `${total} Anki Card${total === 1 ? '' : 's'} Due`,
      isOverdue: false,
      isAnki: true,
      items: decks,
      isGroup: true,
    };
  }

  // Computes the full desired set of cards for the current layout as a
  // Map<cardKey, descriptor>. cardKey identifies WHERE a card belongs
  // (date + kind), independent of its content, so the diff step can tell
  // "same slot, different content" (update in place) apart from "slot no
  // longer needed" (remove) or "new slot" (create).
  //
  // The Anki chip is special: it isn't a per-day due date like an
  // artefact, it's "how many Anki cards are due right now", so it only
  // ever occupies today's column -- and when it's shown, it's slotted in
  // first so it renders above (not below) that day's artefact cards.
  function computeDesiredCards(columns, rowBottom, today) {
    const byDate = new Map(); // dateKey -> { overdue: [], due: [] }
    for (const a of artefacts) {
      const isOverdue = a.dueDate < today;
      const effective = isOverdue ? today : a.dueDate;
      if (!byDate.has(effective)) byDate.set(effective, { overdue: [], due: [] });
      byDate.get(effective)[isOverdue ? 'overdue' : 'due'].push(a);
    }

    const desired = new Map();
    for (const col of columns) {
      const dateKey = isoDate(col.date);
      const bucket = byDate.get(dateKey);
      const showAnki = dateKey === today && ankiTotal > 0;
      if (!bucket && !showAnki) continue;

      const groups = [];
      if (showAnki) groups.push({ kind: 'anki', ...describeAnki(ankiTotal, ankiDecks) });
      if (bucket) {
        if (bucket.overdue.length) groups.push({ kind: 'overdue', ...describeGroup('overdue', bucket.overdue, dateKey, today) });
        if (bucket.due.length) groups.push({ kind: 'due', ...describeGroup('due', bucket.due, dateKey, today) });
      }

      groups.forEach((g, i) => {
        const key = `${dateKey}|${g.kind}`;
        desired.set(key, {
          left: Math.round(col.rect.left),
          top: Math.round(rowBottom + 3 + i * 24),
          width: Math.round(col.rect.width),
          ...g,
        });
      });
    }
    return desired;
  }

  function cardContentSignature(desc) {
    return JSON.stringify({
      kind: desc.kind,
      label: desc.label,
      isGroup: desc.isGroup,
      isOverdue: desc.isOverdue,
      ids: desc.isAnki
        ? desc.items.map((d) => `${d.name}:${d.due}`)
        : desc.items.map((a) => a.id || a.title),
    });
  }

  function buildCardElement(desc) {
    const el = document.createElement('div');
    el.className = 'artefact-due-card'
      + (desc.isOverdue ? ' overdue' : '')
      + (desc.isAnki ? ' anki' : '')
      + (desc.isGroup ? ' group' : '');
    const dot = document.createElement('span');
    dot.className = 'artefact-due-dot';
    dot.textContent = '●';
    const label = document.createElement('span');
    label.className = 'artefact-due-title';
    label.textContent = desc.label;
    el.appendChild(dot);
    el.appendChild(label);
    el.title = desc.isAnki
      ? `${desc.label} — click to see the per-deck breakdown`
      : (desc.isGroup ? `${desc.label} — click to see the list` : `${desc.label} — due ${desc.items[0].dueDate}`);
    el.addEventListener('click', (e) => {
      e.stopPropagation();
      if (desc.isAnki) showAnkiList(desc.label, desc.items, el);
      else if (desc.isGroup) showList(desc.label, desc.items, el);
      else showDetail(desc.items[0], el);
    });
    return el;
  }

  // ---- diff-based render ----
  //
  // Cards are never all cleared and rebuilt. Each render() computes the
  // desired cards, then: removes DOM elements for slots no longer
  // needed, updates existing elements in place when only their position
  // changed, rebuilds an element's content only when what it should show
  // has actually changed, and creates elements for brand-new slots. Most
  // ticks (mutation noise, a scroll pixel, the periodic safety check)
  // touch zero DOM nodes because nothing about the desired output
  // changed at all -- which is what stops the visible flashing.
  const renderedCards = new Map(); // cardKey -> { el, contentSig, left, top, width }

  function render() {
    const root = ensureOverlayRoot();

    if (!artefacts.length && !ankiTotal) {
      for (const [key, entry] of renderedCards) { entry.el.remove(); renderedCards.delete(key); }
      if (debugMode) clearDebugOutlines(root);
      return;
    }

    const columns = findDayColumns();
    if (!columns.length) {
      for (const [key, entry] of renderedCards) { entry.el.remove(); renderedCards.delete(key); }
      if (debugMode) console.log('[artefact-due] no calendar day columns detected on this view');
      return;
    }

    const headerBottom = Math.max(...columns.map((c) => c.rect.bottom));
    const rowBottom = findPinnedAreaBottom(headerBottom);
    const today = todayIso();

    const desired = computeDesiredCards(columns, rowBottom, today);

    // Remove stale cards.
    for (const [key, entry] of renderedCards) {
      if (!desired.has(key)) { entry.el.remove(); renderedCards.delete(key); }
    }

    // Create or update each desired card.
    for (const [key, desc] of desired) {
      const contentSig = cardContentSignature(desc);
      const existing = renderedCards.get(key);
      if (!existing) {
        const el = buildCardElement(desc);
        el.style.left = `${desc.left}px`;
        el.style.top = `${desc.top}px`;
        el.style.width = `${desc.width}px`;
        root.appendChild(el);
        renderedCards.set(key, { el, contentSig, left: desc.left, top: desc.top, width: desc.width });
        continue;
      }
      if (existing.contentSig !== contentSig) {
        const el = buildCardElement(desc);
        el.style.left = `${desc.left}px`;
        el.style.top = `${desc.top}px`;
        el.style.width = `${desc.width}px`;
        existing.el.replaceWith(el);
        renderedCards.set(key, { el, contentSig, left: desc.left, top: desc.top, width: desc.width });
        continue;
      }
      if (existing.left !== desc.left) { existing.el.style.left = `${desc.left}px`; existing.left = desc.left; }
      if (existing.top !== desc.top) { existing.el.style.top = `${desc.top}px`; existing.top = desc.top; }
      if (existing.width !== desc.width) { existing.el.style.width = `${desc.width}px`; existing.width = desc.width; }
    }

    if (debugMode) renderDebugOutlines(root, columns, rowBottom);
  }

  function clearDebugOutlines(root) {
    root.querySelectorAll('.artefact-due-debug-outline').forEach((el) => el.remove());
  }
  function renderDebugOutlines(root, columns, rowBottom) {
    clearDebugOutlines(root);
    for (const col of columns) {
      const outline = document.createElement('div');
      outline.className = 'artefact-due-debug-outline';
      outline.style.left = `${Math.round(col.rect.left)}px`;
      outline.style.top = `${Math.round(col.rect.top)}px`;
      outline.style.width = `${Math.round(col.rect.width)}px`;
      outline.style.height = `${Math.round(rowBottom - col.rect.top)}px`;
      outline.textContent = isoDate(col.date);
      root.appendChild(outline);
    }
  }

  // ---- scheduling ----
  //
  // Google re-renders the whole week/month asynchronously on navigation
  // and settles it with a CSS transition that can fire no further DOM
  // mutation at all, so a burst of a few follow-up render() calls after
  // any mutation still catches a late-settling transition. Since render()
  // never blanks anything, firing it extra times is harmless -- it's a
  // no-op the moment the geometry stops moving.
  const SETTLE_BURST_DELAYS_MS = [RENDER_DEBOUNCE_MS, RENDER_DEBOUNCE_MS + 200, RENDER_DEBOUNCE_MS + 600, RENDER_DEBOUNCE_MS + 1300, RENDER_DEBOUNCE_MS + 2800];
  let burstTimers = [];
  function scheduleRender() {
    burstTimers.forEach(clearTimeout);
    burstTimers = SETTLE_BURST_DELAYS_MS.map((ms) => setTimeout(render, ms));
    render(); // also try immediately -- cheap, and covers the common case with zero delay
  }

  // Scroll and resize need to track live geometry continuously, not just
  // settle once -- but since render() only ever touches what changed,
  // running it on every animation frame while scrolling is safe and
  // keeps chips glued to their column instead of vanishing.
  let rafPending = false;
  function scheduleContinuousRender() {
    if (rafPending) return;
    rafPending = true;
    requestAnimationFrame(() => { rafPending = false; render(); });
  }

  let observer = null;
  function attachObserver() {
    if (observer) observer.disconnect();
    const container = headerRowContainer();
    observer = new MutationObserver(scheduleRender);
    observer.observe(container, { childList: true, subtree: true, characterData: true });
  }

  // ---- debug toggle (invoked from the popup) ----
  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg && msg.type === 'toggle-debug') {
      debugMode = !debugMode;
      if (!debugMode) clearDebugOutlines(ensureOverlayRoot());
      render();
      sendResponse({ debugMode });
    }
  });

  // ---- boot ----
  loadFromStorage();
  chrome.runtime.sendMessage({ type: 'poll-now' }, () => {
    void chrome.runtime.lastError;
    loadFromStorage();
  });
  attachObserver();
  window.addEventListener('resize', scheduleRender);
  window.addEventListener('scroll', scheduleContinuousRender, true);
  // Safety net: the header container reference can go stale if Google
  // replaces it wholesale; periodically re-find it and redraw. This is a
  // plain render() (no clearing), so it is invisible when nothing moved.
  setInterval(() => { attachObserver(); render(); }, SAFETY_NET_MS);
})();
