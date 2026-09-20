import fs from 'node:fs';
import path from 'node:path';

export class VersionConflictError extends Error {
  constructor(details) {
    super('Version conflict');
    this.name = 'VersionConflictError';
    this.statusCode = 409;
    this.details = details;
  }
}

export class IllegalStateError extends Error {
  constructor(message) {
    super(message);
    this.name = 'IllegalStateError';
    this.statusCode = 409;
  }
}

export class NotFoundError extends Error {
  constructor(message = 'Not found') {
    super(message);
    this.name = 'NotFoundError';
    this.statusCode = 404;
  }
}

function emptyState() {
  return { projects: {}, globalVersion: 0, requestIndex: {} };
}

function applyEvent(state, event) {
  const next = structuredClone(state);
  next.globalVersion = event.version;

  switch (event.type) {
    case 'project-created': {
      next.projects[event.projectId] = {
        id: event.projectId,
        version: event.version,
        createdAt: event.at,
        updatedAt: event.at,
        title: event.payload.title,
        source: event.payload.source,
        timeline: event.payload.timeline,
        rules: event.payload.rules,
        candidates: {},
        merges: [],
        exports: []
      };
      break;
    }
    case 'candidate-created': {
      const project = next.projects[event.projectId];
      project.candidates[event.candidateId] = {
        id: event.candidateId,
        version: event.version,
        createdAt: event.at,
        ...event.payload
      };
      project.version = event.version;
      project.updatedAt = event.at;
      break;
    }
    case 'candidate-updated': {
      const project = next.projects[event.projectId];
      project.candidates[event.candidateId] = {
        ...project.candidates[event.candidateId],
        ...event.payload,
        version: event.version,
        updatedAt: event.at
      };
      project.version = event.version;
      project.updatedAt = event.at;
      break;
    }
    case 'candidate-locked': {
      const project = next.projects[event.projectId];
      const candidate = project.candidates[event.candidateId];
      if (candidate.status !== 'active') throw new IllegalStateError('Candidate ' + event.candidateId + ' is not active');
      candidate.lockedCueIds = event.payload.lockedCueIds;
      candidate.status = 'locked';
      candidate.version = event.version;
      candidate.updatedAt = event.at;
      project.version = event.version;
      project.updatedAt = event.at;
      break;
    }
    case 'candidate-superseded': {
      const project = next.projects[event.projectId];
      const candidate = project.candidates[event.candidateId];
      if (!['active', 'locked', 'conflicted'].includes(candidate.status)) {
        throw new IllegalStateError('Candidate ' + event.candidateId + ' cannot be superseded from ' + candidate.status);
      }
      candidate.status = 'superseded';
      candidate.version = event.version;
      candidate.updatedAt = event.at;
      project.version = event.version;
      project.updatedAt = event.at;
      break;
    }
    case 'candidate-merged': {
      const project = next.projects[event.projectId];
      project.candidates[event.payload.resultCandidateId] = {
        id: event.payload.resultCandidateId,
        version: event.version,
        createdAt: event.at,
        ...event.payload.result
      };
      for (const candidateId of event.payload.consumedCandidateIds) {
        const candidate = project.candidates[candidateId];
        candidate.status = 'merged';
        candidate.version = event.version;
      }
      project.merges.push({
        id: event.payload.mergeId,
        version: event.version,
        at: event.at,
        ...event.payload.record
      });
      project.version = event.version;
      project.updatedAt = event.at;
      break;
    }
    case 'export-recorded': {
      const project = next.projects[event.projectId];
      project.exports.push({ id: event.payload.id, at: event.at, ...event.payload.record });
      project.version = event.version;
      project.updatedAt = event.at;
      break;
    }
    default:
      throw new Error('Unknown event type: ' + event.type);
  }
  return next;
}

export class EventStore {
  constructor(dataDirectory = process.env.TIMELINE_DATA_DIR || path.resolve('data')) {
    this.dataDirectory = dataDirectory;
    this.eventPath = path.join(this.dataDirectory, 'events.jsonl');
    this.requestIndexPath = path.join(this.dataDirectory, 'requests.json');
    fs.mkdirSync(this.dataDirectory, { recursive: true });
    this.state = emptyState();
    this.recover();
  }

  recover() {
    this.state = emptyState();
    if (fs.existsSync(this.requestIndexPath)) {
      try {
        this.state.requestIndex = JSON.parse(fs.readFileSync(this.requestIndexPath, 'utf8'));
      } catch {
        this.state.requestIndex = {};
      }
    }
    if (!fs.existsSync(this.eventPath)) return { recovered: 0, removedBytes: 0 };
    const content = fs.readFileSync(this.eventPath).toString('utf8');
    const lines = content.split('\n');
    const valid = [];
    let removedBytes = 0;
    for (const line of lines) {
      if (line === '') continue;
      try {
        const event = JSON.parse(line);
        this.state = applyEvent(this.state, event);
        valid.push(line);
      } catch {
        removedBytes += Buffer.byteLength(line, 'utf8') + 1;
      }
    }
    if (removedBytes > 0) {
      fs.writeFileSync(this.eventPath, valid.length ? valid.join('\n') + '\n' : '');
    }
    return { recovered: valid.length, removedBytes };
  }

  snapshot() {
    return structuredClone(this.state);
  }

  getProject(projectId) {
    const project = this.state.projects[projectId];
    if (!project) throw new NotFoundError('Project ' + projectId + ' not found');
    return structuredClone(project);
  }

  commit(entry) {
    const type = entry.type;
    const projectId = entry.projectId || null;
    const candidateId = entry.candidateId || null;
    const payload = entry.payload || {};
    const expectedVersion = entry.expectedVersion === undefined ? null : entry.expectedVersion;
    const requestId = entry.requestId || null;

    if (expectedVersion !== null && expectedVersion !== this.state.globalVersion) {
      let currentProject = null;
      try {
        currentProject = projectId ? this.getProject(projectId) : null;
      } catch {
        currentProject = null;
      }
      throw new VersionConflictError({
        expectedVersion,
        actualVersion: this.state.globalVersion,
        project: currentProject
      });
    }
    if (requestId && this.state.requestIndex[requestId]) {
      return structuredClone(this.state.requestIndex[requestId]);
    }

    const event = {
      id: 'evt_' + (this.state.globalVersion + 1),
      type,
      projectId,
      candidateId,
      payload,
      version: this.state.globalVersion + 1,
      at: new Date().toISOString()
    };
    fs.appendFileSync(this.eventPath, JSON.stringify(event) + '\n');
    this.state = applyEvent(this.state, event);
    const result = { event: structuredClone(event), state: this.snapshot() };
    if (requestId) {
      this.state.requestIndex[requestId] = structuredClone(result);
      const temporaryPath = this.requestIndexPath + '.tmp';
      fs.writeFileSync(temporaryPath, JSON.stringify(this.state.requestIndex, null, 2));
      fs.renameSync(temporaryPath, this.requestIndexPath);
    }
    return structuredClone(result);
  }
}
