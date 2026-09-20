import { frameToMs, normalizeFps, parseClockToNs, parseTimestamp } from './time.mjs';

const TIMING_RE = /^(.+?)\s*-->\s*(.+?)(?:\s+(.*))?$/;

export function detectFormat(input, hint) {
  if (hint && hint !== 'auto') return hint;
  const text = String(input).replace(/^\uFEFF/, '');
  if (/^WEBVTT/m.test(text)) return 'vtt';
  const lines = text.split(/\r\n|\n|\r/);
  for (const line of lines) {
    if (line.includes('-->')) {
      const match = line.match(TIMING_RE);
      if (!match) continue;
      const timingIndex = lines.indexOf(line);
      if (isFrameClock(match[1].trim())) return 'frames';
      if (line.includes(',') || /^\d+\s*$/.test((lines[timingIndex - 1] || '').trim())) return 'srt';
      return 'vtt';
    }
  }
  return 'srt';
}

function isFrameClock(value) {
  return /^\d{1,3}:\d{2}:\d{2}:\d{2}$/.test(value) || /^\d+$/.test(value);
}

function parseFpsMarker(text) {
  const match = String(text).match(/(?:^|[\s@[])(?:fps|timebase)[:=]\s*([0-9]+(?:\.[0-9]+)?)/i);
  if (!match) return null;
  return normalizeFps(match[1]);
}

function parseFrameClock(value, fps) {
  const text = value.trim();
  if (/^\d+$/.test(text)) return Number(text);
  const parts = text.split(':').map(Number);
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part))) return null;
  const [hours, minutes, seconds, frames] = parts;
  return (((hours * 60 + minutes) * 60 + seconds) * Math.round(fps)) + frames;
}

function splitBlocks(input) {
  const lines = String(input).replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n');
  const blocks = [];
  let current = [];
  for (const line of lines) {
    if (line.trim() === '') {
      if (current.length) blocks.push(current);
      current = [];
    } else {
      current.push(line);
    }
  }
  if (current.length) blocks.push(current);
  return blocks;
}

function headerFps(lines) {
  for (const line of lines) {
    const fps = parseFpsMarker(line);
    if (fps !== null) return fps;
  }
  return null;
}

function cueFpsFromTiming(tail, fallback) {
  const fps = parseFpsMarker(tail || '');
  return { fps: fps ?? fallback, explicit: fps !== null };
}

function findTimingLine(lines) {
  return lines.findIndex((line) => TIMING_RE.test(line));
}

function parseCueBlock(lines, format, index, sourceSequence, fallbackFps) {
  const timingIndex = findTimingLine(lines);
  if (timingIndex < 0) return null;
  const before = lines.slice(0, timingIndex);
  const timingLine = lines[timingIndex];
  const textLines = lines.slice(timingIndex + 1);
  const match = timingLine.match(TIMING_RE);
  const identifier = before.filter((line) => !/^\s*$/.test(line)).join('\n') || null;
  const sourceNumber = identifier && /^\d+$/.test(identifier.trim()) ? Number(identifier.trim()) : sourceSequence;
  const settings = (match[3] ?? '').trim();
  let start;
  let end;
  let startNs = null;
  let endNs = null;
  let fps = fallbackFps;
  let fpsExplicit = false;

  if (format === 'frames') {
    const marker = cueFpsFromTiming(settings, fallbackFps);
    fps = marker.fps;
    fpsExplicit = marker.explicit;
    const startFrame = parseFrameClock(match[1], fps);
    const endFrame = parseFrameClock(match[2], fps);
    if (startFrame === null || endFrame === null || endFrame < startFrame) {
      throw new Error(`Invalid frame timing at cue ${sourceSequence}`);
    }
    start = frameToMs(startFrame, fps);
    end = frameToMs(endFrame, fps);
  } else {
    const clock = parseTimestamp(match[1] + '-->' + match[2]);
    if (!clock) throw new Error(`Invalid timing at cue ${sourceSequence}`);
    start = clock.start;
    end = clock.end;
    if (format === 'vtt') {
      startNs = parseClockToNs(match[1]);
      endNs = parseClockToNs(match[2]);
    }
  }

  const text = textLines.join('\n');
  if (!text.trim()) throw new Error(`Empty cue text at cue ${sourceSequence}`);

  return {
    id: `cue-${sourceSequence}`,
    index,
    sourceSequence,
    sourceNumber,
    identifier,
    start,
    end,
    startNs: format === 'vtt' ? startNs : null,
    endNs: format === 'vtt' ? endNs : null,
    text,
    format,
    fps: format === 'frames' ? fps : null,
    fpsExplicit,
    vttSettings: format === 'vtt' ? settings : '',
    frameSettings: format === 'frames' ? settings : '',
    rawBlock: lines.join('\n')
  };
}

