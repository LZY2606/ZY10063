// 诊断：时间轴断点识别 + 冲突体检（间隔 / CPS / 说话人连续性）。

import { DEFAULT_PARAMS } from './solve.js';

export function analyzeTimeline(cues, meta = {}, opts = {}) {
  const gapBreakMs = opts.gapBreakMs ?? 3000;
  const breaks = [];
  for (const fc of meta.fpsChanges ?? []) {
    breaks.push({
      type: 'fps-change',
      line: fc.line,
      fps: fc.fps,
      afterCueIndex: fc.afterCueIndex,
      detail: `第 ${fc.line} 行起时基切换为 ${fc.fps} fps`,
    });
  }
  for (let i = 0; i < cues.length; i += 1) {
    const cue = cues[i];
    if (cue.endMs < cue.startMs) {
      breaks.push({ type: 'negative-duration', cueId: cue.id, detail: '结束早于开始' });
    }
    if (i === 0) continue;
    const prev = cues[i - 1];
    if (cue.startMs < prev.startMs) {
      breaks.push({ type: 'out-of-order', cueId: cue.id, detail: '开始时间早于上一条' });
    } else if (cue.startMs < prev.endMs) {
      breaks.push({
        type: 'overlap',
        cueId: cue.id,
        with: prev.id,
        overlapMs: prev.endMs - cue.startMs,
        detail: `与 ${prev.id} 重叠 ${prev.endMs - cue.startMs}ms`,
      });
    } else if (cue.startMs - prev.endMs >= gapBreakMs) {
      breaks.push({
        type: 'gap-break',
        cueId: cue.id,
        gapMs: cue.startMs - prev.endMs,
        detail: `与上一条间隔 ${cue.startMs - prev.endMs}ms，疑似段落断点`,
      });
    }
  }
  return breaks;
}

export function diagnoseCues(cues, params = {}) {
  const p = { ...DEFAULT_PARAMS, ...params };
  const issues = [];
  for (let i = 0; i < cues.length; i += 1) {
    const cue = cues[i];
    const durMs = cue.endMs - cue.startMs;
    if (durMs < p.minDurationMs) {
      issues.push({ type: 'short-duration', cueId: cue.id, durationMs: durMs, minDurationMs: p.minDurationMs });
    }
    const chars = (cue.text ?? '').replace(/\s+/g, '').length;
    if (chars && durMs > 0) {
      const cps = chars / (durMs / 1000);
      if (cps > p.maxCps) {
        issues.push({ type: 'cps', cueId: cue.id, cps: Math.round(cps * 10) / 10, maxCps: p.maxCps });
      }
    }
    if (i === 0) continue;
    const prev = cues[i - 1];
    const gap = cue.startMs - prev.endMs;
    if (gap < p.minGapMs) {
      issues.push({ type: 'gap', cueId: cue.id, with: prev.id, gapMs: gap, minGapMs: p.minGapMs });
    }
    if (cue.speaker && prev.speaker && cue.speaker === prev.speaker && gap >= 1000) {
      issues.push({
        type: 'speaker-continuity',
        cueId: cue.id,
        with: prev.id,
        speaker: cue.speaker,
        gapMs: gap,
        detail: `同一说话人「${cue.speaker}」被 ${gap}ms 空隙断开`,
      });
    }
  }
  return issues;
}
