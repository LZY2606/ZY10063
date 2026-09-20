import { extractSpeaker } from './parser.mjs';

export const DEFAULT_RULES = Object.freeze({
  minimumGapMs: 30,
  maximumCps: 21,
  speakerGapMs: 80,
  preserveSpeakerRuns: true
});

export function plainTextLength(text) {
  return String(text)
    .replace(/<[^>]+>/g, '')
    .replace(/\\[a-z]\d+/gi, '')
    .replace(/\s+/g, '')
    .length;
}

export function durationSeconds(durationMs) {
  return Math.max(0, durationMs) / 1000;
}

export function cueMinimumDurationMs(cue, rules = DEFAULT_RULES) {
  const cps = Number(rules.maximumCps);
  if (!Number.isFinite(cps) || cps <= 0) return 0;
  return Math.ceil((plainTextLength(cue.text) * 1000) / cps);
}

export function diagnose(cues, suppliedRules = {}) {
  const rules = { ...DEFAULT_RULES, ...suppliedRules };
  const diagnostics = [];
  let previous = null;
  let previousSpeaker = null;

  for (const cue of cues) {
    const duration = cue.end - cue.start;
    if (duration < 0) {
      diagnostics.push({
        severity: 'error',
        code: 'negative-duration',
        cueId: cue.id,
        requiredMs: 0,
        actualMs: duration,
        message: `Cue ${cue.sourceSequence} has negative duration`
      });
    }
    const minimumDuration = cueMinimumDurationMs(cue, rules);
    if (duration < minimumDuration) {
      diagnostics.push({
        severity: 'error',
        code: 'maximum-cps',
        cueId: cue.id,
        requiredMs: minimumDuration,
        actualMs: duration,
        message: `Cue ${cue.sourceSequence} needs ${minimumDuration} ms at ${rules.maximumCps} CPS`
      });
    }
    const spoken = extractSpeaker(cue.text);
    if (previous) {
      const gap = cue.start - previous.end;
      if (gap < rules.minimumGapMs) {
        diagnostics.push({
          severity: 'error',
          code: 'minimum-gap',
          cueId: cue.id,
          previousCueId: previous.id,
          requiredMs: rules.minimumGapMs,
          actualMs: gap,
          message: `Cue ${previous.sourceSequence} and ${cue.sourceSequence} need ${rules.minimumGapMs} ms separation`
        });
      }
      if (
        rules.preserveSpeakerRuns &&
        spoken.speaker &&
        previousSpeaker &&
        spoken.speaker !== previousSpeaker.speaker &&
        gap < rules.speakerGapMs
      ) {
        diagnostics.push({
          severity: 'error',
          code: 'speaker-change-gap',
          cueId: cue.id,
          previousCueId: previous.id,
          requiredMs: rules.speakerGapMs,
          actualMs: gap,
          speaker: spoken.speaker,
          previousSpeaker: previousSpeaker.speaker,
          message: `Speaker change ${previousSpeaker.speaker} → ${spoken.speaker} needs ${rules.speakerGapMs} ms`
        });
      }
    }
    previous = cue;
    previousSpeaker = spoken;
  }

  return diagnostics;
}

function eventIndex(events, cueId, edge) {
  const index = events.findIndex((event) => event.cueId === cueId && event.edge === edge);
  if (index < 0) throw new Error(`Missing timeline event for ${cueId}:${edge}`);
  return index;
}

function eventValue(cues, cueId, edge) {
  const cue = cues.find((item) => item.id === cueId);
  return edge === 'start' ? cue.start : cue.end;
}

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

function weightedMedian(observations) {
  const sorted = [...observations].sort((a, b) => a.value - b.value || a.index - b.index);
  const totalWeight = sorted.reduce((sum, item) => sum + item.weight, 0);
  let cumulative = 0;
  for (const item of sorted) {
    cumulative += item.weight;
    if (cumulative * 2 >= totalWeight) return item.value;
  }
  return sorted.at(-1).value;
}

