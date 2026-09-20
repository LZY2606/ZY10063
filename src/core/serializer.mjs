import { msToSrtTimestamp, msToVttTimestamp, msToFrame, nsToVttTimestamp } from './time.mjs';

function uniqueLosses(losses) {
  const seen = new Set();
  return losses.filter((loss) => {
    const key = JSON.stringify(loss);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function renderVttHeaders(source) {
  const lines = ['WEBVTT'];
  const headers = source?.headers || [];
  const blocks = new Set((source?.retainedBlocks || []).map((block) => block.trim()));
  for (const header of headers) {
    if (header.type === 'file') continue;
    if (['REGION', 'STYLE', 'NOTE', 'TIMEBASE'].includes(header.type)) lines.push('', header.value);
    blocks.delete(header.value.trim());
  }
  for (const block of blocks) {
    lines.push('', block);
  }
  return lines.join('\n') + '\n';
}

function renderVttCue(cue, index) {
  const block = [];
  if (cue.identifier) block.push(cue.identifier);
  const settings = cue.vttSettings ? ' ' + cue.vttSettings : '';
  const start = cue.startNs === null || cue.startNs === undefined ? msToVttTimestamp(cue.start) : nsToVttTimestamp(cue.startNs);
  const end = cue.endNs === null || cue.endNs === undefined ? msToVttTimestamp(cue.end) : nsToVttTimestamp(cue.endNs);
  block.push(start + ' --> ' + end + settings);
  block.push(cue.text);
  return block.join('\n');
}

function renderSrtCue(cue, index) {
  const block = [String(cue.sourceNumber || cue.sourceSequence || index + 1)];
  block.push(msToSrtTimestamp(cue.start) + ' --> ' + msToSrtTimestamp(cue.end));
  block.push(cue.text);
  return block.join('\n');
}

function frameClock(ms, fps) {
  const frame = msToFrame(ms, fps);
  const rate = Math.round(fps);
  const hours = Math.floor(frame / (3600 * rate));
  const minutes = Math.floor((frame % (3600 * rate)) / (60 * rate));
  const seconds = Math.floor((frame % (60 * rate)) / rate);
  const frames = frame % rate;
  const pad = (value) => String(value).padStart(2, '0');
  return [hours, minutes, seconds, frames].map(pad).join(':');
}

function renderFrameCue(cue, index, fps) {
  return frameClock(cue.start, fps) + ' --> ' + frameClock(cue.end, fps) + ' fps=' + fps + '\n' + cue.text;
}

export function serializeTimeline(project, cues, options = {}) {
  const targetFormat = options.targetFormat || project?.source?.format || 'srt';
  const fps = options.fps ? Number(options.fps) : (project?.source?.defaultFps || 24);
  const sourceFormat = project?.source?.format || targetFormat;
  const losses = [];

  if (!['srt', 'vtt', 'frames'].includes(targetFormat)) {
    throw new Error('Unsupported target format: ' + targetFormat);
  }

  const headers = project?.source?.headers || [];
  if (targetFormat !== 'vtt') {
    for (const header of headers) {
      if (header.type !== 'file') {
        losses.push({
          type: 'header-unsupported',
          severity: 'warning',
          headerType: header.type,
          reason: targetFormat.toUpperCase() + ' has no standard representation for retained ' + header.type + ' blocks'
        });
      }
    }
  }

  for (const cue of cues) {
    if (targetFormat === 'srt') {
      if (cue.vttSettings) {
        losses.push({ type: 'cue-settings', severity: 'warning', cueId: cue.id, value: cue.vttSettings, reason: 'SRT cannot express VTT cue settings' });
      }
      if (cue.identifier && !/^\d+$/.test(String(cue.identifier).trim())) {
        losses.push({ type: 'cue-identifier', severity: 'info', cueId: cue.id, value: cue.identifier, reason: 'SRT cue identifier must be numeric' });
      }
    }
    if (targetFormat === 'frames') {
      if (cue.vttSettings) {
        losses.push({ type: 'cue-settings', severity: 'warning', cueId: cue.id, value: cue.vttSettings, reason: 'Frame text cannot express VTT cue settings' });
      }
      if (cue.identifier && !/^\d+$/.test(String(cue.identifier).trim())) {
        losses.push({ type: 'cue-identifier', severity: 'info', cueId: cue.id, value: cue.identifier, reason: 'Frame text cannot preserve a non-numeric cue identifier' });
      }
    }
  }

  let content;
  if (targetFormat === 'vtt') {
    content = renderVttHeaders(project?.source) + '\n' + cues.map(renderVttCue).join('\n\n') + '\n';
  } else if (targetFormat === 'srt') {
    content = cues.map(renderSrtCue).join('\n\n') + '\n';
  } else {
    content = 'TIMEBASE fps=' + fps + '\n\n' + cues.map((cue, index) => renderFrameCue(cue, index, fps)).join('\n\n') + '\n';
  }

  const lossReport = {
    sourceFormat,
    targetFormat,
    fps: targetFormat === 'frames' ? fps : null,
    cueCount: cues.length,
    retainedRawCues: project?.source?.cues?.length || cues.length,
    frameBoundaryQuantization: targetFormat === 'frames',
    losses: uniqueLosses(losses),
    note: 'The imported raw text and retained source blocks remain stored even when the selected target format cannot write them back.'
  };

  return { content, lossReport, filename: (project?.title || 'timeline').replace(/[^\w.-]+/g, '-').toLowerCase() + '.' + (targetFormat === 'frames' ? 'frames.txt' : targetFormat) };
}
