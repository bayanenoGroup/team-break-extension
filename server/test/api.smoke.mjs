// Run against `npm run dev`: node test/api.smoke.mjs [baseUrl]
const B = process.argv[2] || 'http://127.0.0.1:8787';
let ok = 0, bad = 0;
const check = (name, cond, extra) => { cond ? ok++ : bad++; console.log(cond ? 'PASS' : 'FAIL', name, cond ? '' : JSON.stringify(extra)); };
async function call(token, method, path, body) {
  const r = await fetch(B + path, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, data: await r.json() };
}
const owner = (await call(null, 'POST', '/api/register', { name: 'علیرضا' })).data;
const mem = (await call(null, 'POST', '/api/register', { name: 'سارا' })).data;
const other = (await call(null, 'POST', '/api/register', { name: 'رضا' })).data;
check('register gives token', owner.token && owner.group === null);
check('no auth -> 401', (await call(null, 'GET', '/api/state')).status === 401);
check('empty name rejected', (await call(null, 'POST', '/api/register', { name: '  ' })).status === 400);

let r = await call(owner.token, 'POST', '/api/groups/create', { name: 'تیم بک‌اند' });
const code = r.data.group.code;
check('create group', r.status === 200 && r.data.group.isOwner && /^[A-Z2-9]{6}$/.test(code), r);
check('owner cannot create second group', (await call(owner.token, 'POST', '/api/groups/create', { name: 'x' })).status === 409);

r = await call(mem.token, 'POST', '/api/groups/join', { code: code.toLowerCase() });
check('member joins (case-insensitive)', r.status === 200 && r.data.group.members.length === 2 && r.data.group.code === null, r);
check('member cannot join another', (await call(mem.token, 'POST', '/api/groups/join', { code })).status === 409);
check('wrong code 404', (await call(other.token, 'POST', '/api/groups/join', { code: 'ZZZZZZ' })).status === 404);

check('member cannot select model', (await call(mem.token, 'POST', '/api/groups/select-model', { modelId: 'pomodoro', cycles: 4 })).status === 403);
check('invalid model rejected', (await call(owner.token, 'POST', '/api/groups/select-model', { modelId: 'custom', cycles: 4 })).status === 400);
check('cycles 9 rejected', (await call(owner.token, 'POST', '/api/groups/select-model', { modelId: 'pomodoro', cycles: 9 })).status === 400);
check('start before model rejected', (await call(owner.token, 'POST', '/api/groups/start')).status === 409);
r = await call(owner.token, 'POST', '/api/groups/select-model', { modelId: '52-17', cycles: 3, work: 1, shortBreak: 1 });
check('select model (extra durations ignored)', r.data.group.schedule.status === 'ready' && !('work' in r.data.group.schedule), r);

r = await call(owner.token, 'POST', '/api/groups/start');
check('start', r.data.group.schedule.status === 'running' && r.data.group.schedule.startedAt > 0, r);
check('change model while running rejected', (await call(owner.token, 'POST', '/api/groups/select-model', { modelId: 'pomodoro', cycles: 1 })).status === 409);
r = await call(mem.token, 'GET', '/api/state');
check('member sees running schedule', r.data.group.schedule.status === 'running' && r.data.group.schedule.modelId === '52-17');
check('member cannot pause', (await call(mem.token, 'POST', '/api/groups/pause')).status === 403);
r = await call(owner.token, 'POST', '/api/groups/pause');
check('pause', r.data.group.schedule.status === 'paused');
await new Promise((res) => setTimeout(res, 300));
r = await call(owner.token, 'POST', '/api/groups/resume');
check('resume adds paused time', r.data.group.schedule.status === 'running' && r.data.group.schedule.pausedTotal >= 250, r.data.group.schedule);
r = await call(owner.token, 'POST', '/api/groups/stop');
check('stop -> ready', r.data.group.schedule.status === 'ready');

check('owner cannot leave', (await call(owner.token, 'POST', '/api/groups/leave')).status === 409);
r = await call(owner.token, 'POST', '/api/groups/regenerate-code');
check('regenerate code', r.data.group.code !== code);
check('old code dead', (await call(other.token, 'POST', '/api/groups/join', { code })).status === 404);
r = await call(owner.token, 'POST', '/api/groups/kick', { userId: mem.userId });
check('kick', r.data.group.members.length === 1);
check('kicked member has no group', (await call(mem.token, 'GET', '/api/state')).data.group === null);
r = await call(mem.token, 'POST', '/api/groups/join', { code: (await call(owner.token, 'GET', '/api/state')).data.group.code });
check('rejoin with new code', r.status === 200);
check('member leaves', (await call(mem.token, 'POST', '/api/groups/leave')).data.group === null);
await call(mem.token, 'POST', '/api/groups/join', { code: (await call(owner.token, 'GET', '/api/state')).data.group.code });
r = await call(owner.token, 'POST', '/api/groups/delete');
check('delete group', r.data.group === null);
check('members released after delete', (await call(mem.token, 'GET', '/api/state')).data.group === null);
r = await call(mem.token, 'POST', '/api/me/name', { name: '<b>سارا</b>' });
check('rename strips < >', r.data.user.name === 'bسارا/b', r.data.user);

// brute-force limit
let last;
for (let i = 0; i < 11; i++) last = await call(other.token, 'POST', '/api/groups/join', { code: 'AAAAA' + i });
check('join brute force throttled', last.status === 429, last);

const pre = await fetch(B + '/api/state', { method: 'OPTIONS' });
check('CORS preflight', pre.status === 204 && pre.headers.get('access-control-allow-origin') === '*');
console.log(`\n${ok} passed, ${bad} failed`);