function l1Isotonic(observations, fixed) {
  let blocks = observations.map((item) => ({
    indices: [item.index],
    observations: [item],
    fixed: fixed[item.index] !== undefined
  }));

  for (let i = 0; i < blocks.length; i += 1) {
    while (i > 0) {
      const left = blocks[i - 1];
      const right = blocks[i];
      const leftValue = left.fixed ? fixed[left.indices[0]] : median(left.observations.map((item) => item.value));
      const rightValue = right.fixed ? fixed[right.indices[0]] : median(right.observations.map((item) => item.value));
      if (leftValue <= rightValue) break;
      blocks[i - 1] = {
        indices: [...left.indices, ...right.indices],
        observations: [...left.observations, ...right.observations],
        fixed: left.fixed && right.fixed
      };
      blocks.splice(i, 1);
      i -= 1;
    }
  }

  const output = new Array(observations.length);
  for (const block of blocks) {
    const value = block.fixed ? fixed[block.indices[0]] : median(block.observations.map((item) => item.value));
    for (const index of block.indices) output[index] = value;
  }
  return output;
}

function feasibleCore(edges, eventCount) {
  const distances = new Array(eventCount).fill(0);
  for (let pass = 0; pass < eventCount; pass += 1) {
    let changed = false;
    for (const edge of edges) {
      if (distances[edge.to] < distances[edge.from] + edge.delta) {
        distances[edge.to] = distances[edge.from] + edge.delta;
        changed = true;
      }
    }
    if (!changed) return null;
  }

  const involved = new Set();
  for (const edge of edges) {
    if (distances[edge.to] < distances[edge.from] + edge.delta) involved.add(edge.id);
  }
  let previousSize = 0;
  while (involved.size !== previousSize) {
    previousSize = involved.size;
    for (const edge of edges) {
      if (!involved.has(edge.id)) continue;
      for (const candidate of edges) {
        if (involved.has(candidate.id)) continue;
        if (candidate.to === edge.from || candidate.from === edge.to) involved.add(candidate.id);
      }
    }
  }
  return edges.filter((edge) => involved.has(edge.id));
}

function extractPositiveCycle(edges, eventCount) {
  let cycle = feasibleCore(edges, eventCount);
  if (!cycle) return null;
  let changed = true;
  while (changed) {
    changed = false;
    for (let index = 0; index < cycle.length; index += 1) {
      const candidate = cycle[index];
      const reduced = cycle.filter((edge) => edge.id !== candidate.id);
      if (feasibleCore(reduced, eventCount)) {
        cycle = reduced;
        changed = true;
        break;
      }
    }
  }
  return cycle;
}

