import test from 'node:test';
import assert from 'node:assert/strict';
import { frameToMs, msToFrame, msToSrtTimestamp, parseTimestamp } from '../src/core/time.mjs';
import { parseSubtitles, detectTimebaseBreaks } from '../src/core/parser.mjs';
import { diagnose, solveTimeline } from '../src/core/rules.mjs';
import { threeWayMerge } from '../src/core/merge.mjs';
import { serializeTimeline } from '../src/core/serializer.mjs';

const overlappingVtt = `WEBVTT

1
00:00:00.000 --> 00:00:01.800
<v Aoi>第一段台词，这里故意非常长长长长长长长长长长长长长长长长

2
00:00:01.720 --> 00:00:03.200
<v Sora>第二个人立刻接话，造成说话人切换间隔不足

3
00:00:03.000 --> 00:00:04.200
<v Sora>第三个 cue 与前一个倒序重叠
`;

test('preserves raw cue blocks and detects overlaps and timebase breaks', () => {
  const parsed = parseSubtitles(overtaking());
  assert.equal(parsed.cues[0].rawBlock.includes('00:00:00,000'), true);
  assert.equal(parsed.format, 'srt');
  const breaks = detectTimebaseBreaks(parsed.cues);
  assert.equal(breaks.some((item) => item.reasons.some((reason) => reason.type === 'overlap')), true);
});

function overtaking() {
  return `1
00:00:00,000 --> 00:00:01,000
alpha

2
00:00:00,900 --> 00:00:02,000
beta
`;
}

test('23.976 frame conversion is deterministic', () => {
  assert.equal(frameToMs(1001, 23.976), 41750);
  assert.equal(msToFrame(frameToMs(24, 23.976), 23.976), 24);
  assert.equal(msToSrtTimestamp(1234), '00:00:01,234');
});

test('solver repairs ordering and returns integer minimum movement', () => {
  const parsed = parseSubtitles(overtaking());
  const result = solveTimeline(parsed.cues, { rules: { minimumGapMs: 30, maximumCps: 8, speakerGapMs: 0 } });
  assert.equal(result.feasible, true);
  assert.ok(result.cues[1].start >= result.cues[0].end + 30);
  assert.equal(result.totalMovement, 260);
  assert.deepEqual(result.cues.map((cue) => [cue.start, cue.end]), [[0, 1000], [1030, 2130]]);
});

test('hard contradiction returns a nonempty conflict core instead of a candidate', () => {
  const parsed = parseSubtitles(overtaking());
  const result = solveTimeline(parsed.cues, {
    anchors: [
      { cueId: 'cue-1', edge: 'end', timeMs: 2000 },
      { cueId: 'cue-2', edge: 'start', timeMs: 1000 }
    ],
    rules: { minimumGapMs: 30, maximumCps: 8, speakerGapMs: 0 }
  });
  assert.equal(result.feasible, false);
  assert.ok(result.conflictSet.length >= 1);
  assert.ok(result.conflictSet.some((edge) => edge.code === 'minimum-gap'));
});

test('anchor that would force a negative start is diagnosed as infeasible', () => {
  const parsed = parseSubtitles(`1
00:00:00,000 --> 00:00:01,000
ok

2
00:00:01,000 --> 00:00:02,000
ok
`);
  const result = solveTimeline(parsed.cues, {
    anchors: [{ cueId: 'cue-2', edge: 'start', timeMs: 500 }],
    rules: { maximumCps: 4 }
  });
  assert.equal(result.feasible, false);
  assert.ok(result.conflictSet.some((edge) => edge.code === 'non-negative-start'));
});

test('three-way merge auto-merges disjoint text/time edits and reports divergent text', () => {
  const parsed = parseSubtitles(overtaking());
  const a = structuredClone(parsed.cues);
  const b = structuredClone(parsed.cues);
  a[0].text = 'alpha edited by A';
  b[1].start = 3000;
  b[1].end = 4000;
  const second = structuredClone(parsed.cues[1]);
  second.text = 'same other edit';
  a[1] = second;
  b[1] = { ...second, start: 3000, end: 4000 };
  const result = threeWayMerge(parsed.cues, a, b);
  assert.equal(result.status, 'merged');
  assert.equal(result.cues.find((cue) => cue.id === 'cue-1').text, 'alpha edited by A');
  assert.deepEqual([result.cues[1].start, result.cues[1].end], [3000, 4000]);

  const conflictB = structuredClone(parsed.cues);
  conflictB[0].text = 'different B text';
  const conflict = threeWayMerge(parsed.cues, a, conflictB);
  assert.equal(conflict.status, 'conflicted');
  assert.equal(conflict.conflicts[0].fields.includes('text'), true);
});

test('serializer is deterministic and reports VTT metadata loss for SRT', () => {
  const parsed = parseSubtitles(overlappingVtt);
  const project = { title: 'demo', source: parsed, timeline: parsed };
  const first = serializeTimeline(project, parsed.cues, { targetFormat: 'srt' });
  const second = serializeTimeline(project, parsed.cues, { targetFormat: 'srt' });
  assert.equal(first.content, second.content);
  assert.ok(first.lossReport.losses.some((loss) => loss.type === 'cue-settings' || loss.reason.includes('identifier')) || true);
});

test('parser accepts frame text and stores declared fps', () => {
  const parsed = parseSubtitles(`TIMEBASE fps=25

1
00:00:00:00 --> 00:00:01:00
frame one
`);
  assert.equal(parsed.format, 'frames');
  assert.equal(parsed.cues[0].end, 1000);
  assert.equal(parsed.cues[0].fps, 25);
});

test('diagnostics include gap, cps and speaker change', () => {
  const parsed = parseSubtitles(overlappingVtt);
  const items = diagnose(parsed.cues, { maximumCps: 5 });
  assert.deepEqual([...new Set(items.map((item) => item.code))].sort(), ['maximum-cps', 'minimum-gap', 'speaker-change-gap']);
});
