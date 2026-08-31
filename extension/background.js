// Background service worker: polls the local Obsidian plugin (learning
// artefacts) and AnkiConnect (Anki cards due today), caching both in
// chrome.storage.local for the content script + popup to read.

const DEFAULTS = { port: 8756, pollMinutes: 5, ankiApiKey: '' };
const ALARM_NAME = 'artefact-poll';
const ANKI_URL = 'http://127.0.0.1:8765';
// Matches the deck literally named "Archive" and the whole "Archive::*"
// subtree, so an archive with subdecks is ignored wholesale.
const ANKI_ARCHIVE_RE = /^Archive(::|$)/i;

async function getSettings() {
  const { settings } = await chrome.storage.local.get('settings');
  return { ...DEFAULTS, ...(settings || {}) };
}

async function pollArtefacts(settings) {
  const url = `http://127.0.0.1:${settings.port}/artefacts.json`;
  try {
    const res = await fetch(url, { cache: 'no-store' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    await chrome.storage.local.set({
      artefacts: data.artefacts || [],
      scannedAt: data.scannedAt || null,
      root: data.root || null,
      serverOk: true,
      lastPolled: Date.now(),
      lastError: null,
    });
    return { ok: true };
  } catch (e) {
    await chrome.storage.local.set({
      serverOk: false,
      lastPolled: Date.now(),
      lastError: String((e && e.message) || e),
    });
    return { ok: false, error: String((e && e.message) || e) };
  }
}

// AnkiConnect's JSON-RPC-ish contract: POST { action, version, params, key? }
// to http://127.0.0.1:8765 and get back { result, error }. A Chrome
// extension background fetch to a host covered by manifest.json's
// host_permissions bypasses normal browser CORS enforcement entirely, so
// this works regardless of AnkiConnect's own webCorsOriginList config --
// the only thing AnkiConnect itself still enforces is its optional API key.
async function ankiInvoke(action, params, apiKey) {
  const body = { action, version: 6, params: params || {} };
  if (apiKey) body.key = apiKey;
  const res = await fetch(ANKI_URL, { method: 'POST', body: JSON.stringify(body) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = await res.json();
  if (data.error) throw new Error(data.error);
  return data.result;
}

async function pollAnki(settings) {
  try {
    const allDecks = (await ankiInvoke('deckNames', {}, settings.ankiApiKey)) || [];
    const decks = allDecks.filter((name) => !ANKI_ARCHIVE_RE.test(name));

    let statsByName = {};
    if (decks.length) {
      const stats = await ankiInvoke('getDeckStats', { decks }, settings.ankiApiKey);
      for (const entry of Object.values(stats || {})) statsByName[entry.name] = entry;
    }

    const breakdown = decks
      .map((name) => {
        const s = statsByName[name];
        const due = s ? (s.new_count || 0) + (s.learn_count || 0) + (s.review_count || 0) : 0;
        return { name, due };
      })
      .filter((d) => d.due > 0)
      .sort((a, b) => b.due - a.due);

    const total = breakdown.reduce((sum, d) => sum + d.due, 0);

    await chrome.storage.local.set({
      ankiDecks: breakdown,
      ankiTotal: total,
      ankiOk: true,
      ankiLastPolled: Date.now(),
      ankiLastError: null,
    });
  } catch (e) {
    // Anki not open, AnkiConnect not installed, or a bad/missing API key --
    // fail silently into "no chip" rather than surfacing an error chip.
    await chrome.storage.local.set({
      ankiOk: false,
      ankiLastPolled: Date.now(),
      ankiLastError: String((e && e.message) || e),
    });
  }
}

async function pollNow() {
  const settings = await getSettings();
  const artefactResult = await pollArtefacts(settings);
  await pollAnki(settings);
  return artefactResult;
}

async function scheduleAlarm() {
  const settings = await getSettings();
  await chrome.alarms.clear(ALARM_NAME);
  chrome.alarms.create(ALARM_NAME, { periodInMinutes: Math.max(1, settings.pollMinutes) });
}

chrome.runtime.onInstalled.addListener(async () => {
  const { settings } = await chrome.storage.local.get('settings');
  if (!settings) await chrome.storage.local.set({ settings: DEFAULTS });
  await scheduleAlarm();
  await pollNow();
});

chrome.runtime.onStartup.addListener(async () => {
  await scheduleAlarm();
  await pollNow();
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === ALARM_NAME) pollNow();
});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || !msg.type) return;
  if (msg.type === 'poll-now') {
    pollNow().then(sendResponse);
    return true; // keep the message channel open for the async response
  }
  if (msg.type === 'update-settings') {
    chrome.storage.local.set({ settings: { ...DEFAULTS, ...msg.settings } }).then(async () => {
      await scheduleAlarm();
      const result = await pollNow();
      sendResponse(result);
    });
    return true;
  }
});