function projectChainWithFixed(observations, edges, fixed) {
  const deltas = new Array(observations.length - 1).fill(-Infinity);
  for (const edge of edges) {
    if (edge.to === edge.from + 1) deltas[edge.from] = Math.max(deltas[edge.from], edge.delta);
  }
  const prefixDeltas = observations.map((_, index) => {
    let prefix = 0;
    for (let cursor = 1; cursor <= index; cursor += 1) prefix += deltas[cursor - 1];
    return prefix;
  });
  const transformed = observations.map((item, index) => ({
    index,
    value: (fixed[index] === undefined ? item.value : fixed[index]) - prefixDeltas[index]
  }));
  let blocks = transformed.map((item) => ({
    indices: [item.index],
    values: [item.value],
    fixed: fixed[item.index] !== undefined
  }));

  for (let i = 0; i < blocks.length; i += 1) {
    while (i > 0) {
      const left = blocks[i - 1];
      const right = blocks[i];
      const leftValue = left.fixed ? left.values[0] : median(left.values);
      const rightValue = right.fixed ? right.values[0] : median(right.values);
      if (leftValue <= rightValue) break;
      blocks[i - 1] = {
        indices: [...left.indices, ...right.indices],
        values: [...left.values, ...right.values],
        fixed: left.fixed && right.fixed
      };
      blocks.splice(i, 1);
      i -= 1;
    }
  }

  const common = new Array(observations.length);
  for (const block of blocks) {
    const value = block.fixed ? block.values[0] : median(block.values);
    for (const index of block.indices) common[index] = value;
  }
  return observations.map((item, index) => common[index] + prefixDeltas[index]);
}
export function buildConstraints(cues, request = {}) {
  const rules = { ...DEFAULT_RULES, ...(request.rules || {}) };
  const anchors = new Map((request.anchors || []).map((anchor) => [`${anchor.cueId}:${anchor.edge || 'start'}`, anchor]));
  const stretchIds = new Set((request.stretchCueIds || []).map((id) => String(id)));
  const events = [
    { cueId: '__timeline__', edge: 'start', index: 0, virtual: true },
    ...cues.map((cue) => ({ cueId: cue.id, edge: 'start', index: cue.index + 1 }))
  ];
  const edges = [];
  let edgeId = 0;
  const addEdge = (from, to, delta, constraint) => {
    edges.push({ id: `e${edgeId++}`, from, to, delta: Math.ceil(delta), ...constraint });
  };
  const fixed = {};
  fixed[0] = 0;
  const anchorConflicts = [];

  const rigidCpsConflicts = cues
    .filter((cue) => !stretchIds.has(cue.id) && cue.end - cue.start < cueMinimumDurationMs(cue, rules))
    .flatMap((cue) => [
      { code: 'maximum-cps', cueId: cue.id, requiredMs: cueMinimumDurationMs(cue, rules), actualMs: cue.end - cue.start },
      { code: 'exact-duration', cueId: cue.id, requiredMs: cue.end - cue.start }
    ]);
  if (rigidCpsConflicts.length) {
    return { events, edges: [], fixed, anchors, stretchIds, rules, rigidCpsConflicts };
  }

  if (cues.length) {
    addEdge(0, eventIndex(events, cues[0].id, 'start'), 0, {
      code: 'non-negative-start',
      cueId: cues[0].id,
      requiredMs: 0
    });
  }
  for (let index = 1; index < cues.length; index += 1) {
    const previous = cues[index - 1];
    const current = cues[index];
    addEdge(eventIndex(events, previous.id, 'start'), eventIndex(events, current.id, 'start'),
      (previous.end - previous.start) + rules.minimumGapMs, {
      code: 'minimum-gap',
      cueId: current.id,
      previousCueId: previous.id,
      requiredMs: rules.minimumGapMs
    });
    const previousSpoken = extractSpeaker(previous.text);
    const currentSpoken = extractSpeaker(current.text);
    if (
      rules.preserveSpeakerRuns &&
      previousSpoken.speaker &&
      currentSpoken.speaker &&
      previousSpoken.speaker !== currentSpoken.speaker
    ) {
      addEdge(eventIndex(events, previous.id, 'start'), eventIndex(events, current.id, 'start'),
        (previous.end - previous.start) + rules.speakerGapMs, {
        code: 'speaker-change-gap',
        cueId: current.id,
        previousCueId: previous.id,
        requiredMs: rules.speakerGapMs
      });
    }
  }

  for (const [key, anchor] of anchors) {
    const index = eventIndex(events, anchor.cueId, 'start');
    const cue = cues.find((item) => item.id === anchor.cueId);
    const blockStart = anchor.edge === 'end' ? anchor.timeMs - (cue.end - cue.start) : anchor.timeMs;
    if (fixed[index] !== undefined && fixed[index] !== blockStart) {
      anchorConflicts.push(
        { code: 'anchor', cueId: anchor.cueId, edge: anchor.edge || 'start', requiredMs: anchor.timeMs },
        { code: 'anchor', cueId: anchor.cueId, edge: 'start', requiredMs: fixed[index] }
      );
    }
    fixed[index] = blockStart;
    addEdge(index, index, 0, {
      code: 'anchor',
      cueId: anchor.cueId,
      edge: anchor.edge || 'start',
      requiredMs: anchor.timeMs
    });
  }
  return { events, edges, fixed, anchors, stretchIds, rules, anchorConflicts };
}

