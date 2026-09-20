// 求解器：在锚点/锁段约束下重排时间轴。
// 硬约束：不倒序、无负时长、相邻最小间隔、锚点/锁段位置固定。
// 软目标：总移动量最小（分段线性时间扭曲 + 局部压缩）。
// 无解时返回冲突约束键集合；minimizeConflictSet 将其归约为最小冲突集（MUS）：
// 集合整体不可解，去掉任意一个约束即可解。

import { frameToMs } from './time.js';

export const DEFAULT_PARAMS = {
  minGapMs: 80,
  minDurationMs: 800,
  maxCps: 25,
};

function uniq(arr) {
  return [...new Set(arr)];
}

export function solve(cuesInput, opts = {}) {
  const params = { ...DEFAULT_PARAMS, ...(opts.params ?? {}) };
  const relax = new Set(opts.relax ?? []);
  const only = opts.only ? new Set(opts.only) : null;
  // off(key)：该约束被显式放松，或不在 only 白名单内
  const off = (key) => relax.has(key) || (only !== null && !only.has(key));
  const cues = cuesInput.map((c) => ({ ...c }));
  const byId = new Map(cues.map((c) => [c.id, c]));

  // 固定点：锚点（只固定起点）与锁段（起止都固定）
  const fixed = new Map();
  for (const anchor of opts.anchors ?? []) {
    if (!byId.has(anchor.cueId)) continue;
    const key = `anchor:${anchor.cueId}`;
    if (off(key)) continue;
    const startMs = anchor.ms ?? frameToMs(anchor.frame, anchor.fps);
    fixed.set(anchor.cueId, { startMs, endMs: null, key });
  }
  for (const cueId of opts.locked ?? []) {
    const cue = byId.get(cueId);
    if (!cue) continue;
    const key = `lock:${cueId}`;
    if (off(key)) continue;
    fixed.set(cueId, { startMs: cue.startMs, endMs: cue.endMs, key });
  }

  // 锚点顺序一致性：时间目标不得与台词顺序矛盾
  const fixedCues = cues.filter((c) => fixed.has(c.id));
  const orderConflicts = [];
  for (let i = 1; i < fixedCues.length; i += 1) {
    const prev = fixed.get(fixedCues[i - 1].id);
    const cur = fixed.get(fixedCues[i].id);
    if (cur.startMs < prev.startMs) {
      orderConflicts.push(prev.key, cur.key);
    }
  }
  if (orderConflicts.length) {
    return { status: 'infeasible', conflicts: uniq(orderConflicts) };
  }

  // 分段线性时间扭曲：控制点 = 固定点的 (原始时间 -> 目标时间)
  const points = [];
  for (const cue of fixedCues) {
    const f = fixed.get(cue.id);
    points.push({ from: cue.startMs, to: f.startMs });
    if (f.endMs != null) points.push({ from: cue.endMs, to: f.endMs });
  }
  points.sort((a, b) => a.from - b.from);
  const warp = (t) => {
    if (!points.length) return t;
    if (t <= points[0].from) return t + (points[0].to - points[0].from);
    for (let i = 1; i < points.length; i += 1) {
      if (t <= points[i].from) {
        const a = points[i - 1];
        const b = points[i];
        const k = b.from === a.from ? 0 : (t - a.from) / (b.from - a.from);
        return a.to + k * (b.to - a.to);
      }
    }
    const last = points[points.length - 1];
    return t + (last.to - last.from);
  };

  for (const cue of cues) {
    const f = fixed.get(cue.id);
    if (f) {
      const dur = cue.endMs - cue.startMs;
      cue.startMs = f.startMs;
      cue.endMs = f.endMs ?? f.startMs + Math.max(dur, 0);
    } else {
      const s = warp(cue.startMs);
      const e = warp(cue.endMs);
      cue.startMs = Math.round(s);
      cue.endMs = Math.round(Math.max(e, s));
    }
  }

  // 分段放置：固定点之间的自由 cue 需满足最小时长与最小间隔
  const conflicts = [];
  const isFixed = (cue) => fixed.has(cue.id);
  let i = 0;
  while (i < cues.length) {
    if (isFixed(cues[i])) {
      i += 1;
      continue;
    }
    let j = i;
    while (j < cues.length && !isFixed(cues[j])) j += 1;
    const seg = cues.slice(i, j);
    const prevFixed = i > 0 ? cues[i - 1] : null;
    const nextFixed = j < cues.length ? cues[j] : null;
    const L = prevFixed ? prevFixed.endMs + params.minGapMs : 0;
    const R = nextFixed ? fixed.get(nextFixed.id).startMs - params.minGapMs : Infinity;
    const fitKey = `segment-fit:${seg[0].id}:${seg[seg.length - 1].id}`;
    const minNeed =
      seg.reduce((sum) => sum + params.minDurationMs, 0) + params.minGapMs * (seg.length - 1);
    if (minNeed > R - L && !off(fitKey)) {
      const keys = [fitKey];
      if (prevFixed) keys.push(fixed.get(prevFixed.id).key);
      if (nextFixed) keys.push(fixed.get(nextFixed.id).key);
      conflicts.push(...keys);
    }

    const desired = seg.map((c) => Math.max(params.minDurationMs, c.endMs - c.startMs));
    const desiredTotal = desired.reduce((a, b) => a + b, 0) + params.minGapMs * (seg.length - 1);
    let durations = desired;
    if (desiredTotal > R - L) {
      // 空间不足：按比例把时长压缩到 [minDuration, desired] 区间
      const slack = R - L - (seg.length - 1) * params.minGapMs - seg.length * params.minDurationMs;
      const stretchPool =
        desiredTotal - params.minGapMs * (seg.length - 1) - seg.length * params.minDurationMs;
      durations = desired.map((d) =>
        stretchPool > 0
          ? params.minDurationMs + Math.max(0, ((d - params.minDurationMs) * slack) / stretchPool)
          : params.minDurationMs,
      );
    }
    let cur = L;
    seg.forEach((cue, k) => {
      cue.startMs = Math.max(cue.startMs, Math.round(cur));
      cue.endMs = cue.startMs + Math.round(durations[k]);
      cur = cue.endMs + params.minGapMs;
    });
    if (seg[seg.length - 1].endMs > R) {
      // 从右向左回压，保证不越过下一个固定点
      let curEnd = R;
      for (let k = seg.length - 1; k >= 0; k -= 1) {
        const cue = seg[k];
        const dur = cue.endMs - cue.startMs;
        cue.endMs = Math.min(cue.endMs, Math.round(curEnd));
        cue.startMs = cue.endMs - dur;
        curEnd = cue.startMs - params.minGapMs;
      }
      if (seg[0].startMs < L) {
        const shift = L - seg[0].startMs;
        for (const cue of seg) {
          cue.startMs += shift;
          cue.endMs += shift;
        }
      }
    }
    i = j;
  }

  // 相邻固定点之间的间隔 / 锁定时长校验
  for (let k = 1; k < cues.length; k += 1) {
    const a = cues[k - 1];
    const b = cues[k];
    if (isFixed(a) && isFixed(b)) {
      const gapKey = `gap:${a.id}:${b.id}`;
      if (b.startMs - a.endMs < params.minGapMs && !off(gapKey)) {
        conflicts.push(fixed.get(a.id).key, fixed.get(b.id).key, gapKey);
      }
    }
    const f = fixed.get(b.id);
    if (f && f.endMs != null) {
      const durKey = `dur:${b.id}`;
      if (b.endMs - b.startMs < params.minDurationMs && !off(durKey)) {
        conflicts.push(f.key, durKey);
      }
    }
  }
  if (cues.length && cues[0].startMs < 0) {
    const nnKey = `nonneg:${cues[0].id}`;
    if (!off(nnKey)) {
      conflicts.push(nnKey);
      if (fixed.has(cues[0].id)) conflicts.push(fixed.get(cues[0].id).key);
    }
  }
  if (conflicts.length) {
    return { status: 'infeasible', conflicts: uniq(conflicts) };
  }

  // CPS：尽量向后续空隙延展，仍超限则记入诊断
  const diagnostics = [];
  for (let k = 0; k < cues.length; k += 1) {
    const cue = cues[k];
    const chars = (cue.text ?? '').replace(/\s+/g, '').length;
    if (!chars) continue;
    let durMs = cue.endMs - cue.startMs;
    let cps = durMs > 0 ? chars / (durMs / 1000) : Infinity;
    if (cps > params.maxCps && fixed.get(cue.id)?.endMs == null) {
      const next = cues[k + 1];
      const limit = next ? next.startMs - params.minGapMs : Infinity;
      const needDur = Math.ceil((chars / params.maxCps) * 1000);
      const target = Math.min(limit, cue.startMs + needDur);
      if (target > cue.endMs) {
        cue.endMs = Math.round(target);
        durMs = cue.endMs - cue.startMs;
        cps = chars / (durMs / 1000);
      }
    }
    if (cps > params.maxCps) {
      diagnostics.push({
        type: 'cps',
        cueId: cue.id,
        cps: Math.round(cps * 10) / 10,
        maxCps: params.maxCps,
      });
    }
  }

  let movementMs = 0;
  cues.forEach((cue, idx) => {
    movementMs +=
      Math.abs(cue.startMs - cuesInput[idx].startMs) + Math.abs(cue.endMs - cuesInput[idx].endMs);
  });

  return { status: 'ok', cues, diagnostics, movementMs };
}

// 最小冲突集（MUS）：只启用集合内约束时不可解；再去掉任意一个即可解。
export function minimizeConflictSet(cues, opts, conflictKeys) {
  const result = [...conflictKeys];
  for (const key of [...result]) {
    const trial = result.filter((k) => k !== key);
    const attempt = solve(cues, { ...opts, only: trial });
    if (attempt.status === 'infeasible') {
      result.splice(result.indexOf(key), 1);
    }
  }
  return result;
}
