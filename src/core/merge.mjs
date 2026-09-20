function mapCues(cues) {
  return new Map(cues.map((cue) => [cue.id, cue]));
}

function fieldChanged(base, a, b, field) {
  const baseValue = base ? base[field] : undefined;
  return (a ? a[field] : undefined) !== baseValue || (b ? b[field] : undefined) !== baseValue;
}

function bothChangedDifferently(base, a, b, field) {
  const baseValue = base ? base[field] : undefined;
  const aValue = a ? a[field] : undefined;
  const bValue = b ? b[field] : undefined;
  return aValue !== baseValue && bValue !== baseValue && aValue !== bValue;
}

export function threeWayMerge(baseCues, aCues, bCues) {
  const base = mapCues(baseCues);
  const a = mapCues(aCues);
  const b = mapCues(bCues);
  const ids = new Set([...base.keys(), ...a.keys(), ...b.keys()]);
  const mergedCues = [];
  const conflicts = [];
  const autoMerged = [];

  for (const id of ids) {
    const baseCue = base.get(id);
    const aCue = a.get(id);
    const bCue = b.get(id);

    if (aCue && bCue && aCue.text === bCue.text && aCue.start === bCue.start && aCue.end === bCue.end) {
      mergedCues.push({ ...aCue });
      if (baseCue && (aCue.text !== baseCue.text || aCue.start !== baseCue.start || aCue.end !== baseCue.end)) {
        autoMerged.push({ cueId: id, resolution: 'identical-edits' });
      }
      continue;
    }

    if (!aCue || !bCue) {
      if (baseCue && !aCue && bCue) {
        conflicts.push({ cueId: id, kind: 'delete-vs-edit', base: baseCue, a: null, b: bCue });
      } else if (baseCue && aCue && !bCue) {
        conflicts.push({ cueId: id, kind: 'edit-vs-delete', base: baseCue, a: aCue, b: null });
      } else if (aCue && !baseCue && !bCue) {
        mergedCues.push({ ...aCue });
        autoMerged.push({ cueId: id, resolution: 'a-only' });
      } else if (bCue && !baseCue && !aCue) {
        mergedCues.push({ ...bCue });
        autoMerged.push({ cueId: id, resolution: 'b-only' });
      }
      continue;
    }

    const fields = ['start', 'end', 'text'];
    const conflictFields = fields.filter((field) => bothChangedDifferently(baseCue, aCue, bCue, field));
    if (conflictFields.length) {
      conflicts.push({ cueId: id, kind: 'divergent-fields', fields: conflictFields, base: baseCue, a: aCue, b: bCue });
      mergedCues.push({ ...aCue });
      continue;
    }

    const merged = { ...baseCue };
    for (const field of fields) {
      const baseValue = baseCue ? baseCue[field] : undefined;
      if (aCue[field] !== baseValue) merged[field] = aCue[field];
      if (bCue[field] !== baseValue) merged[field] = bCue[field];
    }
    if (fields.some((field) => fieldChanged(baseCue, aCue, bCue, field))) {
      autoMerged.push({ cueId: id, resolution: 'disjoint-fields' });
    }
    mergedCues.push(merged);
  }

  mergedCues.sort((left, right) => {
    if (left.start !== right.start) return left.start - right.start;
    if (left.end !== right.end) return left.end - right.end;
    return left.id.localeCompare(right.id);
  });
  for (let index = 0; index < mergedCues.length; index += 1) {
    mergedCues[index] = { ...mergedCues[index], index };
  }

  return {
    status: conflicts.length ? 'conflicted' : 'merged',
    cues: mergedCues,
    conflicts,
    autoMerged
  };
}
