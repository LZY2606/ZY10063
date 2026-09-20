// 持久化：快照 + 追加式日志。所有写操作先落日志再应用，
// 进程异常退出后重启可从 snapshot + journal 完整恢复。

import fs from 'node:fs';
import path from 'node:path';

export class Store {
  constructor(dir) {
    this.dir = dir;
    this.state = { projects: {}, idempotency: {} };
    this.journalPath = path.join(dir, 'journal.log');
    this.snapshotPath = path.join(dir, 'snapshot.json');
  }

  static open(dir) {
    fs.mkdirSync(dir, { recursive: true });
    const store = new Store(dir);
    store.load();
    return store;
  }

  load() {
    if (fs.existsSync(this.snapshotPath)) {
      this.state = JSON.parse(fs.readFileSync(this.snapshotPath, 'utf8'));
    }
    if (fs.existsSync(this.journalPath)) {
      const lines = fs.readFileSync(this.journalPath, 'utf8').split('\n').filter(Boolean);
      for (const line of lines) {
        try {
          this.apply(JSON.parse(line));
        } catch {
          // 半行写入（崩溃截断）直接跳过，保证可恢复
        }
      }
    }
  }

  apply(op) {
    switch (op.type) {
      case 'put-project':
        this.state.projects[op.project.id] = op.project;
        break;
      case 'idempotency':
        this.state.idempotency[op.key] = op.record;
        break;
      default:
        throw new Error(`未知操作: ${op.type}`);
    }
  }

  // 同步追加 + fsync，返回时已落盘
  commit(op) {
    const fd = fs.openSync(this.journalPath, 'a');
    try {
      fs.writeSync(fd, JSON.stringify(op) + '\n');
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    this.apply(op);
  }

  putProject(project) {
    this.commit({ type: 'put-project', project });
  }

  recordIdempotency(key, record) {
    this.commit({ type: 'idempotency', key, record });
  }

  getIdempotency(key) {
    return this.state.idempotency[key] ?? null;
  }

  snapshot() {
    const tmp = this.snapshotPath + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(this.state));
    fs.renameSync(tmp, this.snapshotPath);
    fs.writeFileSync(this.journalPath, '');
  }

  getProject(id) {
    return this.state.projects[id] ?? null;
  }

  listProjects() {
    return Object.values(this.state.projects)
      .map((p) => ({ id: p.id, name: p.name, status: p.status, version: p.version, format: p.format }))
      .sort((a, b) => a.id.localeCompare(b.id));
  }
}
