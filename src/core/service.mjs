import { diffCues, summarizeDiff } from './diff.mjs';
import { randomId } from './ids.mjs';
import { parseSubtitles } from './parser.mjs';
import { diagnose, DEFAULT_RULES, solveTimeline } from './rules.mjs';
import { serializeTimeline } from './serializer.mjs';
import { IllegalStateError, NotFoundError, VersionConflictError } from './store.mjs';
import { threeWayMerge } from './merge.mjs';

function clone(value) {
  return structuredClone(value);
}

function compactCue(cue) {
  return {
    id: cue.id,
    index: cue.index,
    sourceSequence: cue.sourceSequence,
    sourceNumber: cue.sourceNumber,
    identifier: cue.identifier,
    start: cue.start,
    end: cue.end,
    startNs: cue.startNs === cue.start * 1_000_000 ? cue.startNs : null,
    endNs: cue.endNs === cue.end * 1_000_000 ? cue.endNs : null,
    text: cue.text,
    format: cue.format,
    fps: cue.fps,
    fpsExplicit: cue.fpsExplicit,
    vttSettings: cue.vttSettings,
    frameSettings: cue.frameSettings,
    rawBlock: cue.rawBlock
  };
}

function compactCandidate(candidate) {
  return {
    ...candidate,
    cues: candidate.cues.map(compactCue)
  };
}

function candidateBaseCues(project, candidateId) {
  if (!candidateId) return project.timeline.cues;
  const candidate = project.candidates[candidateId];
  if (!candidate) throw new NotFoundError('Candidate ' + candidateId + ' not found');
  if (!['active', 'locked'].includes(candidate.status)) {
    throw new IllegalStateError('Candidate ' + candidateId + ' cannot be used as a solving base while ' + candidate.status);
  }
  return candidate.cues;
}

function assertCandidateBranchVersion(project, body) {
  const requested = body.expectedVersion ?? project.version;
  if (!Object.prototype.hasOwnProperty.call(body, 'expectedVersion')) return;
  const branchRequested = requested !== project.version &&
    (body.baseCandidateId || body.allowBranch === true) &&
    Object.values(project.candidates).some((candidate) => candidate.baseVersion === requested);
  if (requested !== project.version && !branchRequested) {
    throw new VersionConflictError({
      expectedVersion: requested,
      actualVersion: project.version,
      current: this.projectView(project.id),
      incoming: body
    });
  }
}

export class TimelineService {
  constructor(store) {
    this.store = store;
  }

  importProject(body) {
    const parsed = parseSubtitles(body.content || '', { format: body.format, fps: body.fps });
    const projectId = randomId('proj');
    const timeline = {
      ...parsed,
      cues: parsed.cues.map(compactCue)
    };
    const result = this.store.commit({
      type: 'project-created',
      projectId,
      payload: {
        title: body.title || 'Untitled timeline',
        source: clone(timeline),
        timeline,
        rules: { ...DEFAULT_RULES, ...(body.rules || {}) }
      },
      requestId: body.requestId || null
    });
    return this.projectView(result.event.projectId || Object.keys(result.state.projects)[0]);
  }

  projectView(projectId) {
    const project = this.store.getProject(projectId);
    return {
      id: project.id,
      version: project.version,
      globalVersion: this.store.snapshot().globalVersion,
      title: project.title,
      createdAt: project.createdAt,
      updatedAt: project.updatedAt,
      rules: project.rules,
      source: project.source,
      timeline: project.timeline,
      diagnostics: diagnose(project.timeline.cues, project.rules),
      candidates: Object.fromEntries(Object.entries(project.candidates).map(([id, candidate]) => [id, compactCandidate(candidate)])),
      merges: project.merges,
      exports: project.exports
    };
  }

  listProjects() {
    return Object.values(this.store.snapshot().projects).map((project) => ({
      id: project.id,
      version: project.version,
      title: project.title,
      cueCount: project.timeline.cues.length,
      candidateCount: Object.keys(project.candidates).length,
      updatedAt: project.updatedAt
    }));
  }

