// HTTP API：核心规则只在服务端执行，网页是规则的可见入口。
// - 状态机：draft -> analyzed -> solved -> finalized（非法跳转 409）
// - 并发：所有变更要求 expectedVersion，落后写入返回 409 + 双方差异
// - 幂等：POST 携带 idempotencyKey 时，重复请求返回首次结果

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { parseByFormat } from '../src/core/parse.js';
import { solve, minimizeConflictSet, DEFAULT_PARAMS } from '../src/core/solve.js';
import { analyzeTimeline, diagnoseCues } from '../src/core/diagnose.js';
import { mergeCues } from '../src/core/merge.js';
import { diffCues } from '../src/core/diff.js';
import { exportCues } from '../src/core/export.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WEB_DIR = path.join(__dirname, '..', 'web');

const TRANSITIONS = {
  analyze: ['draft', 'analyzed'],
  solve: ['analyzed', 'solved'],
  lock: ['solved'],
  merge: ['solved'],
  finalize: ['solved'],
  export: ['solved', 'finalized'],
};

class ApiError extends Error {
  constructor(status, payload) {
    super(payload.error ?? 'error');
    this.status = status;
    this.payload = payload;
  }
}

function send(res, status, body) {
  const text = typeof body === 'string' ? body : JSON.stringify(body);
  res.writeHead(status, {
    'content-type': typeof body === 'string' ? 'text/plain; charset=utf-8' : 'application/json; charset=utf-8',
  });
  res.end(text);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (chunk) => {
      data += chunk;
      if (data.length > 20 * 1024 * 1024) reject(new ApiError(413, { error: 'body_too_large' }));
    });
    req.on('end', () => {
      if (!data) return resolve({});
      try {
        resolve(JSON.parse(data));
      } catch {
        reject(new ApiError(400, { error: 'invalid_json' }));
      }
    });
    req.on('error', reject);
  });
}

function currentRevision(project) {
  return project.revisions[project.revisions.length - 1];
}

function revisionAt(project, version) {
  return project.revisions.find((r) => r.version === version) ?? null;
}

function checkTransition(project, action) {
  if (!TRANSITIONS[action].includes(project.status)) {
    throw new ApiError(409, {
      error: 'illegal_transition',
      action,
      status: project.status,
      allowed: TRANSITIONS[action],
    });
  }
}

function checkVersion(project, body) {
  const expected = body.expectedVersion;
  if (expected == null) {
    throw new ApiError(409, { error: 'version_required', currentVersion: project.version });
  }
  if (expected !== project.version) {
    const base = revisionAt(project, expected);
    const diff = base
      ? diffCues(base.cues, currentRevision(project).cues)
      : { added: [], removed: [], changed: [], note: 'expected version 不存在，可能已过期' };
    throw new ApiError(409, {
      error: 'version_conflict',
      currentVersion: project.version,
      expectedVersion: expected,
      diff,
    });
  }
}

function addRevision(project, cues, note) {
  project.version += 1;
  project.revisions.push({ version: project.version, cues, note });
}

function runSolve(project, extra = {}) {
  const anchors = extra.anchors ?? project.anchors;
  const locked = extra.locked ?? project.locks;
  const params = extra.params ?? project.params;
  const opts = { anchors, locked, params };
  const result = solve(currentRevision(project).cues, opts);
  if (result.status === 'infeasible') {
    return {
      status: 'infeasible',
      conflictSet: minimizeConflictSet(currentRevision(project).cues, opts, result.conflicts),
      conflicts: result.conflicts,
    };
  }
  return result;
}

const routes = [];

function route(method, pattern, handler) {
  const keys = [];
  const regex = new RegExp(
    '^' + pattern.replace(/:[^/]+/g, (m) => {
      keys.push(m.slice(1));
      return '([^/]+)';
    }) + '$',
  );
  routes.push({ method, regex, keys, handler });
}

route('GET', '/api/projects', async ({ store }) => {
  return { projects: store.listProjects(), params: DEFAULT_PARAMS };
});

route('POST', '/api/projects', async ({ body, store }) => {
  const { name, content, format, fps } = body;
  if (!content || !format) throw new ApiError(400, { error: 'missing_fields', need: ['content', 'format'] });
  const parsed = parseByFormat(format, content, { fps });
  const id = 'p-' + crypto.randomBytes(4).toString('hex');
  const project = {
    id,
    name: name || id,
    format,
    fps: fps ?? 25,
    status: 'draft',
    version: 1,
    source: { raw: content, meta: parsed.meta },
    revisions: [{ version: 1, cues: parsed.cues, note: 'import（原文解析，未修订）' }],
    anchors: [],
    locks: [],
    params: {},
    solution: null,
    analysis: null,
    exports: [],
    merges: [],
  };
  store.putProject(project);
  return { status: 201, body: project };
});

route('GET', '/api/projects/:id', async ({ params, store }) => {
  const project = store.getProject(params.id);
  if (!project) throw new ApiError(404, { error: 'not_found' });
  return project;
});

route('POST', '/api/projects/:id/analyze', async ({ params, body, store }) => {
  const project = mustGet(store, params.id);
  checkTransition(project, 'analyze');
  checkVersion(project, body);
  const cues = currentRevision(project).cues;
  project.analysis = {
    breaks: analyzeTimeline(cues, project.source.meta),
    issues: diagnoseCues(cues, project.params),
  };
  project.status = 'analyzed';
  addRevision(project, cues, 'analyze');
  store.putProject(project);
  return project;
});

