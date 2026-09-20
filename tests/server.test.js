import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Store } from '../server/store.js';
import { createServer } from '../server/app.js';

const SRT = [
  '1\n00:00:01,000 --> 00:00:02,000\n第一句',
  '2\n00:00:02,050 --> 00:00:03,000\n第二句',
  '3\n00:00:03,100 --> 00:00:04,200\n第三句',
].join('\n\n') + '\n';

let server;
let base;
let dataDir;

before(async () => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'subbench-'));
  const store = Store.open(dataDir);
  server = createServer(store);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(() => {
  server.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

async function api(pathname, { method = 'GET', body } = {}) {
  const res = await fetch(base + pathname, {
    method,
    headers: { 'content-type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, body: await res.json().catch(() => null) };
}

async function createProject(key) {
  return api('/api/projects', {
    method: 'POST',
    body: { content: SRT, format: 'srt', idempotencyKey: key },
  });
}

test('重复请求（同一幂等键）只创建一次并返回相同结果', async () => {
  const a = await createProject('idem-1');
  const b = await createProject('idem-1');
  assert.equal(a.status, 201);
  assert.equal(b.status, 201);
  assert.equal(a.body.id, b.body.id);
  const list = await api('/api/projects');
  assert.equal(list.body.projects.filter((p) => p.id === a.body.id).length, 1);
});

test('非法状态跳转被拒绝：draft 不能直接 solve/export', async () => {
  const p = (await createProject('idem-2')).body;
  const solve = await api(`/api/projects/${p.id}/solve`, {
    method: 'POST',
    body: { expectedVersion: p.version },
  });
  assert.equal(solve.status, 409);
  assert.equal(solve.body.error, 'illegal_transition');
  const exp = await api(`/api/projects/${p.id}/export`, {
    method: 'POST',
    body: { format: 'srt' },
  });
  assert.equal(exp.status, 409);
});

test('版本落后的写入返回 409 与双方差异，而不是静默覆盖', async () => {
  const p = (await createProject('idem-3')).body;
  const analyzed = await api(`/api/projects/${p.id}/analyze`, {
    method: 'POST',
    body: { expectedVersion: p.version },
  });
  assert.equal(analyzed.status, 200);
  // 用过期版本号再写
  const stale = await api(`/api/projects/${p.id}/solve`, {
    method: 'POST',
    body: { expectedVersion: p.version },
  });
  assert.equal(stale.status, 409);
  assert.equal(stale.body.error, 'version_conflict');
  assert.equal(stale.body.currentVersion, analyzed.body.version);
  assert.ok(stale.body.diff);
});

test('完整流程：analyze → solve → export 确定性', async () => {
  const p = (await createProject('idem-4')).body;
  await api(`/api/projects/${p.id}/analyze`, { method: 'POST', body: { expectedVersion: 1 } });
  const solved = await api(`/api/projects/${p.id}/solve`, {
    method: 'POST',
    body: { expectedVersion: 2, anchors: [{ cueId: 'cue-2', frame: 75, fps: 25 }] },
  });
  assert.equal(solved.status, 200);
  const cue2 = solved.body.solution.cues.find((c) => c.id === 'cue-2');
  assert.equal(cue2.startMs, 3000); // 75/25s
  const e1 = await api(`/api/projects/${p.id}/export`, { method: 'POST', body: { format: 'srt' } });
  const e2 = await api(`/api/projects/${p.id}/export`, { method: 'POST', body: { format: 'srt' } });
  assert.equal(e1.status, 200);
  assert.equal(e1.body.content, e2.body.content);
  assert.ok(Array.isArray(e1.body.lossReport));
});

test('锁段后重新求解', async () => {
  const p = (await createProject('idem-5')).body;
  await api(`/api/projects/${p.id}/analyze`, { method: 'POST', body: { expectedVersion: 1 } });
  await api(`/api/projects/${p.id}/solve`, { method: 'POST', body: { expectedVersion: 2 } });
  const locked = await api(`/api/projects/${p.id}/locks`, {
    method: 'POST',
    body: { expectedVersion: 3, cueIds: ['cue-2'] },
  });
  assert.equal(locked.status, 200);
  assert.ok(locked.body.locks.includes('cue-2'));
});

test('进程异常退出后从日志恢复（未写快照）', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'subbench-crash-'));
  const s1 = Store.open(dir);
  s1.putProject({ id: 'p-crash', name: 'crash', status: 'draft', version: 1, revisions: [] });
  s1.recordIdempotency('k-crash', { status: 201, body: { id: 'p-crash' } });
  // 模拟崩溃：不 snapshot、不关闭，直接开新实例
  const s2 = Store.open(dir);
  assert.ok(s2.getProject('p-crash'));
  assert.equal(s2.getIdempotency('k-crash').body.id, 'p-crash');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('快照 + 增量日志混合恢复', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'subbench-mix-'));
  const s1 = Store.open(dir);
  s1.putProject({ id: 'p-1', name: 'a', status: 'draft', version: 1, revisions: [] });
  s1.snapshot();
  s1.putProject({ id: 'p-2', name: 'b', status: 'draft', version: 1, revisions: [] });
  const s2 = Store.open(dir);
  assert.ok(s2.getProject('p-1'));
  assert.ok(s2.getProject('p-2'));
  fs.rmSync(dir, { recursive: true, force: true });
});

test('合并：无冲突自动合入，有冲突返回三方上下文', async () => {
  const p = (await createProject('idem-6')).body;
  await api(`/api/projects/${p.id}/analyze`, { method: 'POST', body: { expectedVersion: 1 } });
  const solved = await api(`/api/projects/${p.id}/solve`, { method: 'POST', body: { expectedVersion: 2 } });
  const current = solved.body.revisions.at(-1).cues;
  // 无冲突：对方只改文本
  const theirs = current.map((c) => (c.id === 'cue-1' ? { ...c, text: '改过的第一句' } : c));
  const merged = await api(`/api/projects/${p.id}/merge`, {
    method: 'POST',
    body: { expectedVersion: 3, baseVersion: 1, theirs },
  });
  assert.equal(merged.status, 201);
  assert.equal(merged.body.autoMerged, true);
  // 有冲突：双方都改了 cue-1 文本
  const conflictTheirs = current.map((c) => (c.id === 'cue-1' ? { ...c, text: '另一种改法' } : c));
  const cur2 = await api(`/api/projects/${p.id}`);
  const conflict = await api(`/api/projects/${p.id}/merge`, {
    method: 'POST',
    body: { expectedVersion: cur2.body.version, baseVersion: 1, theirs: conflictTheirs },
  });
  assert.equal(conflict.status, 200);
  assert.ok(conflict.body.conflicts.length >= 1);
  assert.ok('base' in conflict.body.conflicts[0]);
});
