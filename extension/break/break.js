import { cachedState, serverNow } from '../lib/api.js';
import { currentPhase, formatClock, formatDuration, fa, MODELS } from '../lib/models.js';
import { nextMessage, MESSAGES } from '../lib/messages.js';

const mode = new URLSearchParams(location.search).get('mode') || 'break';
const $ = (id) => document.getElementById(id);
const CIRC = 2 * Math.PI * 52;

document.body.classList.add(mode);
$('ring').style.strokeDasharray = String(CIRC);

let state = null;
let offset = 0;

async function load() {
  ({ state, offset } = await cachedState());
}

async function init() {
  await load();
  if (mode === 'break') {
    const msg = await nextMessage('break');
    $('emoji').textContent = msg.emoji;
    $('message').textContent = msg.text;
    $('skip').hidden = false;
  } else if (mode === 'back') {
    const msg = await nextMessage('back');
    $('emoji').textContent = msg.emoji;
    $('title').textContent = 'برگرد سر کار!';
    $('message').textContent = msg.text;
    $('primary').textContent = 'بزن بریم 💪';
    $('primary').hidden = false;
    // The back-to-work window goes away on its own after two minutes.
    setTimeout(() => window.close(), 2 * 60 * 1000);
  } else {
    const msg = await nextMessage('finished');
    $('emoji').textContent = msg.emoji;
    $('title').textContent = 'تموم شد!';
    $('message').textContent = msg.text;
    $('primary').textContent = 'بستن';
    $('primary').hidden = false;
    $('timerBox').hidden = true;
  }
  tick();
  setInterval(tick, 500);
}

function tick() {
  const group = state && state.group;
  if (!group) return;
  const ph = currentPhase(group.schedule, serverNow(offset));
  const model = MODELS[group.schedule.modelId];

  if (mode === 'finished') {
    $('sub').textContent = model ? `${model.title} · ${fa(group.schedule.cycles)} حلقه` : '';
    return;
  }

  if ((ph.state === 'running' || ph.state === 'paused') && ph.phase) {
    const inMode = (mode === 'break') === (ph.phase.type === 'break');
    if (inMode) {
      $('clock').textContent = formatClock(ph.remaining);
      const done = 1 - ph.remaining / ph.phase.duration;
      $('ring').style.strokeDashoffset = String(CIRC * done);
      const what = ph.phase.type === 'break'
        ? (ph.phase.long ? 'استراحت بلند' : 'استراحت')
        : 'زمان کار';
      $('sub').textContent = ph.state === 'paused'
        ? 'تایمر گروه موقتاً متوقف شده ⏸'
        : `${what} · دور ${fa(ph.phase.cycle)} از ${fa(ph.cycles)} · ${formatDuration(ph.phase.duration)}`;
    } else if (mode === 'break') {
      // Break is over; the background is about to show "back to work".
      $('clock').textContent = formatClock(0);
      $('ring').style.strokeDashoffset = String(CIRC);
      $('sub').textContent = 'استراحت تموم شد!';
      $('skip').hidden = true;
    }
  }
}

$('primary').addEventListener('click', () => window.close());

$('skip').addEventListener('click', () => {
  const list = MESSAGES.skip;
  $('confirmText').textContent = list[Math.floor(Math.random() * list.length)];
  $('confirm').hidden = false;
  $('skip').hidden = true;
});
$('confirmNo').addEventListener('click', () => {
  $('confirm').hidden = true;
  $('skip').hidden = false;
});
$('confirmYes').addEventListener('click', () => {
  // Only this person's window closes; the group timer keeps going.
  chrome.runtime.sendMessage({ type: 'closeBreakWindow' }).catch(() => window.close());
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && (changes.state || changes.offset)) load().then(tick);
});

init();