export function solveTimeline(cues, request = {}) {
  const model = buildConstraints(cues, request);
  if (model.anchorConflicts?.length) {
    return {
      feasible: false,
      status: 'infeasible',
      conflictSet: model.anchorConflicts,
      diagnostics: diagnose(cues, model.rules),
      movements: []
    };
  }
  if (model.rigidCpsConflicts?.length) {
    return {
      feasible: false,
      status: 'infeasible',
      conflictSet: model.rigidCpsConflicts,
      diagnostics: diagnose(cues, model.rules),
      movements: []
    };
  }
  const fixedViolations = model.edges.filter((edge) =>
    model.fixed[edge.from] !== undefined &&
    model.fixed[edge.to] !== undefined &&
    model.fixed[edge.to] < model.fixed[edge.from] + edge.delta
  );
  const fixedIndices = Object.keys(model.fixed).map(Number).sort((a, b) => a - b);
  for (let position = 1; position < fixedIndices.length; position += 1) {
    const from = fixedIndices[position - 1];
    const to = fixedIndices[position];
    const pathEdges = model.edges.filter((edge) => edge.from >= from && edge.to <= to && edge.to === edge.from + 1);
    const required = model.fixed[from] + pathEdges.reduce((sum, edge) => sum + edge.delta, 0);
    if (model.fixed[to] < required) {
      fixedViolations.push(
        ...pathEdges.map(({ id, ...edge }) => edge),
        { code: 'anchor', cueId: model.events[to]?.cueId, edge: 'start', requiredMs: model.fixed[to] }
      );
    }
  }
  if (fixedViolations.length) {
    return {
      feasible: false,
      status: 'infeasible',
      conflictSet: fixedViolations.map(({ id, ...edge }) => edge),
      diagnostics: diagnose(cues, model.rules),
      movements: []
    };
  }
  const eventCount = model.events.length;
  const conflictCore = extractPositiveCycle(model.edges, eventCount);
  if (conflictCore) {
    return {
      feasible: false,
      status: 'infeasible',
      conflictSet: conflictCore.map(({ id, ...edge }) => edge),
      diagnostics: diagnose(cues, model.rules),
      movements: []
    };
  }

  const observations = model.events.map((event, index) => ({
    index,
    value: model.fixed[index] ?? (event.virtual ? 0 : eventValue(cues, event.cueId, event.edge)),
    weight: 1
  }));
  const values = projectChainWithFixed(observations, model.edges, model.fixed);
  const byId = new Map(cues.map((cue) => [cue.id, { ...cue }]));
  const movements = [];

  for (const event of model.events) {
    if (event.virtual) continue;
    const value = values[event.index];
    const cue = byId.get(event.cueId);
    const original = cues.find((item) => item.id === event.cueId);
    cue.start = value;
    cue.end = value + (model.stretchIds.has(cue.id)
      ? Math.max(original.end - original.start, cueMinimumDurationMs(original, model.rules))
      : original.end - original.start);
  }
  for (const cue of byId.values()) {
    const original = cues.find((item) => item.id === cue.id);
    movements.push({
      cueId: cue.id,
      startDelta: cue.start - original.start,
      endDelta: cue.end - original.end,
      stretch: model.stretchIds.has(cue.id),
      movement: Math.abs(cue.start - original.start) + Math.abs(cue.end - original.end)
    });
  }

  const solutionCues = cues.map((cue) => byId.get(cue.id));
  return {
    feasible: true,
    status: 'solved',
    cues: solutionCues,
    movements,
    totalMovement: movements.reduce((sum, item) => sum + item.movement, 0),
    diagnostics: diagnose(solutionCues, model.rules),
    stretchCueIds: [...model.stretchIds],
    anchors: request.anchors || []
  };
}
