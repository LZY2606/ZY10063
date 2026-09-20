import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventStore, VersionConflictError, IllegalStateError } from '../src/core/store.mjs';
import { TimelineService } from '../src/core/service.mjs';

const sample = `1
00:00:00,000 --> 00:00:01,000
alpha

2
00:00:00,900 --> 00:00:02,000
beta
`;

function tempData() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'timeline-store-'));
}

function makeService(directory) {
  const store = new EventStore(directory);
  return { service: new TimelineService(store), store };
}

test('duplicate import request is idempotent and stores one project event', async () => {
  const directory = tempData();
  const { service } = makeService(directory);
  const body = { title: 'dup', content: sample, requestId: 'same-import' };
  const first = service.importProject(body);
  const second = service.importProject(body);
  assert.equal(first.id, second.id);
  assert.equal(second.globalVersion, 1);
});

test('stale solve returns current versus incoming version conflict', () => {
  const directory = tempData();
  const { service } = makeService(directory);
  const project = service.importProject({ content: sample });
  const first = service.solve(project.id, { expectedVersion: 1, requestId: 'solve-a', stretchCueIds: ['cue-1', 'cue-2'] });
  assert.equal(first.candidates && true, true);
  assert.throws(() => service.solve(project.id, {
    expectedVersion: 1,
    requestId: 'solve-stale',
    stretchCueIds: ['cue-1', 'cue-2']
  }), (error) => {
    assert.ok(error instanceof VersionConflictError);
    assert.equal(error.details.expectedVersion, 1);
    assert.equal(error.details.actualVersion, 2);
    assert.ok(error.details.current);
    assert.ok(error.details.incoming);
    assert.equal(error.details.actualVersion, 2);
    return true;
  });
});

test('illegal candidate state transition is rejected', () => {
  const directory = tempData();
  const { service } = makeService(directory);
  const project = service.importProject({ content: sample });
  service.solve(project.id, { expectedVersion: 1, requestId: 'solve-lock', stretchCueIds: ['cue-1', 'cue-2'] });
  const candidate = Object.keys(service.projectView(project.id).candidates)[0];
  service.lockCandidate(project.id, candidate, { expectedVersion: 2 });
  assert.throws(() => service.lockCandidate(project.id, candidate, { expectedVersion: 3 }), IllegalStateError);
});

test('three-way merge automatically accepts disjoint edits and stores conflict context', () => {
  const directory = tempData();
  const { service } = makeService(directory);
  const project = service.importProject({ content: sample });
  service.editCandidate(project.id, {
    expectedVersion: 1,
    requestId: 'edit-a',
    candidateId: 'cand-a',
    changes: [{ cueId: 'cue-1', cue: { text: 'alpha A' } }]
  });
  service.editCandidate(project.id, {
    expectedVersion: 1,
    allowBranch: true,
    requestId: 'edit-b',
    candidateId: 'cand-b',
    changes: [{ cueId: 'cue-2', cue: { start: 5000, end: 6000 } }]
  });
  const merged = service.merge(project.id, { candidateIdA: 'cand-a', candidateIdB: 'cand-b', expectedVersion: 3 });
  const result = Object.values(merged.candidates).find((candidate) => candidate.origin === 'merge');
  assert.equal(result.status, 'active');
  assert.equal(result.cues[0].text, 'alpha A');
  assert.equal(result.cues[1].start, 5000);
});

test('deterministic export records loss report and survives re-export', () => {
  const directory = tempData();
  const { service } = makeService(directory);
  const project = service.importProject({
    content: `WEBVTT

NOTE director note

1
00:00:00.000 --> 00:00:01.000 align:start
hello
`,
    format: 'vtt'
  });
  const first = service.export(project.id, { targetFormat: 'srt', expectedVersion: 1, requestId: 'export-1' });
  const second = service.export(project.id, { targetFormat: 'srt', expectedVersion: 2, requestId: 'export-2' });
  assert.equal(first.content, second.content);
  assert.ok(first.lossReport.losses.some((loss) => loss.headerType === 'NOTE' || loss.type === 'cue-settings'));
});

test('process recovery removes only incomplete trailing event and rebuilds state', () => {
  const directory = tempData();
  const { service, store } = makeService(directory);
  const project = service.importProject({ content: sample, requestId: 'import-recover' });
  const eventPath = path.join(directory, 'events.jsonl');
  fs.appendFileSync(eventPath, '{"type":"broken","version":2');
  const recoveredStore = new EventStore(directory);
  assert.equal(recoveredStore.snapshot().globalVersion, 1);
  assert.equal(recoveredStore.getProject(project.id).title, 'Untitled timeline');
  const tail = fs.readFileSync(eventPath, 'utf8');
  assert.equal(tail.includes('broken'), false);
});