  conflictSnapshot(projectId, body) {
    const current = this.projectView(projectId);
    const incomingCues = body.cues || (body.baseCandidateId
      ? candidateBaseCues(this.store.getProject(projectId), body.baseCandidateId)
      : current.timeline.cues);
    return {
      expectedVersion: body.expectedVersion,
      actualVersion: current.version,
      current,
      incoming: {
        baseCandidateId: body.baseCandidateId || null,
        anchors: body.anchors || [],
        stretchCueIds: body.stretchCueIds || [],
        lockedCueIds: body.lockedCueIds || [],
        cues: incomingCues
      },
      tracks: diffCues(current.timeline.cues, incomingCues)
    };
  }

  solve(projectId, body) {
    try {
      const project = this.store.getProject(projectId);
      assertCandidateBranchVersion.call(this, project, body);
      const baseCues = candidateBaseCues(project, body.baseCandidateId || null);
      const lockedIds = new Set(body.lockedCueIds || []);
      const anchors = [...(body.anchors || [])];
      for (const cue of baseCues) {
        if (lockedIds.has(cue.id)) {
          anchors.push({ cueId: cue.id, edge: 'start', timeMs: cue.start, locked: true });
          anchors.push({ cueId: cue.id, edge: 'end', timeMs: cue.end, locked: true });
        }
      }
      const result = solveTimeline(baseCues, {
        anchors,
        stretchCueIds: body.stretchCueIds || [],
        rules: { ...project.rules, ...(body.rules || {}) }
      });
      if (!result.feasible) {
        return {
          id: project.id,
          version: project.version,
          feasible: false,
          status: 'infeasible',
          conflictSet: result.conflictSet,
          diagnostics: result.diagnostics
        };
      }

      const candidateId = body.candidateId || randomId('cand');
      const tracks = diffCues(baseCues, result.cues);
      const payload = {
        status: 'active',
        name: body.name || 'Candidate ' + (Object.keys(project.candidates).length + 1),
        baseVersion: project.version,
        baseCandidateId: body.baseCandidateId || null,
        origin: 'solver',
        anchors,
        stretchCueIds: body.stretchCueIds || [],
        lockedCueIds: body.lockedCueIds || [],
        rules: { ...project.rules, ...(body.rules || {}) },
        cues: result.cues.map(compactCue),
        diff: { tracks, summary: summarizeDiff(tracks), totalMovement: result.totalMovement },
        movements: result.movements
      };
      this.store.commit({
        type: 'candidate-created',
        projectId,
        candidateId,
        payload,
        expectedVersion: null,
        requestId: body.requestId || null
      });
      return this.projectView(projectId);
    } catch (error) {
      if (error instanceof VersionConflictError) {
        throw new VersionConflictError(this.conflictSnapshot(projectId, body));
      }
      throw error;
    }
  }

  editCandidate(projectId, body) {
    const project = this.store.getProject(projectId);
    assertCandidateBranchVersion.call(this, project, body);
    const baseCues = candidateBaseCues(project, body.baseCandidateId || null);
    const changes = new Map((body.changes || []).map((change) => [change.cueId, change]));
    const editedCues = baseCues.map((cue) => {
      const change = changes.get(cue.id);
      return change ? { ...cue, ...change.cue } : { ...cue };
    });
    if (body.strictOrder) {
      for (let index = 1; index < editedCues.length; index += 1) {
        if (editedCues[index].start < editedCues[index - 1].end || editedCues[index].end < editedCues[index].start) {
          throw new IllegalStateError('Manual edit creates a negative duration or reversed timeline');
        }
      }
    }
    const tracks = diffCues(baseCues, editedCues);
    const candidateId = body.candidateId || randomId('cand');
    this.store.commit({
      type: 'candidate-created',
      projectId,
      candidateId,
      expectedVersion: null,
      requestId: body.requestId || null,
      payload: {
        status: 'active',
        name: body.name || 'Manual candidate',
        baseVersion: project.version,
        baseCandidateId: body.baseCandidateId || null,
        origin: 'manual',
        anchors: [],
        stretchCueIds: [],
        lockedCueIds: [],
        rules: project.rules,
        cues: editedCues.map(compactCue),
        diff: { tracks, summary: summarizeDiff(tracks), totalMovement: null }
      }
    });
    return this.projectView(projectId);
  }

