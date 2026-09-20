// 解析器：SRT / WebVTT / 带帧号文本。
// 原则：原始块文本（raw）原样保留，任何规范化只发生在派生字段上。

import { parseTimestamp, frameToMs, parseFps } from './time.js';

let counter = 0;
function nextId() {
  counter += 1;
  return `cue-${counter}`;
}

// 测试等场景需要确定性 id 时重置计数器
export function resetCueIds() {
  counter = 0;
}

function stripTags(text) {
  return text.replace(/<[^>]+>/g, '');
}

function extractSpeaker(payload) {
  // WebVTT 语音标签 <v Name>… 或 "Name: 台词" 前缀
  const vMatch = /<v\s+([^>]+)>/.exec(payload);
  if (vMatch) return vMatch[1].trim();
  const firstLine = payload.split('\n')[0] ?? '';
  const colon = /^([^\s:：]{1,24})\s*[:：]\s+\S/.exec(firstLine);
  if (colon) return colon[1];
  return null;
}

function splitBlocks(text) {
  return text
    .replace(/\r\n?/g, '\n')
    .split(/\n{2,}/)
    .map((b) => b.replace(/^\n+|\n+$/g, ''))
    .filter((b) => b.length > 0);
}

export function parseSrt(text) {
  resetCueIdsIfFirst();
  const cues = [];
  for (const block of splitBlocks(text)) {
    const lines = block.split('\n');
    const timeIdx = lines.findIndex((l) => l.includes('-->'));
    if (timeIdx === -1) continue;
    const [startRaw, endRaw] = lines[timeIdx].split('-->').map((s) => s.trim());
    const payload = lines.slice(timeIdx + 1).join('\n');
    cues.push({
      id: nextId(),
      index: cues.length,
      startMs: parseTimestamp(startRaw),
      endMs: parseTimestamp(endRaw),
      text: stripTags(payload),
      speaker: extractSpeaker(payload),
      settings: null,
      sourceId: timeIdx > 0 ? lines[0] : null,
      raw: block,
    });
  }
  return { format: 'srt', cues, meta: { format: 'srt', notes: [], styles: [], header: null } };
}

export function parseVtt(text) {
  resetCueIdsIfFirst();
  const normalized = text.replace(/\r\n?/g, '\n');
  if (!/^\uFEFF?WEBVTT/.test(normalized)) throw new Error('不是合法的 WebVTT：缺少 WEBVTT 头');
  const cues = [];
  const notes = [];
  const styles = [];
  const blocks = splitBlocks(normalized.replace(/^\uFEFF?/, ''));
  // 第一块是 WEBVTT 头（可能带头部元数据）
  const header = blocks.shift();
  for (const block of blocks) {
    if (/^NOTE([ \t\n]|$)/.test(block)) {
      notes.push(block);
      continue;
    }
    if (/^STYLE([ \t\n]|$)/.test(block)) {
      styles.push(block);
      continue;
    }
    const lines = block.split('\n');
    const timeIdx = lines.findIndex((l) => l.includes('-->'));
    if (timeIdx === -1) continue; // 未知块（如 REGION），按 note 保留以免丢信息
    const timing = lines[timeIdx];
    const arrowIdx = timing.indexOf('-->');
    const startRaw = timing.slice(0, arrowIdx).trim();
    const rest = timing.slice(arrowIdx + 3).trim().split(/[ \t]+/);
    const endRaw = rest.shift();
    const settings = rest.length ? rest.join(' ') : null;
    const payload = lines.slice(timeIdx + 1).join('\n');
    cues.push({
      id: nextId(),
      index: cues.length,
      startMs: parseTimestamp(startRaw),
      endMs: parseTimestamp(endRaw),
      text: stripTags(payload),
      speaker: extractSpeaker(payload),
      settings,
      sourceId: timeIdx > 0 ? lines[0] : null,
      raw: block,
    });
  }
  return {
    format: 'vtt',
    cues,
    meta: { format: 'vtt', notes, styles, header: header ?? 'WEBVTT' },
  };
}

// 带帧号文本：
//   # fps=23.976        —— 时基声明，可多次出现（中途换时基）
//   120 168 台词        —— 起始帧 结束帧 文本（也支持 "120-168 台词"、"120|168|台词"）
export function parseFrameText(text, defaultFps = 25) {
  resetCueIdsIfFirst();
  const cues = [];
  const fpsChanges = [];
  let fps = parseFps(defaultFps);
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  lines.forEach((line, lineNo) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    const fpsMatch = /^#\s*fps\s*=\s*(\S+)/i.exec(trimmed);
    if (fpsMatch) {
      fps = parseFps(fpsMatch[1]);
      fpsChanges.push({ line: lineNo + 1, fps, afterCueIndex: cues.length });
      return;
    }
    if (trimmed.startsWith('#')) return; // 其它注释
    const m = /^(\d+)\s*(?:\||-|\s)\s*(\d+)\s*(?:\||\s)\s*(.*)$/.exec(trimmed);
    if (!m) throw new Error(`第 ${lineNo + 1} 行无法解析: ${JSON.stringify(line)}`);
    const [, startF, endF, payload] = m;
    cues.push({
      id: nextId(),
      index: cues.length,
      startMs: frameToMs(Number(startF), fps),
      endMs: frameToMs(Number(endF), fps),
      startFrame: Number(startF),
      endFrame: Number(endF),
      fps,
      text: stripTags(payload),
      speaker: extractSpeaker(payload),
      settings: null,
      sourceId: null,
      raw: line,
    });
  });
  return {
    format: 'frames',
    cues,
    meta: { format: 'frames', fps, fpsChanges, notes: [], styles: [], header: null },
  };
}

let parsedOnce = false;
function resetCueIdsIfFirst() {
  // 每次顶层解析重新从 cue-1 开始，保证同一进程内多次解析结果可预期
  resetCueIds();
  parsedOnce = true;
}

export function parseByFormat(format, content, opts = {}) {
  switch (format) {
    case 'srt':
      return parseSrt(content);
    case 'vtt':
      return parseVtt(content);
    case 'frames':
      return parseFrameText(content, opts.fps ?? 25);
    default:
      throw new Error(`未知格式: ${format}`);
  }
}