export function parseSubtitles(input, options = {}) {
  const format = detectFormat(input, options.format);
  const text = String(input).replace(/^\uFEFF/, '');
  const blocks = splitBlocks(text);
  const defaultFps = normalizeFps(options.fps || headerFps(text.split(/\r\n|\n|\r/)) || 24);
  const headers = [];
  const retainedBlocks = [];
  const cues = [];
  let activeFps = defaultFps;
  let sourceSequence = 0;

  for (const blockLines of blocks) {
    const joined = blockLines.join('\n');
    if (format === 'vtt' && /^WEBVTT/.test(blockLines[0])) {
      headers.push({ type: 'file', value: joined });
      continue;
    }
    if (format === 'vtt' && /^(?:NOTE|STYLE|REGION)\b/.test(blockLines[0])) {
      const type = blockLines[0].split(/\s|:/, 1)[0].toUpperCase();
      headers.push({ type, value: joined });
      retainedBlocks.push(joined);
      continue;
    }
    const marker = headerFps(blockLines);
    if (findTimingLine(blockLines) < 0 && marker !== null) {
      activeFps = marker;
      headers.push({ type: 'TIMEBASE', value: joined });
      continue;
    }
    sourceSequence += 1;
    const cue = parseCueBlock(blockLines, format, cues.length, sourceSequence, activeFps);
    if (!cue) {
      headers.push({ type: 'UNKNOWN', value: joined });
      continue;
    }
    if (cue.fpsExplicit && cue.fps !== activeFps) activeFps = cue.fps;
    cues.push(cue);
  }

  if (!cues.length) throw new Error('No importable cues found');
  return {
    format,
    raw: text,
    defaultFps,
    headers,
    retainedBlocks,
    cues,
    breakpoints: detectTimebaseBreaks(cues)
  };
}

export function detectTimebaseBreaks(cues) {
  const breakpoints = [];
  for (let i = 1; i < cues.length; i += 1) {
    const previous = cues[i - 1];
    const current = cues[i];
    const reasons = [];
    if (current.fps !== null && previous.fps !== null && current.fps !== previous.fps) {
      reasons.push({ type: 'fps-change', from: previous.fps, to: current.fps });
    }
    if (current.fpsExplicit && (previous.fps === null || current.fps !== previous.fps)) {
      reasons.push({ type: 'explicit-timebase-marker', fps: current.fps });
    }
    const gap = current.start - previous.end;
    if (gap < 0) reasons.push({ type: 'overlap', ms: gap });
    if (gap > 60_000 && !reasons.some((reason) => reason.type === 'fps-change')) {
      reasons.push({ type: 'large-gap', ms: gap });
    }
    if (reasons.length) breakpoints.push({ afterCueId: previous.id, beforeCueId: current.id, gap, reasons });
  }
  return breakpoints;
}

export function extractSpeaker(text) {
  const firstLine = String(text).split('\n')[0].trim();
  const tagged = firstLine.match(/^<v(?:\.[^>\s]+)*\s+([^>]+)>(.*)$/i);
  if (tagged) return { speaker: tagged[1].trim(), text: tagged[2] || firstLine.replace(/<\/v>$/i, '') };
  const dash = firstLine.match(/^-\s*([^:]{1,40}):\s*(.+)$/);
  if (dash) return { speaker: dash[1].trim(), text: dash[2] };
  const plain = firstLine.match(/^([A-Z][\w .'\-]{0,40}):\s*(.+)$/);
  if (plain) return { speaker: plain[1].trim(), text: plain[2] };
  return { speaker: null, text: firstLine };
}