  lockCandidate(projectId, candidateId, body = {}) {
    const project = this.store.getProject(projectId);
    const candidate = project.candidates[candidateId];
    if (!candidate) throw new NotFoundError('Candidate ' + candidateId + ' not found');
    if (!['active', 'locked'].includes(candidate.status)) {
      throw new IllegalStateError('Candidate ' + candidateId + ' cannot lock from status ' + candidate.status);
    }
    this.store.commit({
      type: 'candidate-locked',
      projectId,
      candidateId,
      expectedVersion: body.expectedVersion ?? project.version,
      requestId: body.requestId || null,
      payload: { lockedCueIds: body.lockedCueIds ?? candidate.lockedCueIds ?? [] }
    });
    return this.projectView(projectId);
  }

  merge(projectId, body) {
    const project = this.store.getProject(projectId);
    const a = project.candidates[body.candidateIdA];
    const b = project.candidates[body.candidateIdB];
    if (!a || !b) throw new NotFoundError('Both merge candidates must exist');
    if ((a.baseCandidateId || null) !== (b.baseCandidateId || null)) {
      throw new IllegalStateError('Candidates do not share a common candidate base');
    }
    const baseCues = candidateBaseCues(project, a.baseCandidateId);
    const merged = threeWayMerge(baseCues, a.cues, b.cues);
    const tracks = diffCues(baseCues, merged.cues);
    const resultCandidateId = randomId('cand');
    const mergeId = randomId('merge');
    this.store.commit({
      type: 'candidate-merged',
      projectId,
      expectedVersion: body.expectedVersion ?? project.version,
      requestId: body.requestId || null,
      payload: {
        mergeId,
        resultCandidateId,
        consumedCandidateIds: [a.id, b.id],
        record: {
          candidateIdA: a.id,
          candidateIdB: b.id,
          status: merged.status,
          conflicts: merged.conflicts,
          autoMerged: merged.autoMerged,
          diffSummary: summarizeDiff(tracks)
        },
        result: {
          status: merged.status === 'merged' ? 'active' : 'conflicted',
          name: body.name || 'Merged candidate',
          baseVersion: project.version,
          baseCandidateId: a.baseCandidateId || b.baseCandidateId || null,
          origin: 'merge',
          anchors: [],
          stretchCueIds: [],
          lockedCueIds: [],
          rules: project.rules,
          cues: merged.cues.map(compactCue),
          conflicts: merged.conflicts,
          autoMerged: merged.autoMerged,
          diff: { tracks, summary: summarizeDiff(tracks), totalMovement: null }
        }
      }
    });
    return this.projectView(projectId);
  }

  export(projectId, body) {
    const project = this.store.getProject(projectId);
    const sourceCues = body.candidateId ? candidateBaseCues(project, body.candidateId) : project.timeline.cues;
    const exported = serializeTimeline(project, sourceCues, body);
    const exportId = randomId('export');
    this.store.commit({
      type: 'export-recorded',
      projectId,
      expectedVersion: body.expectedVersion ?? project.version,
      requestId: body.requestId || null,
      payload: {
        id: exportId,
        record: {
          candidateId: body.candidateId || null,
          targetFormat: body.targetFormat || project.source.format,
          lossReport: exported.lossReport,
          filename: exported.filename
        }
      }
    });
    return { ...exported, id: exportId, version: this.store.getProject(projectId).version };
  }
}
