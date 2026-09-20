import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseVtt, parseSrt, parseFrameText } from '../src/core/parse.js';
import { exportCues } from '../src/core/export.js';

const VTT = [
  'WEBVTT - demo',
  '',
  'NOTE 导演注释',
  '',
  'STYLE',
  '::cue { color: lime }',
  '',
  'intro',
  '00:00:01.000 --> 00:00:02.500 align:start',
  '<v Alice>你好世界</v>',
  '',
  '00:00:03.000 --> 00:00:04.000',
  '第二句',
  '',
].join('\n');

test('导出确定性：同输入两次导出字节一致', () => {
  const { cues, meta } = parseVtt(VTT);
  const a = exportCues(cues, 'srt', { meta });
  const b = exportCues(cues, 'srt', { meta });
  assert.equal(a.content, b.content);
});

test('VTT → SRT 的 loss report 覆盖注释/样式/设置/cue id', () => {
  const { cues, meta } = parseVtt(VTT);
  const { loss } = exportCues(cues, 'srt', { meta });
  const kinds = loss.map((l) => l.kind);
  assert.ok(kinds.includes('note'));
  assert.ok(kinds.includes('style'));
  assert.ok(kinds.includes('settings'));
  assert.ok(kinds.includes('cue-id'));
});

test('VTT 往返：导出再导入时间毫秒不漂移', () => {
  const first = parseVtt(VTT);
  const out1 = exportCues(first.cues, 'vtt', { meta: first.meta });
  const second = parseVtt(out1.content);
  const out2 = exportCues(second.cues, 'vtt', { meta: second.meta });
  assert.equal(out1.content, out2.content);
  assert.deepEqual(
    second.cues.map((c) => [c.startMs, c.endMs]),
    first.cues.map((c) => [c.startMs, c.endMs]),
  );
});

test('帧号导出：量化一次后达到不动点，不再持续漂移', () => {
  const { cues } = parseSrt('1\n00:00:01,013 --> 00:00:02,007\n你好\n');
  const out1 = exportCues(cues, 'frames', { fps: 25 });
  const re1 = parseFrameText(out1.content, 25);
  const out2 = exportCues(re1.cues, 'frames', { fps: 25 });
  const re2 = parseFrameText(out2.content, 25);
  const out3 = exportCues(re2.cues, 'frames', { fps: 25 });
  assert.equal(out2.content, out3.content); // 不动点
  assert.equal(out1.content, out2.content); // 首次量化即稳定
});

test('SRT 导出内容格式正确', () => {
  const { cues } = parseSrt('1\n00:00:01,000 --> 00:00:02,000\n你好\n');
  const { content } = exportCues(cues, 'srt');
  assert.equal(content, '1\n00:00:01,000 --> 00:00:02,000\n你好\n');
});
