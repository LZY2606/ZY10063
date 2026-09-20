// 导出：确定性输出（无时间戳、固定排序、固定换行），
// 并生成 loss report 说明目标格式无法表达的信息。

import { formatTimestamp, msToFrame } from './time.js';

function sortedCues(cues) {
  return [...cues].sort((a, b) => a.startMs - b.startMs || a.index - b.index);
}

function payloadOf(cue, { withSpeakerTag = false } = {}) {
  const text = cue.text ?? '';
  if (withSpeakerTag && cue.speaker) return `<v ${cue.speaker}>${text}</v>`;
  if (!withSpeakerTag && cue.speaker) return `${cue.speaker}: ${text}`;
  return text;
}

export function toSrt(cues, meta = {}) {
  const loss = collectLoss('srt', cues, meta);
  const body = sortedCues(cues)
    .map(
      (cue, i) =>
        `${i + 1}\n${formatTimestamp(cue.startMs, ',')} --> ${formatTimestamp(cue.endMs, ',')}\n${payloadOf(cue)}`,
    )
    .join('\n\n');
  return { content: body + '\n', loss };
}

export function toVtt(cues, meta = {}) {
  const loss = collectLoss('vtt', cues, meta);
  const parts = [meta.header ?? 'WEBVTT'];
  for (const style of meta.styles ?? []) parts.push(style);
  for (const note of meta.notes ?? []) parts.push(note);
  for (const cue of sortedCues(cues)) {
    const lines = [];
    if (cue.sourceId) lines.push(cue.sourceId);
    const settings = cue.settings ? ` ${cue.settings}` : '';
    lines.push(
      `${formatTimestamp(cue.startMs, '.')} --> ${formatTimestamp(cue.endMs, '.')}${settings}`,
    );
    lines.push(payloadOf(cue, { withSpeakerTag: true }));
    parts.push(lines.join('\n'));
  }
  return { content: parts.join('\n\n') + '\n', loss };
}

export function toFrames(cues, fps, meta = {}) {
  const loss = collectLoss('frames', cues, meta);
  const lines = [`# fps=${fps}`];
  for (const cue of sortedCues(cues)) {
    lines.push(`${msToFrame(cue.startMs, fps)} ${msToFrame(cue.endMs, fps)} ${cue.text ?? ''}`);
  }
  return { content: lines.join('\n') + '\n', loss };
}

function collectLoss(target, cues, meta) {
  const loss = [];
  if (target === 'srt') {
    for (const note of meta.notes ?? []) {
      loss.push({ kind: 'note', detail: 'SRT 不支持注释块', raw: note });
    }
    for (const style of meta.styles ?? []) {
      loss.push({ kind: 'style', detail: 'SRT 不支持 STYLE 块', raw: style });
    }
    for (const cue of cues) {
      if (cue.settings) {
        loss.push({ kind: 'settings', cueId: cue.id, detail: `cue 定位设置无法写回: ${cue.settings}` });
      }
      if (cue.sourceId && !/^\d+$/.test(cue.sourceId)) {
        loss.push({ kind: 'cue-id', cueId: cue.id, detail: `非数字 cue id「${cue.sourceId}」被序号替代` });
      }
    }
  }
  if (target === 'frames') {
    for (const note of meta.notes ?? []) {
      loss.push({ kind: 'note', detail: '帧号文本不支持注释块', raw: note });
    }
    for (const style of meta.styles ?? []) {
      loss.push({ kind: 'style', detail: '帧号文本不支持样式', raw: style });
    }
    for (const cue of cues) {
      if (cue.speaker) {
        loss.push({ kind: 'speaker', cueId: cue.id, detail: `说话人「${cue.speaker}」无法写回帧号文本` });
      }
      if (cue.settings) {
        loss.push({ kind: 'settings', cueId: cue.id, detail: `cue 定位设置无法写回: ${cue.settings}` });
      }
    }
    loss.push({ kind: 'quantization', detail: `时间被量化到帧（${target === 'frames' ? 'round-trip 后稳定' : ''}）` });
  }
  return loss;
}

export function exportCues(cues, format, { fps = 25, meta = {} } = {}) {
  switch (format) {
    case 'srt':
      return toSrt(cues, meta);
    case 'vtt':
      return toVtt(cues, meta);
    case 'frames':
      return toFrames(cues, fps, meta);
    default:
      throw new Error(`未知导出格式: ${format}`);
  }
}
