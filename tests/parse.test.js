import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseSrt, parseVtt, parseFrameText } from '../src/core/parse.js';

test('SRT 解析：时间、文本、原文保留', () => {
  const raw = '1\n00:00:01,000 --> 00:00:02,500\nHello world\n\n2\n00:00:03,000 --> 00:00:04,000\nSecond line\n';
  const { cues, meta } = parseSrt(raw);
  assert.equal(cues.length, 2);
  assert.equal(cues[0].startMs, 1000);
  assert.equal(cues[0].endMs, 2500);
  assert.equal(cues[0].text, 'Hello world');
  assert.ok(cues[0].raw.includes('00:00:01,000'));
  assert.equal(meta.format, 'srt');
});

test('WebVTT 解析：NOTE/STYLE/设置/说话人保留', () => {
  const raw = [
    'WEBVTT - test',
    '',
    'NOTE 这是注释',
    '',
    'STYLE',
    '::cue { color: lime }',
    '',
    'cue-id-1',
    '00:00:01.000 --> 00:00:02.000 align:start position:10%',
    '<v Alice>你好</v>',
    '',
  ].join('\n');
  const { cues, meta } = parseVtt(raw);
  assert.equal(cues.length, 1);
  assert.equal(cues[0].speaker, 'Alice');
  assert.equal(cues[0].settings, 'align:start position:10%');
  assert.equal(cues[0].sourceId, 'cue-id-1');
  assert.equal(meta.notes.length, 1);
  assert.equal(meta.styles.length, 1);
});

test('帧号文本：默认 fps 与中途换时基', () => {
  const raw = '# fps=25\n0 25 第一句\n# fps=24\n48 72 第二句\n';
  const { cues, meta } = parseFrameText(raw, 25);
  assert.equal(cues[0].startMs, 0);
  assert.equal(cues[0].endMs, 1000);
  assert.equal(cues[1].startMs, 2000); // 48/24s
  assert.equal(cues[1].endMs, 3000);
  assert.equal(meta.fpsChanges.length, 2);
  assert.equal(meta.fpsChanges[1].fps, 24);
});

test('帧号文本支持 23.976 与分隔符变体', () => {
  const { cues } = parseFrameText('24|48|第一句\n50-72 第二句\n', 23.976);
  assert.equal(cues[0].startMs, Math.round((24 * 1000) / 23.976));
  assert.equal(cues[1].endMs, Math.round((72 * 1000) / 23.976));
});
