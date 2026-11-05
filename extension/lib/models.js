// Single source of truth for the break models and the schedule maths.
// The server imports this same file, so durations can only change here
// (in the code), never from the UI or from a request.

const MIN = 60 * 1000;

export const MIN_CYCLES = 1;
export const MAX_CYCLES = 8;

export const MODELS = {
  pomodoro: {
    id: 'pomodoro',
    title: 'پومودورو',
    badge: '۲۵ / ۵',
    work: 25,
    shortBreak: 5,
    longBreak: 20,
    longEvery: 4,
    summary:
      'فرانچسکو چیریلو در دهه‌ی ۱۹۸۰ این روش را ساخت. کار در بازه‌های کوتاه و پشت‌سرهم، با استراحت‌های کوتاه بین‌شان.',
    steps: [
      'یک کار مشخص انتخاب کن.',
      '۲۵ دقیقه فقط روی همان کار کار کن.',
      '۵ دقیقه استراحت کن.',
      'بعد از هر ۴ دور، یک استراحت طولانی‌تر (۲۰ دقیقه) داری.',
    ],
    goodFor: 'کارهای خرد و پشت‌سرهم، غلبه بر اهمال‌کاری، کارهای خسته‌کننده.',
    pros: 'شروع‌کردن کار را آسان می‌کند.',
    cons: '۲۵ دقیقه برای کار عمیق کوتاه است و ممکن است وسط تمرکز قطعت کند.',
  },
  '52-17': {
    id: '52-17',
    title: 'روش ۵۲/۱۷',
    badge: '۵۲ / ۱۷',
    work: 52,
    shortBreak: 17,
    summary:
      'از داده‌های نرم‌افزار DeskTime درآمده است: بهره‌ورترین کارمندها به‌طور میانگین ۵۲ دقیقه کار می‌کردند و ۱۷ دقیقه استراحت کامل داشتند.',
    steps: [
      '۵۲ دقیقه کار متمرکز.',
      '۱۷ دقیقه استراحت واقعی: دور از صفحه، نه چک‌کردن شبکه‌های اجتماعی.',
      'تکرار همین چرخه.',
    ],
    goodFor: 'کار دانشی با تمرکز متوسط و کار دفتری معمول.',
    pros: 'چرخه‌ی طولانی‌تر، استراحت کافی برای بازیابی واقعی.',
    cons: 'اگر استراحت پای گوشی بگذرد، اثرش از بین می‌رود.',
  },
  '90-20': {
    id: '90-20',
    title: 'ریتم اولترادین (۹۰/۲۰)',
    badge: '۹۰ / ۲۰',
    work: 90,
    shortBreak: 20,
    summary:
      'بر پایه‌ی تحقیقات ناتانیل کلایتمن: بدن در طول روز هم چرخه‌های حدوداً ۹۰ دقیقه‌ای اوج و افت انرژی دارد. تونی شوارتز این ایده را در محیط کار رایج کرد.',
    steps: [
      '۹۰ دقیقه کار عمیق.',
      '۲۰ دقیقه استراحت.',
      'در روز ۲ تا ۴ چرخه کافی است.',
    ],
    goodFor: 'کار عمیق: معماری سیستم، کدنویسی سنگین، نوشتن PRD و استراتژی.',
    pros: 'حالت «فلو» را کمتر می‌شکند.',
    cons: 'برای روزهای پر از جلسه سخت اجرا می‌شود.',
  },
};

export function isValidModel(id) {
  return Object.prototype.hasOwnProperty.call(MODELS, id);
}

export function isValidCycles(n) {
  return Number.isInteger(n) && n >= MIN_CYCLES && n <= MAX_CYCLES;
}

// The ordered list of phases for a session: work, break, work, break, ...
// Every cycle is one work block followed by one break.
export function buildPhases(modelId, cycles) {
  const m = MODELS[modelId];
  if (!m || !isValidCycles(cycles)) return [];
  const phases = [];
  for (let c = 1; c <= cycles; c++) {
    phases.push({ type: 'work', cycle: c, duration: m.work * MIN });
    const isLong = m.longEvery && c % m.longEvery === 0;
    phases.push({
      type: 'break',
      cycle: c,
      long: Boolean(isLong),
      duration: (isLong ? m.longBreak : m.shortBreak) * MIN,
    });
  }
  return phases;
}

export function totalDuration(modelId, cycles) {
  return buildPhases(modelId, cycles).reduce((s, p) => s + p.duration, 0);
}

// schedule: { modelId, cycles, status, startedAt, pausedAt, pausedTotal }
// status: 'idle' (no model) | 'ready' (model chosen) | 'running' | 'paused'
// now: server-clock milliseconds.
// Returns { state, index, phase, remaining, endsAt, cycles }
//   state: 'idle' | 'ready' | 'running' | 'paused' | 'finished'
export function currentPhase(schedule, now) {
  if (!schedule || !schedule.modelId || schedule.status === 'idle') {
    return { state: 'idle' };
  }
  if (schedule.status === 'ready') return { state: 'ready' };

  const phases = buildPhases(schedule.modelId, schedule.cycles);
  const ref = schedule.status === 'paused' ? schedule.pausedAt : now;
  let elapsed = ref - schedule.startedAt - (schedule.pausedTotal || 0);
  if (elapsed < 0) elapsed = 0;

  let start = 0;
  for (let i = 0; i < phases.length; i++) {
    const end = start + phases[i].duration;
    if (elapsed < end) {
      const remaining = end - elapsed;
      return {
        state: schedule.status,
        index: i,
        phase: phases[i],
        remaining,
        endsAt: schedule.status === 'running' ? now + remaining : null,
        cycles: schedule.cycles,
      };
    }
    start = end;
  }
  return { state: 'finished', cycles: schedule.cycles };
}

// Persian digits for display.
export function fa(n) {
  return String(n).replace(/\d/g, (d) => '۰۱۲۳۴۵۶۷۸۹'[d]);
}

export function formatClock(ms) {
  const total = Math.max(0, Math.ceil(ms / 1000));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return fa(`${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`);
}

export function formatDuration(ms) {
  const minutes = Math.round(ms / MIN);
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  if (!h) return `${fa(m)} دقیقه`;
  if (!m) return `${fa(h)} ساعت`;
  return `${fa(h)} ساعت و ${fa(m)} دقیقه`;
}
