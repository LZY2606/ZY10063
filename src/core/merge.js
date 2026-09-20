// 三方合并：base（共同祖先）、left（当前）、right（对方）。
// 同一 cue 同一字段双方改得不一致时记入 conflicts，附三方上下文；
// 其余自动合入。

import { cuesEqual } from './diff.js';

const FIELDS = ['startMs', 'endMs', 'text', 'speaker'];

export function mergeCues(base, left, right) {
  const baseMap = new Map(base.map((c) => [c.id, c]));
  const leftMap = new Map(left.map((c) => [c.id, c]));
  const rightMap = new Map(right.map((c) => [c.id, c]));
  const ids = [...leftMap.keys()];
  for (const id of rightMap.keys()) {
    if (!leftMap.has(id)) ids.push(id);
  }
  const merged = [];
  const conflicts = [];
  for (const id of ids) {
    const b = baseMap.get(id) ?? null;
    const l = leftMap.get(id) ?? null;
    const r = rightMap.get(id) ?? null;
    if (l && !r) {
      // 对方删除：若我方未改则跟随删除，否则冲突
      if (b && cuesEqual([b], [l])) continue;
      conflicts.push({ cueId: id, field: '*', base: b, left: l, right: null });
      merged.push(l);
      continue;
    }
    if (!l && r) {
      if (b && cuesEqual([b], [r])) continue;
      conflicts.push({ cueId: id, field: '*', base: b, left: null, right: r });
      merged.push(r);
      continue;
    }
    if (!l && !r) continue;
    const out = { ...l };
    for (const field of FIELDS) {
      const bv = b?.[field] ?? null;
      const lv = l[field] ?? null;
      const rv = r[field] ?? null;
      if (lv === rv) {
        out[field] = lv;
      } else if (bv === lv) {
        out[field] = rv; // 只有对方改了
      } else if (bv === rv) {
        out[field] = lv; // 只有我方改了
      } else {
        conflicts.push({
          cueId: id,
          field,
          base: bv,
          left: lv,
          right: rv,
        });
        // 冲突字段暂留我方值，由用户裁决
      }
    }
    merged.push(out);
  }
  merged.sort((a, c) => a.index - c.index || a.startMs - c.startMs);
  return { merged, conflicts };
}
