export function diffCues(baseCues, targetCues) {
  const baseById = new Map(baseCues.map((cue) => [cue.id, cue]));
  const targetById = new Map(targetCues.map((cue) => [cue.id, cue]));
  const tracks = [];

  for (const cue of targetCues) {
    const base = baseById.get(cue.id);
    if (!base) {
      tracks.push({ cueId: cue.id, status: 'added', changes: ['cue'] });
      continue;
    }
    const changes = [];
    if (cue.start !== base.start) changes.push({ field: 'start', base: base.start, target: cue.start, delta: cue.start - base.start });
    if (cue.end !== base.end) changes.push({ field: 'end', base: base.end, target: cue.end, delta: cue.end - base.end });
    if (cue.text !== base.text) changes.push({ field: 'text', base: base.text, target: cue.text });
    if (changes.length) tracks.push({ cueId: cue.id, status: 'changed', changes });
  }

  for (const cue of baseCues) {
    if (!targetById.has(cue.id)) tracks.push({ cueId: cue.id, status: 'removed', changes: ['cue'] });
  }

  return tracks;
}

export function summarizeDiff(tracks) {
  return tracks.reduce((summary, track) => {
    summary[track.status] = (summary[track.status] || 0) + 1;
    return summary;
  }, {});
}
