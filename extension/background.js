// Service worker: keeps the local copy of the group state fresh, sets an
// alarm for the exact end of the current phase, and opens the break /
// back-to-work window at each transition.

import { api, cachedState, serverNow } from './lib/api.js';
import { currentPhase, totalDuration, MODELS } from './lib/models.js';

const POLL = 'poll';
const PHASE = 'phase';
const RECENT_WORK_START = 3 * 60 * 1000; // show "back to work" only if it just happened
const RECENT_FINISH = 10 * 60 * 1000;

chrome.runtime.onInstalled.addListener(boot);
chrome.runtime.onStartup.addListener(boot);

// Clicking the toolbar icon opens the side panel (no popup over the page).
chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});

async function boot() {
  await chrome.alarms.create(POLL, { periodInMinutes: 0.5 });
  await sync();
}

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === POLL || alarm.name === PHASE) sync();
});

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg && msg.type === 'evaluate') {
    evaluate().then(() => sendResponse({ ok: true }));
    return true;
  }
  if (msg && msg.type === 'closeBreakWindow') {
    closeBreakWindow().then(() => sendResponse({ ok: true }));
    return true;
  }
  return false;
});

chrome.windows.onRemoved.addListener(async (windowId) => {
  const { breakWindow } = await chrome.storage.session.get('breakWindow');
  if (breakWindow && breakWindow.windowId === windowId) {
    await chrome.storage.session.remove('breakWindow');
  }
});

let syncing = null;
async function sync() {
  // Make sure the poll alarm survives browser restarts / updates.
  if (!(await chrome.alarms.get(POLL))) {
    await chrome.alarms.create(POLL, { periodInMinutes: 0.5 });
  }
  if (syncing) return syncing;
  syncing = (async () => {
    const { token } = await chrome.storage.local.get('token');
    if (token) {
      try {
        await api.state();
      } catch {
        // Offline: keep working from the cached schedule.
      }
    }
    await evaluate();
  })().finally(() => {
    syncing = null;
  });
  return syncing;
}

async function evaluate() {
  const { state, offset } = await cachedState();
  const group = state && state.group;
  if (!group) {
    await chrome.alarms.clear(PHASE);
    await closeBreakWindow();
    await setBadge('', '#888');
    return;
  }

  const schedule = group.schedule;
  const now = serverNow(offset);
  const ph = currentPhase(schedule, now);

  // Exact alarm for the end of the running phase.
  if (ph.state === 'running') {
    await chrome.alarms.create(PHASE, { when: Date.now() + ph.remaining + 1000 });
  } else {
    await chrome.alarms.clear(PHASE);
  }

  await updateBadge(ph);

  const key =
    ph.state === 'finished'
      ? `${group.id}:${schedule.startedAt}:done`
      : ph.index !== undefined
        ? `${group.id}:${schedule.startedAt}:${ph.index}`
        : `${group.id}:${ph.state}`;

  const { handledKey } = await chrome.storage.local.get('handledKey');

  // A stopped or reset timer closes any open break window.
  if (ph.state === 'idle' || ph.state === 'ready') {
    await closeBreakWindow();
  }

  if (key === handledKey) return;
  await chrome.storage.local.set({ handledKey: key });

  if ((ph.state === 'running' || ph.state === 'paused') && ph.phase.type === 'break') {
    if (ph.remaining > 5000) {
      await openBreakWindow('break');
      notify('وقت استراحته! ☕', ph.phase.long ? 'استراحت بلند شروع شد.' : 'یه استراحت کوتاه، بدون گوشی.');
    }
    return;
  }

  if (ph.state === 'running' && ph.phase.type === 'work' && ph.index > 0) {
    const sinceStart = ph.phase.duration - ph.remaining;
    if (sinceStart < RECENT_WORK_START) {
      await openBreakWindow('back');
      notify('برگرد سر کار 💪', `دور ${ph.phase.cycle} از ${ph.cycles} شروع شد.`);
    } else {
      await closeBreakWindow();
    }
    return;
  }

  if (ph.state === 'finished') {
    const finishedAt =
      schedule.startedAt + (schedule.pausedTotal || 0) + totalDuration(schedule.modelId, schedule.cycles);
    if (now - finishedAt < RECENT_FINISH) {
      await openBreakWindow('finished');
      notify('همه‌ی حلقه‌ها تموم شد 🎉', MODELS[schedule.modelId]?.title || '');
    }
  }
}

// ---- break window -------------------------------------------------------

async function openBreakWindow(mode) {
  const url = chrome.runtime.getURL(`break/break.html?mode=${mode}&t=${Date.now()}`);
  const { breakWindow } = await chrome.storage.session.get('breakWindow');
  if (breakWindow) {
    try {
      await chrome.tabs.update(breakWindow.tabId, { url });
      await chrome.windows.update(breakWindow.windowId, { focused: true, drawAttention: true });
      return;
    } catch {
      // The window was closed meanwhile: create a new one.
    }
  }
  const width = 440;
  const height = 560;
  let left;
  let top;
  try {
    const last = await chrome.windows.getLastFocused();
    if (last && last.width) {
      left = Math.round(last.left + (last.width - width) / 2);
      top = Math.round(last.top + (last.height - height) / 2);
    }
  } catch {
    // no browser window open: let Chrome choose the position
  }
  const win = await chrome.windows.create({
    url,
    type: 'popup',
    width,
    height,
    left,
    top,
    focused: true,
  });
  await chrome.storage.session.set({
    breakWindow: { windowId: win.id, tabId: win.tabs[0].id },
  });
}

async function closeBreakWindow() {
  const { breakWindow } = await chrome.storage.session.get('breakWindow');
  if (!breakWindow) return;
  await chrome.storage.session.remove('breakWindow');
  try {
    await chrome.windows.remove(breakWindow.windowId);
  } catch {
    // already closed
  }
}

// ---- badge & notifications ---------------------------------------------

async function updateBadge(ph) {
  if (ph.state === 'running' || ph.state === 'paused') {
    const minutes = Math.ceil(ph.remaining / 60000);
    const isBreak = ph.phase.type === 'break';
    const text = ph.state === 'paused' ? '||' : String(minutes);
    await setBadge(text, ph.state === 'paused' ? '#8a8a8a' : isBreak ? '#e8833a' : '#1f9d74');
  } else {
    await setBadge('', '#888');
  }
}

async function setBadge(text, color) {
  await chrome.action.setBadgeText({ text });
  await chrome.action.setBadgeBackgroundColor({ color });
}

function notify(title, message) {
  chrome.notifications.create({
    type: 'basic',
    iconUrl: chrome.runtime.getURL('icons/icon-128.png'),
    title,
    message,
    priority: 2,
  });
}
