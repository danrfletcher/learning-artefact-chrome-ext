const $ = (id) => document.getElementById(id);

function fmtAgo(ts) {
  if (!ts) return 'never';
  const s = Math.round((Date.now() - ts) / 1000);
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  return `${Math.round(s / 3600)}h ago`;
}

async function refresh() {
  const data = await chrome.storage.local.get(['artefacts', 'serverOk', 'lastPolled', 'lastError', 'root', 'settings']);
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

  const port = (data.settings && data.settings.port) || 8756;
  $('port-input').value = port;

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
  chrome.runtime.sendMessage({ type: 'update-settings', settings: { port } }, () => refresh());
});

$('poll-btn').addEventListener('click', () => {
  chrome.runtime.sendMessage({ type: 'poll-now' }, () => refresh());
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
