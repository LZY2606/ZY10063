import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mergeCues } from '../src/core/merge.js';

const base = [
  { id: 'cue-1', index: 0, startMs: 0, endMs: 1000, text: '甲', speaker: null },
  { id: 'cue-2', index: 1, startMs: 1000, endMs: 2000, text: '乙', speaker: null },
  { id: 'cue-3', index: 2, startMs: 2000, endMs: 3000, text: '丙', speaker: null },
];

test('无冲突修改自动合入', () => {
  const left = base.map((c) => (c.id === 'cue-1' ? { ...c, startMs: 100 } : c));
  const right = base.map((c) => (c.id === 'cue-3' ? { ...c, text: '丙改' } : c));
  const { merged, conflicts } = mergeCues(base, left, right);
  assert.equal(conflicts.length, 0);
  assert.equal(merged.find((c) => c.id === 'cue-1').startMs, 100);
  assert.equal(merged.find((c) => c.id === 'cue-3').text, '丙改');
});

test('同一 cue 双方改不同值 → 三方上下文冲突', () => {
  const left = base.map((c) => (c.id === 'cue-2' ? { ...c, text: '我方版本' } : c));
  const right = base.map((c) => (c.id === 'cue-2' ? { ...c, text: '对方版本' } : c));
  const { conflicts } = mergeCues(base, left, right);
  assert.equal(conflicts.length, 1);
  assert.equal(conflicts[0].cueId, 'cue-2');
  assert.equal(conflicts[0].base, '乙');
  assert.equal(conflicts[0].left, '我方版本');
  assert.equal(conflicts[0].right, '对方版本');
});

test('同一字段双方改成相同值不冲突', () => {
  const left = base.map((c) => (c.id === 'cue-2' ? { ...c, endMs: 2500 } : c));
  const right = base.map((c) => (c.id === 'cue-2' ? { ...c, endMs: 2500 } : c));
  const { conflicts, merged } = mergeCues(base, left, right);
  assert.equal(conflicts.length, 0);
  assert.equal(merged.find((c) => c.id === 'cue-2').endMs, 2500);
});