route('POST', '/api/projects/:id/solve', async ({ params, body, store }) => {
  const project = mustGet(store, params.id);
  checkTransition(project, 'solve');
  checkVersion(project, body);
  if (body.anchors) project.anchors = body.anchors;
  if (body.params) project.params = { ...project.params, ...body.params };
  const result = runSolve(project);
  if (result.status === 'infeasible') {
    store.putProject(project);
    throw new ApiError(422, {
      error: 'infeasible',
      conflictSet: result.conflictSet,
      conflicts: result.conflicts,
    });
  }
  project.solution = result;
  project.status = 'solved';
  addRevision(project, result.cues, 'solve');
  store.putProject(project);
  return project;
});

route('POST', '/api/projects/:id/locks', async ({ params, body, store }) => {
  const project = mustGet(store, params.id);
  checkTransition(project, 'lock');
  checkVersion(project, body);
  const cueIds = body.cueIds ?? [];
  project.locks = [...new Set([...project.locks, ...cueIds])];
  const result = runSolve(project);
  if (result.status === 'infeasible') {
    project.locks = project.locks.filter((id) => !cueIds.includes(id));
    store.putProject(project);
    throw new ApiError(422, {
      error: 'infeasible',
      conflictSet: result.conflictSet,
      conflicts: result.conflicts,
    });
  }
  project.solution = result;
  addRevision(project, result.cues, `lock(${cueIds.join(',')}) + re-solve`);
  store.putProject(project);
  return project;
});

route('POST', '/api/projects/:id/merge', async ({ params, body, store }) => {
  const project = mustGet(store, params.id);
  checkTransition(project, 'merge');
  checkVersion(project, body);
  const baseRevision = revisionAt(project, body.baseVersion ?? 1);
  if (!baseRevision) throw new ApiError(400, { error: 'unknown_base_version' });
  if (!Array.isArray(body.theirs)) throw new ApiError(400, { error: 'missing_theirs' });
  const { merged, conflicts } = mergeCues(baseRevision.cues, currentRevision(project).cues, body.theirs);
  project.merges.push({ baseVersion: body.baseVersion ?? 1, conflicts });
  if (conflicts.length === 0) {
    addRevision(project, merged, `merge(base=v${body.baseVersion ?? 1})`);
    project.solution = null;
  }
  store.putProject(project);
  return { status: conflicts.length ? 200 : 201, body: { project, conflicts, autoMerged: conflicts.length === 0 } };
});

route('POST', '/api/projects/:id/finalize', async ({ params, body, store }) => {
  const project = mustGet(store, params.id);
  checkTransition(project, 'finalize');
  checkVersion(project, body);
  project.status = 'finalized';
  store.putProject(project);
  return project;
});

route('POST', '/api/projects/:id/export', async ({ params, body, store }) => {
  const project = mustGet(store, params.id);
  checkTransition(project, 'export');
  const format = body.format ?? project.format;
  const cues = currentRevision(project).cues;
  const { content, loss } = exportCues(cues, format, { fps: body.fps ?? project.fps, meta: project.source.meta });
  const record = { format, lossCount: loss.length, revision: project.version };
  project.exports.push(record);
  store.putProject(project);
  return { content, lossReport: loss, record };
});

route('GET', '/api/projects/:id/diff', async ({ params, query, store }) => {
  const project = mustGet(store, params.id);
  const a = revisionAt(project, Number(query.get('a') ?? 1));
  const b = revisionAt(project, Number(query.get('b') ?? project.version));
  if (!a || !b) throw new ApiError(404, { error: 'revision_not_found' });
  return { a: a.version, b: b.version, diff: diffCues(a.cues, b.cues) };
});

function mustGet(store, id) {
  const project = store.getProject(id);
  if (!project) throw new ApiError(404, { error: 'not_found' });
  return project;
}

const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' };

export function createServer(store, { webDir = WEB_DIR } = {}) {
  return http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    try {
      for (const r of routes) {
        if (r.method !== req.method) continue;
        const m = r.regex.exec(url.pathname);
        if (!m) continue;
        const params = Object.fromEntries(r.keys.map((k, i) => [k, decodeURIComponent(m[i + 1])]));
        const body = req.method === 'POST' ? await readBody(req) : {};
        // 幂等：重复 key 直接回放首个响应
        if (req.method === 'POST' && body.idempotencyKey) {
          const hit = store.getIdempotency(body.idempotencyKey);
          if (hit) {
            send(res, hit.status, hit.body);
            return;
          }
        }
        const result = await r.handler({ params, query: url.searchParams, body, store });
        const status = result?.status && result?.body ? result.status : result ? 200 : 204;
        const payload = result?.status && result?.body ? result.body : result;
        if (req.method === 'POST' && body.idempotencyKey) {
          store.recordIdempotency(body.idempotencyKey, { status, body: payload });
        }
        send(res, status, payload ?? '');
        return;
      }
      // 静态资源
      if (req.method === 'GET') {
        const rel = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
        const file = path.join(webDir, rel);
        if (file.startsWith(webDir) && fs.existsSync(file) && fs.statSync(file).isFile()) {
          res.writeHead(200, { 'content-type': (MIME[path.extname(file)] ?? 'application/octet-stream') + '; charset=utf-8' });
          fs.createReadStream(file).pipe(res);
          return;
        }
      }
      send(res, 404, { error: 'not_found' });
    } catch (err) {
      if (err instanceof ApiError) {
        // 幂等失败也记录，保证重复请求得到相同失败
        send(res, err.status, err.payload);
      } else {
        send(res, 500, { error: 'internal', message: String(err?.message ?? err) });
      }
    }
  });
}
