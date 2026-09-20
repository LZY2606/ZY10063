import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { EventStore, VersionConflictError } from '../core/store.mjs';
import { TimelineService } from '../core/service.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const webRoot = path.resolve(__dirname, '../web');
const mediaTypes = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml'
};

export function createServer(options = {}) {
  const store = new EventStore(options.dataDirectory);
  const service = new TimelineService(store);

  async function readJson(request) {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = Buffer.concat(chunks).toString('utf8');
    if (!body) return {};
    return JSON.parse(body);
  }

  function sendJson(response, statusCode, payload, headers = {}) {
    response.writeHead(statusCode, { 'content-type': 'application/json; charset=utf-8', ...headers });
    response.end(JSON.stringify(payload));
  }

  function sendStatic(response, requestPath) {
    const cleanPath = requestPath === '/' ? '/index.html' : requestPath;
    const resolved = path.normalize(path.join(webRoot, cleanPath));
    if (!resolved.startsWith(webRoot)) {
      response.writeHead(403);
      response.end('Forbidden');
      return;
    }
    fs.readFile(resolved, (error, content) => {
      if (error) {
        fs.readFile(path.join(webRoot, 'index.html'), (fallbackError, fallback) => {
          if (fallbackError) {
            response.writeHead(404);
            response.end('Not found');
          } else {
            response.writeHead(200, { 'content-type': mediaTypes['.html'] });
            response.end(fallback);
          }
        });
        return;
      }
      response.writeHead(200, { 'content-type': mediaTypes[path.extname(resolved)] || 'application/octet-stream' });
      response.end(content);
    });
  }

  const server = http.createServer(async (request, response) => {
    const url = new URL(request.url, 'http://localhost');
    try {
      if (request.method === 'GET' && url.pathname === '/api/health') {
        sendJson(response, 200, { ok: true, version: store.snapshot().globalVersion });
        return;
      }
      if (request.method === 'GET' && url.pathname === '/api/projects') {
        sendJson(response, 200, { projects: service.listProjects() });
        return;
      }
      if (request.method === 'POST' && url.pathname === '/api/projects') {
        sendJson(response, 201, service.importProject(await readJson(request)));
        return;
      }

      const projectMatch = url.pathname.match(/^\/api\/projects\/([^/]+)(?:\/(candidates|solve|merge|export))?\/?$/);
      if (projectMatch) {
        const projectId = decodeURIComponent(projectMatch[1]);
        const action = projectMatch[2];
        if (request.method === 'GET' && !action) {
          sendJson(response, 200, service.projectView(projectId));
          return;
        }
        const body = await readJson(request);
        if (request.method === 'POST' && action === 'solve') {
          const result = service.solve(projectId, body);
          sendJson(response, result.feasible === false ? 422 : 201, result);
          return;
        }
        if (request.method === 'POST' && action === 'merge') {
          sendJson(response, 201, service.merge(projectId, body));
          return;
        }
        if (request.method === 'POST' && action === 'export') {
          sendJson(response, 200, service.export(projectId, body));
          return;
        }
        if (request.method === 'POST' && action === 'candidates') {
          sendJson(response, 201, service.editCandidate(projectId, body));
          return;
        }
      }

      const lockMatch = url.pathname.match(/^\/api\/projects\/([^/]+)\/candidates\/([^/]+)\/lock\/?$/);
      if (lockMatch && request.method === 'POST') {
        sendJson(response, 200, service.lockCandidate(decodeURIComponent(lockMatch[1]), decodeURIComponent(lockMatch[2]), await readJson(request)));
        return;
      }

      if (url.pathname.startsWith('/api/')) {
        sendJson(response, 404, { error: 'Not found' });
        return;
      }
      sendStatic(response, url.pathname);
    } catch (error) {
      if (error instanceof VersionConflictError) {
        sendJson(response, 409, { error: error.message, ...error.details });
        return;
      }
      if (error.statusCode) {
        sendJson(response, error.statusCode, { error: error.message });
        return;
      }
      sendJson(response, 500, { error: error.message });
    }
  });

  server.store = store;
  server.service = service;
  return server;
}
