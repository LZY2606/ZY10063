import { test } from 'node:test';
import assert from 'node:assert/strict';
import { solve, minimizeConflictSet, DEFAULT_PARAMS } from '../src/core/solve.js';
import { frameToMs } from '../src/core/time.js';

function mkCues(specs) {
  return specs.map(([startMs, endMs, text], i) => ({
    id: `cue-${i + 1}`,
    index: i,
    startMs,
    endMs,
    text: text ?? `台词${i + 1}`,
    speaker: null,
  }));
}

test('无锚点时时间轴保持不变', () => {
  const cues = mkCues([[1000, 2000], [3000, 4000]]);
  const r = solve(cues);
  assert.equal(r.status, 'ok');
  assert.deepEqual(r.cues.map((c) => [c.startMs, c.endMs]), [[1000, 2000], [3000, 4000]]);
  assert.equal(r.movementMs, 0);
});

test('锚点把台词钉到指定帧，段内整体伸缩', () => {
  const cues = mkCues([[0, 1000], [1000, 2000], [2000, 3000], [3000, 4000]]);
  const target = frameToMs(240, 24); // 10s
  const r = solve(cues, { anchors: [{ cueId: 'cue-3', frame: 240, fps: 24 }] });
  assert.equal(r.status, 'ok');
  assert.equal(r.cues[2].startMs, target);
  // 段内拉伸：cue-1/cue-2 占据 [0, 10s)，cue-4 刚性平移
  assert.ok(r.cues[1].endMs <= r.cues[2].startMs);
  assert.ok(r.cues[3].startMs >= r.cues[2].endMs);
});

test('重叠被修复：不倒序、无负时长、保持最小间隔', () => {
  const cues = mkCues([[1000, 2500], [2400, 2600], [2550, 2700]]);
  const r = solve(cues);
  assert.equal(r.status, 'ok');
  for (let i = 1; i < r.cues.length; i += 1) {
    assert.ok(r.cues[i].startMs >= r.cues[i - 1].endMs + DEFAULT_PARAMS.minGapMs);
  }
  for (const c of r.cues) {
    assert.ok(c.endMs - c.startMs >= DEFAULT_PARAMS.minDurationMs);
    assert.ok(c.startMs >= 0);
  }
});

test('锚点互相矛盾时报无解并给出最小冲突集', () => {
  const cues = mkCues([[0, 1000], [2000, 3000]]);
  const opts = {
    anchors: [
      { cueId: 'cue-1', ms: 5000 },
      { cueId: 'cue-2', ms: 1000 }, // 顺序矛盾
    ],
  };
  const r = solve(cues, opts);
  assert.equal(r.status, 'infeasible');
  const minimal = minimizeConflictSet(cues, opts, r.conflicts);
  assert.ok(minimal.length >= 2);
  // MUS 语义：只启用集合内约束仍不可解；再去掉任意一个即可解
  assert.equal(solve(cues, { ...opts, only: minimal }).status, 'infeasible');
  for (const key of minimal) {
    const rest = minimal.filter((k) => k !== key);
    assert.equal(solve(cues, { ...opts, only: rest }).status, 'ok');
  }
  // 全部放松后整体可解
  assert.equal(solve(cues, { ...opts, relax: minimal }).status, 'ok');
});

test('两个锚点夹死、段内容纳不下最小时长时无解', () => {
  const cues = mkCues([[0, 1000], [1000, 2000], [2000, 3000], [3000, 4000]]);
  const opts = {
    anchors: [
      { cueId: 'cue-1', ms: 0 },
      { cueId: 'cue-4', ms: 1500 }, // cue-2/cue-3 只有 ~620ms 空间
    ],
  };
  const r = solve(cues, opts);
  assert.equal(r.status, 'infeasible');
  const minimal = minimizeConflictSet(cues, opts, r.conflicts);
  assert.ok(minimal.some((k) => k.startsWith('segment-fit:')));
});

test('锁段后重新求解：锁定 cue 不动，其余适配', () => {
  const cues = mkCues([[0, 1000], [1200, 2200], [5000, 6000]]);
  const first = solve(cues);
  assert.equal(first.status, 'ok');
  const lockedStart = first.cues[1].startMs;
  const r = solve(first.cues, {
    locked: ['cue-2'],
    anchors: [{ cueId: 'cue-3', ms: 9000 }],
  });
  assert.equal(r.status, 'ok');
  assert.equal(r.cues[1].startMs, lockedStart);
  assert.equal(r.cues[2].startMs, 9000);
});

test('CPS 超限进入诊断而不是静默截断', () => {
  // 后续锚点挡住延展空间，长台词无法靠延长时长消化
  const cues = mkCues([
    [0, 1000, '这是一段非常非常非常长的台词，远远超过每秒字符数限制'],
    [2000, 3000],
  ]);
  const r = solve(cues, {
    params: { maxCps: 5, minDurationMs: 500 },
    anchors: [{ cueId: 'cue-2', ms: 2000 }],
  });
  assert.equal(r.status, 'ok');
  assert.ok(r.diagnostics.some((d) => d.type === 'cps' && d.cueId === 'cue-1'));
});
