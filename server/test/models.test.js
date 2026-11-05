import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildPhases, currentPhase, totalDuration, isValidCycles,
} from '../../extension/lib/models.js';

const MIN = 60000;

test('pomodoro: long break after every 4th cycle', () => {
  const p = buildPhases('pomodoro', 8);
  assert.equal(p.length, 16);
  assert.deepEqual(p.slice(0, 2).map((x) => x.duration / MIN), [25, 5]);
  assert.equal(p[7].long, true);
  assert.equal(p[7].duration, 20 * MIN);
  assert.equal(p[15].long, true);
  assert.equal(p[5].long, false);
});

test('52/17 and 90/20 durations', () => {
  assert.equal(totalDuration('52-17', 2), (52 + 17) * 2 * MIN);
  assert.equal(totalDuration('90-20', 3), (90 + 20) * 3 * MIN);
});

test('cycles are limited to 1..8', () => {
  assert.equal(isValidCycles(0), false);
  assert.equal(isValidCycles(9), false);
  assert.equal(isValidCycles(1.5), false);
  assert.equal(isValidCycles(8), true);
  assert.deepEqual(buildPhases('pomodoro', 9), []);
  assert.deepEqual(buildPhases('custom', 2), []);
});

test('current phase while running', () => {
  const s = { modelId: '52-17', cycles: 2, status: 'running', startedAt: 0, pausedTotal: 0 };
  let ph = currentPhase(s, 10 * MIN);
  assert.equal(ph.phase.type, 'work');
  assert.equal(ph.remaining, 42 * MIN);
  ph = currentPhase(s, 60 * MIN);
  assert.equal(ph.phase.type, 'break');
  assert.equal(ph.index, 1);
  assert.equal(ph.remaining, 9 * MIN);
  ph = currentPhase(s, 69 * MIN);
  assert.equal(ph.index, 2);
  assert.equal(ph.phase.cycle, 2);
  assert.equal(currentPhase(s, 138 * MIN).state, 'finished');
});

test('pause freezes time and paused time is excluded', () => {
  const paused = { modelId: 'pomodoro', cycles: 1, status: 'paused', startedAt: 0, pausedAt: 10 * MIN, pausedTotal: 0 };
  assert.equal(currentPhase(paused, 999 * MIN).remaining, 15 * MIN);
  const resumed = { modelId: 'pomodoro', cycles: 1, status: 'running', startedAt: 0, pausedTotal: 5 * MIN };
  assert.equal(currentPhase(resumed, 20 * MIN).remaining, 10 * MIN);
});

test('idle and ready states', () => {
  assert.equal(currentPhase(null, 0).state, 'idle');
  assert.equal(currentPhase({ modelId: 'pomodoro', cycles: 4, status: 'ready' }, 0).state, 'ready');
});
