const $ = (id) => document.getElementById(id);

function fmtAgo(ts) {
  if (!ts) return 'never';
  const s = Math.round((Date.now() - ts) / 1000);
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  return `${Math.round(s / 3600)}h ago`;
}

async function refresh() {
  const data = await chrome.storage.local.get([
    'artefacts', 'serverOk', 'lastPolled', 'lastError', 'root', 'settings',
    'ankiDecks', 'ankiTotal', 'ankiOk', 'ankiLastPolled', 'ankiLastError',
  ]);

  const dot = $('status-dot');
  const text = $('status-text');
  if (data.serverOk) {
    dot.className = 'dot ok';
    text.textContent = 'Obsidian plugin reachable';
  } else if (data.serverOk === false) {
    dot.className = 'dot bad';
    text.textContent = data.lastError ? `Unreachable: ${data.lastError}` : 'Unreachable';
  } else {
    dot.className = 'dot';
    text.textContent = 'Not polled yet';
  }
  $('meta').textContent = `${(data.artefacts || []).length} due artefact(s) · last polled ${fmtAgo(data.lastPolled)}` +
    (data.root ? ` · vault: ${data.root}` : '');

  const ankiDot = $('anki-status-dot');
  const ankiText = $('anki-status-text');
  if (data.ankiOk) {
    ankiDot.className = 'dot ok';
    ankiText.textContent = 'AnkiConnect reachable';
  } else if (data.ankiOk === false) {
    ankiDot.className = 'dot bad';
    ankiText.textContent = data.ankiLastError ? `Unreachable: ${data.ankiLastError}` : 'Unreachable';
  } else {
    ankiDot.className = 'dot';
    ankiText.textContent = 'Not polled yet';
  }
  $('anki-meta').textContent = `${data.ankiTotal || 0} card(s) due today · last polled ${fmtAgo(data.ankiLastPolled)}` +
    ` · "Archive" deck always ignored`;

  const port = (data.settings && data.settings.port) || 8756;
  $('port-input').value = port;
  $('anki-key-input').value = (data.settings && data.settings.ankiApiKey) || '';

  const upcoming = $('upcoming');
  upcoming.innerHTML = '';
  const items = (data.artefacts || []).slice(0, 20);
  if (!items.length) {
    const li = document.createElement('li');
    li.textContent = 'No artefacts with a Next Due date found.';
    upcoming.appendChild(li);
  }
  for (const a of items) {
    const li = document.createElement('li');
    const d = document.createElement('div');
    d.className = 'd';
    d.textContent = a.dueDate + (a.course ? ` · ${a.course}` : '');
    const t = document.createElement('div');
    t.textContent = a.title;
    li.appendChild(t);
    li.appendChild(d);
    upcoming.appendChild(li);
  }
}

$('save-btn').addEventListener('click', () => {
  const port = parseInt($('port-input').value, 10) || 8756;
  const ankiApiKey = $('anki-key-input').value.trim();
  chrome.runtime.sendMessage({ type: 'update-settings', settings: { port, ankiApiKey } }, () => refresh());
});

// "Poll now" always polls with whatever is currently typed in the fields,
// not just whatever was last Saved -- otherwise typing a new key and
// clicking Poll Now (without Save) silently re-polls with the stale
// settings and reproduces the exact same error, which is confusing.
$('poll-btn').addEventListener('click', () => {
  const port = parseInt($('port-input').value, 10) || 8756;
  const ankiApiKey = $('anki-key-input').value.trim();
  chrome.runtime.sendMessage({ type: 'update-settings', settings: { port, ankiApiKey } }, () => refresh());
});

$('debug-btn').addEventListener('click', async () => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab || !tab.url || !tab.url.includes('calendar.google.com')) {
    alert('Open Google Calendar in this tab first.');
    return;
  }
  chrome.tabs.sendMessage(tab.id, { type: 'toggle-debug' }, () => void chrome.runtime.lastError);
});

refresh();
setInterval(refresh, 3000);
