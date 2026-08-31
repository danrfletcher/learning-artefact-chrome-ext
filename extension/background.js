// Background service worker: polls the local watcher server and caches
// results in chrome.storage.local for the content script + popup to read.

const DEFAULTS = { port: 8756, pollMinutes: 5 };
const ALARM_NAME = 'artefact-poll';

async function getSettings() {
  const { settings } = await chrome.storage.local.get('settings');
  return { ...DEFAULTS, ...(settings || {}) };
}

async function pollNow() {
  const settings = await getSettings();
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
