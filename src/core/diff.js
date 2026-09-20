// cue 级差异：按 id 对齐，逐字段比较。
const FIELDS = ['startMs', 'endMs', 'text', 'speaker'];

export function diffCues(before, after) {
  const beforeMap = new Map(before.map((c) => [c.id, c]));
  const afterMap = new Map(after.map((c) => [c.id, c]));
  const added = [];
  const removed = [];
  const changed = [];
  for (const [id, cue] of afterMap) {
    if (!beforeMap.has(id)) {
      added.push(cue);
      continue;
    }
    const old = beforeMap.get(id);
    const fields = {};
    for (const f of FIELDS) {
      if ((old[f] ?? null) !== (cue[f] ?? null)) {
        fields[f] = { from: old[f] ?? null, to: cue[f] ?? null };
      }
    }
    if (Object.keys(fields).length) changed.push({ id, fields });
  }
  for (const [id, cue] of beforeMap) {
    if (!afterMap.has(id)) removed.push(cue);
  }
  return { added, removed, changed };
}

export function cuesEqual(a, b) {
  const d = diffCues(a, b);
  return !d.added.length && !d.removed.length && !d.changed.length;
}
