import { api, register, getSettings, cachedState, serverNow } from '../lib/api.js';
import {
  MODELS,
  MIN_CYCLES,
  MAX_CYCLES,
  currentPhase,
  totalDuration,
  formatClock,
  formatDuration,
  fa,
} from '../lib/models.js';

const app = document.getElementById('app');
const errorBox = document.getElementById('error');

// UI-only state (not sent anywhere until the owner confirms).
const ui = {
  picking: false,
  modelId: 'pomodoro',
  cycles: 4,
  armed: null, // id of a destructive button waiting for a second click
};

let state = null;
let offset = 0;
let shownPhase = null;

// ---- tiny DOM helper (textContent only, never innerHTML) ----------------

function h(tag, props = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props || {})) {
    if (v === undefined || v === null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'hidden') el.hidden = true;
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat()) {
    if (c === null || c === undefined || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}

function showError(message) {
  errorBox.textContent = message || '';
  errorBox.hidden = !message;
}

async function run(fn) {
  showError('');
  try {
    await fn();
  } catch (err) {
    showError(err.message);
  }
  ({ state, offset } = await cachedState());
  chrome.runtime.sendMessage({ type: 'evaluate' }).catch(() => {});
  render();
}

// Two-click confirmation for destructive actions.
function confirmButton(id, label, armedLabel, action, cls = 'btn danger') {
  const armed = ui.armed === id;
  return h('button', {
    class: cls,
    onclick: () => {
      if (!armed) {
        ui.armed = id;
        render();
        setTimeout(() => {
          if (ui.armed === id) {
            ui.armed = null;
            render();
          }
        }, 4000);
        return;
      }
      ui.armed = null;
      run(action);
    },
  }, armed ? armedLabel : label);
}

// ---- views --------------------------------------------------------------

async function render() {
  shownPhase = null;
  const settings = await getSettings();
  app.replaceChildren();

  if (!settings.token) {
    app.append(registerView());
    return;
  }
  if (!state) {
    app.append(h('p', { class: 'muted center' }, 'در حال اتصال به سرور…'));
    app.append(h('button', { class: 'link', onclick: () => run(() => api.state()) }, 'تلاش دوباره'));
    return;
  }
  if (!state.group) {
    app.append(...noGroupView());
  } else {
    app.append(...groupView(state.group));
  }
  app.append(footerLinks());
  tick();
}

function registerView() {
  const input = h('input', { class: 'input', placeholder: 'مثلاً: علیرضا', maxlength: '40' });
  const submit = () => run(() => register(input.value));
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') submit(); });
  setTimeout(() => input.focus(), 0);
  return h('section', { class: 'panel' },
    h('h2', {}, 'سلام! 👋'),
    h('p', { class: 'muted' }, 'اسمت رو بنویس تا هم‌تیمی‌هات ببیننت.'),
    h('div', { class: 'field' }, input),
    h('button', { class: 'btn primary block', onclick: submit }, 'شروع'),
  );
}

function noGroupView() {
  const groupName = h('input', { class: 'input', placeholder: 'مثلاً: تیم بک‌اند', maxlength: '40' });
  const code = h('input', { class: 'input code', placeholder: 'ABC123', maxlength: '8' });
  const join = () => run(() => api.joinGroup(code.value));
  code.addEventListener('keydown', (e) => { if (e.key === 'Enter') join(); });
  return [
    h('p', { class: 'muted' }, `${state.user.name} عزیز، هنوز عضو هیچ گروهی نیستی.`),
    h('section', { class: 'panel' },
      h('h2', {}, 'عضویت با کد'),
      h('p', { class: 'muted small' }, 'کد ۶ حرفی را از سازنده‌ی گروه بگیر.'),
      h('div', { class: 'row' }, h('div', { class: 'grow' }, code),
        h('button', { class: 'btn primary', onclick: join }, 'عضویت')),
    ),
    h('div', { class: 'or' }, 'یا'),
    h('section', { class: 'panel' },
      h('h2', {}, 'ساخت گروه جدید'),
      h('p', { class: 'muted small' }, 'تو سازنده می‌شوی و مدل استراحت تیم را انتخاب می‌کنی.'),
      h('div', { class: 'row' }, h('div', { class: 'grow' }, groupName),
        h('button', { class: 'btn primary', onclick: () => run(() => api.createGroup(groupName.value)) }, 'ساخت')),
    ),
  ];
}

function groupView(group) {
  const ph = currentPhase(group.schedule, serverNow(offset));
  const out = [];

  out.push(h('div', { class: 'row between' },
    h('strong', { style: 'font-size:15px' }, group.name),
    h('span', { class: 'chip' + (group.isOwner ? '' : ' gray') }, group.isOwner ? 'سازنده' : 'عضو'),
  ));

  if (group.isOwner) {
    out.push(h('section', { class: 'panel' },
      h('h2', {}, 'کد دعوت'),
      h('div', { class: 'code-box' },
        h('span', { class: 'code' }, group.code),
        h('div', { class: 'actions' },
          h('button', {
            class: 'btn ghost',
            onclick: async (e) => {
              await navigator.clipboard.writeText(group.code);
              e.target.textContent = 'کپی شد ✓';
            },
          }, 'کپی'),
          confirmButton('regen', 'کد جدید', 'مطمئنی؟', () => api.regenerateCode(), 'btn ghost'),
        ),
      ),
      h('p', { class: 'muted small', style: 'margin:6px 0 0' },
        'هم‌تیمی‌ها با این کد عضو می‌شوند. اگر کد لو رفت، کد جدید بساز.'),
    ));
  }

  out.push(statusPanel(group, ph));

  const canPick = group.isOwner && (ph.state === 'idle' || ph.state === 'ready' || ph.state === 'finished');
  if (canPick && (ui.picking || ph.state === 'idle')) {
    out.push(modelPicker(group));
  } else if (group.schedule.modelId) {
    out.push(modelInfo(group.schedule.modelId, group.schedule.cycles));
  }

  out.push(membersPanel(group));

  out.push(h('div', { class: 'actions' },
    group.isOwner
      ? confirmButton('delete', 'حذف گروه', 'مطمئنی؟ دوباره بزن', () => api.deleteGroup())
      : confirmButton('leave', 'خروج از گروه', 'مطمئنی؟ دوباره بزن', () => api.leaveGroup()),
  ));
  return out;
}

function statusPanel(group, ph) {
  const owner = group.isOwner;
  const model = MODELS[group.schedule.modelId];

  if (ph.state === 'idle') {
    return h('section', { class: 'panel status' },
      h('p', { class: 'muted' }, owner
        ? 'یک مدل انتخاب کن، تأیید کن، و وقتی هم‌تیمی‌ها عضو شدند تایمر را شروع کن.'
        : 'منتظر انتخاب مدل توسط سازنده‌ی گروه…'),
    );
  }

  if (ph.state === 'ready' || ph.state === 'finished') {
    const finished = ph.state === 'finished';
    return h('section', { class: 'panel status' },
      h('p', {}, finished ? '🎉 همه‌ی حلقه‌ها تموم شد.' : 'مدل انتخاب شد و آماده‌ی شروع است.'),
      h('p', { class: 'muted small' },
        `${model.title} · ${fa(group.schedule.cycles)} حلقه · ${formatDuration(totalDuration(model.id, group.schedule.cycles))}`),
      owner
        ? h('div', { class: 'actions' },
          h('button', { class: 'btn primary', onclick: () => run(() => api.start()) },
            finished ? 'شروع دوباره' : 'شروع تایمر برای همه'),
          !ui.picking && h('button', { class: 'btn ghost', onclick: () => { ui.picking = true; render(); } }, 'تغییر مدل'),
        )
        : h('p', { class: 'muted small' }, finished ? '' : 'منتظر شروع توسط سازنده…'),
    );
  }

  // running or paused
  const isBreak = ph.phase.type === 'break';
  const label = isBreak ? (ph.phase.long ? 'استراحت بلند' : 'استراحت') : 'زمان کار';
  return h('section', { class: `panel status ${isBreak ? 'break' : 'work'}` },
    h('span', { class: 'chip' + (isBreak ? ' break' : '') }, ph.state === 'paused' ? `${label} · متوقف ⏸` : label),
    h('div', { class: 'clock', 'data-clock': '' }, formatClock(ph.remaining)),
    h('p', { class: 'muted small', style: 'margin:0' },
      `${model.title} · دور ${fa(ph.phase.cycle)} از ${fa(ph.cycles)}`),
    owner && h('div', { class: 'actions' },
      ph.state === 'running'
        ? h('button', { class: 'btn ghost', onclick: () => run(() => api.pause()) }, 'مکث')
        : h('button', { class: 'btn primary', onclick: () => run(() => api.resume()) }, 'ادامه'),
      confirmButton('stop', 'توقف کامل', 'مطمئنی؟', () => api.stop()),
    ),
  );
}

function modelDetails(m) {
  return h('details', {},
    h('summary', {}, 'اطلاعات بیشتر'),
    h('dl', {},
      h('dt', {}, 'ترتیب اجرا'),
      h('dd', {}, h('ol', {}, m.steps.map((s) => h('li', {}, s)))),
      h('dt', {}, 'مناسب برای'),
      h('dd', {}, m.goodFor),
      h('dt', {}, 'نقطه‌ی قوت'),
      h('dd', {}, m.pros),
      h('dt', {}, 'نقطه‌ی ضعف'),
      h('dd', {}, m.cons),
    ),
  );
}

function fixedLine(m) {
  const parts = [`کار ${fa(m.work)} دقیقه`, `استراحت ${fa(m.shortBreak)} دقیقه`];
  if (m.longEvery) parts.push(`استراحت بلند ${fa(m.longBreak)} دقیقه بعد از هر ${fa(m.longEvery)} دور`);
  return h('div', { class: 'fixed' }, '🔒 ', parts.join(' · '), ' (اعداد استاندارد و ثابت)');
}

function modelPicker(group) {
  const cards = Object.values(MODELS).map((m) =>
    h('div', {
      class: 'model' + (ui.modelId === m.id ? ' selected' : ''),
      role: 'radio',
      'aria-checked': ui.modelId === m.id ? 'true' : 'false',
      tabindex: '0',
      onclick: (e) => {
        if (e.target.closest('details')) return;
        ui.modelId = m.id;
        render();
      },
    },
    h('div', { class: 'head' }, h('strong', {}, m.title), h('span', { class: 'badge' }, m.badge)),
    h('p', {}, m.summary),
    fixedLine(m),
    modelDetails(m)),
  );

  const total = formatDuration(totalDuration(ui.modelId, ui.cycles));
  return h('section', { class: 'panel' },
    h('h2', {}, 'انتخاب مدل'),
    h('div', { class: 'models', role: 'radiogroup' }, cards),
    h('div', { class: 'row between', style: 'margin-top:12px' },
      h('span', {}, 'تعداد حلقه'),
      h('div', { class: 'stepper' },
        h('button', { onclick: () => { ui.cycles = Math.min(MAX_CYCLES, ui.cycles + 1); render(); }, 'aria-label': 'بیشتر' }, '+'),
        h('span', { class: 'value' }, fa(ui.cycles)),
        h('button', { onclick: () => { ui.cycles = Math.max(MIN_CYCLES, ui.cycles - 1); render(); }, 'aria-label': 'کمتر' }, '−'),
      ),
    ),
    h('p', { class: 'muted small', style: 'margin:4px 0 10px' },
      `هر حلقه = یک دور کار + یک استراحت. مدت کل: ${total}`),
    h('div', { class: 'actions' },
      h('button', {
        class: 'btn primary',
        onclick: () => run(async () => {
          await api.selectModel(ui.modelId, ui.cycles);
          ui.picking = false;
        }),
      }, 'تأیید مدل'),
      group.schedule.modelId && h('button', { class: 'btn ghost', onclick: () => { ui.picking = false; render(); } }, 'انصراف'),
    ),
  );
}

function modelInfo(modelId, cycles) {
  const m = MODELS[modelId];
  return h('section', { class: 'panel' },
    h('div', { class: 'model', style: 'cursor:default;border:0;padding:0' },
      h('div', { class: 'head' }, h('strong', {}, m.title), h('span', { class: 'badge' }, m.badge)),
      h('p', {}, m.summary),
      fixedLine(m),
      h('div', { class: 'fixed' }, `🔁 ${fa(cycles)} حلقه · مدت کل ${formatDuration(totalDuration(m.id, cycles))}`),
      modelDetails(m)),
  );
}

function membersPanel(group) {
  const online = group.members.filter((m) => m.online).length;
  return h('section', { class: 'panel' },
    h('h2', {}, `اعضا (${fa(group.members.length)} نفر، ${fa(online)} آنلاین)`),
    h('ul', { class: 'members' },
      group.members.map((m) => h('li', {},
        h('span', { class: 'dot' + (m.online ? ' on' : ''), title: m.online ? 'آنلاین' : 'آفلاین' }),
        h('span', { class: 'name' }, m.name, m.id === state.user.id ? ' (تو)' : ''),
        m.isOwner && h('span', { class: 'chip' }, 'سازنده'),
        group.isOwner && !m.isOwner && confirmButton(`kick:${m.id}`, '✕', 'حذف؟', () => api.kick(m.id), 'icon-btn'),
      )),
    ),
  );
}

function footerLinks() {
  return h('div', { class: 'footer small' },
    h('button', {
      class: 'link',
      onclick: () => {
        const name = prompt('نام جدید:', state.user.name);
        if (name !== null) run(() => api.rename(name));
      },
    }, `تغییر نام (${state.user.name})`),
  );
}

// ---- live clock ---------------------------------------------------------

function tick() {
  const el = app.querySelector('[data-clock]');
  if (!el || !state || !state.group) return;
  const ph = currentPhase(state.group.schedule, serverNow(offset));
  const key = `${ph.state}:${ph.index}`;
  if (shownPhase !== null && key !== shownPhase) {
    shownPhase = null;
    render();
    return;
  }
  shownPhase = key;
  if (ph.state !== 'running' && ph.state !== 'paused') return;
  el.textContent = formatClock(ph.remaining);
}

setInterval(tick, 500);

// Owner edits in another window, or a background poll: refresh the view
// unless the user is typing.
chrome.storage.onChanged.addListener(async (changes, area) => {
  if (area !== 'local' || !changes.state) return;
  ({ state, offset } = await cachedState());
  const active = document.activeElement;
  if (active && active.tagName === 'INPUT') return;
  render();
});

(async () => {
  ({ state, offset } = await cachedState());
  if (state && state.group && state.group.schedule.modelId) {
    ui.modelId = state.group.schedule.modelId;
    ui.cycles = state.group.schedule.cycles;
  }
  render();
  const { token } = await getSettings();
  if (token) run(() => api.state());
})();
