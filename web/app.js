// 前端只是规则的可见入口：所有计算都调用服务端 API。

const $ = (sel) => document.querySelector(sel);
let project = null;

async function api(path, { method = 'GET', body } = {}) {
  const res = await fetch(path, {
    method,
    headers: { 'content-type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data.error ?? res.statusText);
    err.payload = data;
    err.status = res.status;
    throw err;
  }
  return data;
}

function fmt(ms) {
  const t = Math.round(ms);
  const p = (n, l = 2) => String(n).padStart(l, '0');
  return `${p(Math.floor(t / 3600000))}:${p(Math.floor(t / 60000) % 60)}:${p(Math.floor(t / 1000) % 60)}.${p(t % 1000, 3)}`;
}

function notice(text, kind = 'info') {
  const div = document.createElement('div');
  div.className = `notice ${kind}`;
  div.textContent = text;
  $('#notices').prepend(div);
  setTimeout(() => div.remove(), 12000);
}

function renderTrack(table, cues, { changedIds = new Set(), locked = new Set() } = {}) {
  table.innerHTML =
    '<tr><th>id</th><th>开始</th><th>结束</th><th>说话人</th><th>文本</th></tr>' +
    cues
      .map(
        (c) =>
          `<tr class="${changedIds.has(c.id) ? 'changed' : ''} ${locked.has(c.id) ? 'locked' : ''}">` +
          `<td>${c.id}</td><td>${fmt(c.startMs)}</td><td>${fmt(c.endMs)}</td>` +
          `<td>${c.speaker ?? ''}</td><td>${escapeHtml(c.text ?? '')}</td></tr>`,
      )
      .join('');
}

function escapeHtml(s) {
  return s.replace(/[&<>"]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[ch]));
}

async function refresh() {
  if (!project) return;
  project = await api(`/api/projects/${project.id}`);
  $('#project-meta').textContent = `${project.name} · ${project.status} · v${project.version}`;
  const original = project.revisions[0].cues;
  const current = project.revisions[project.revisions.length - 1].cues;
  const diff = await api(`/api/projects/${project.id}/diff?a=1&b=${project.version}`);
  const changedIds = new Set(diff.diff.changed.map((c) => c.id));
  renderTrack($('#track-original'), original);
  renderTrack($('#track-candidate'), current, { changedIds, locked: new Set(project.locks) });
  $('#track-diff').innerHTML =
    '<tr><th>cue</th><th>字段</th><th>原值</th><th>新值</th></tr>' +
    diff.diff.changed
      .flatMap((c) =>
        Object.entries(c.fields).map(
          ([f, v]) =>
            `<tr class="changed"><td>${c.id}</td><td>${f}</td>` +
            `<td>${typeof v.from === 'number' ? fmt(v.from) : escapeHtml(String(v.from ?? ''))}</td>` +
            `<td>${typeof v.to === 'number' ? fmt(v.to) : escapeHtml(String(v.to ?? ''))}</td></tr>`,
        ),
      )
      .join('');
  $('#anchor-list').innerHTML = project.anchors
    .map((a) => `<li>${a.cueId} → 帧 ${a.frame} @ ${a.fps}fps</li>`)
    .join('');
  $('#lock-list').innerHTML = project.locks.map((id) => `<li>${id}</li>`).join('');
  if (project.analysis) {
    for (const b of project.analysis.breaks) notice(`断点 [${b.type}] ${b.detail ?? ''}`, 'warn');
    for (const i of project.analysis.issues.slice(0, 20)) {
      notice(`诊断 [${i.type}] ${i.cueId} ${i.detail ?? ''}`, 'warn');
    }
  }
  if (project.solution?.diagnostics?.length) {
    for (const d of project.solution.diagnostics) notice(`CPS 超限: ${d.cueId} ${d.cps} > ${d.maxCps}`, 'warn');
  }
  await refreshList();
}

async function refreshList() {
  const { projects } = await api('/api/projects');
  $('#project-list').innerHTML = projects
    .map(
      (p) =>
        `<li data-id="${p.id}" class="${project?.id === p.id ? 'active' : ''}">` +
        `${p.name}<span class="badge">${p.status} v${p.version}</span></li>`,
    )
    .join('');
  document.querySelectorAll('#project-list li').forEach((li) => {
    li.onclick = async () => {
      project = { id: li.dataset.id };
      $('#workspace').hidden = false;
      await refresh();
    };
  });
}

async function mutate(action, body = {}) {
  try {
    const result = await api(`/api/projects/${project.id}/${action}`, {
      method: 'POST',
      body: { expectedVersion: project.version, ...body },
    });
    if (action === 'export') {
      $('#export-content').textContent = result.content;
      $('#loss-report').innerHTML =
        result.lossReport.map((l) => `<li>[${l.kind}] ${l.detail}</li>`).join('') ||
        '<li>无损失</li>';
    } else if (action === 'merge') {
      renderMerge(result);
    }
    notice(`${action} 完成`, 'info');
    await refresh();
  } catch (err) {
    if (err.payload?.error === 'infeasible') {
      notice(`无解，最小冲突集: ${err.payload.conflictSet.join(', ')}`, 'error');
    } else if (err.payload?.error === 'version_conflict') {
      notice(`版本冲突：当前 v${err.payload.currentVersion}，请刷新后重试`, 'error');
      await refresh();
    } else if (err.payload?.error === 'illegal_transition') {
      notice(`非法状态跳转：${err.payload.action} 不允许在 ${err.payload.status} 状态执行`, 'error');
    } else {
      notice(`${action} 失败: ${err.message}`, 'error');
    }
  }
}

function renderMerge(result) {
  const box = $('#merge-result');
  if (!result.conflicts?.length) {
    box.innerHTML = '<div class="notice info">无冲突，已自动合入</div>';
    return;
  }
  box.innerHTML =
    '<h3>三方冲突（base / 我方 / 对方）</h3>' +
    result.conflicts
      .map(
        (c) =>
          `<table><tr class="conflict"><th>${c.cueId} · ${c.field}</th></tr>` +
          `<tr><td>base: ${escapeHtml(JSON.stringify(c.base))}</td></tr>` +
          `<tr><td>我方: ${escapeHtml(JSON.stringify(c.left))}</td></tr>` +
          `<tr><td>对方: ${escapeHtml(JSON.stringify(c.right))}</td></tr></table>`,
      )
      .join('');
}

$('#btn-import').onclick = async () => {
  try {
    project = await api('/api/projects', {
      method: 'POST',
      body: {
        content: $('#import-content').value,
        format: $('#import-format').value,
        fps: Number($('#import-fps').value),
        idempotencyKey: crypto.randomUUID(),
      },
    });
    $('#workspace').hidden = false;
    notice('导入成功，原文已原样保存', 'info');
    await refresh();
  } catch (err) {
    notice(`导入失败: ${err.message}`, 'error');
  }
};

document.querySelectorAll('.toolbar button').forEach((btn) => {
  btn.onclick = () => {
    const action = btn.dataset.action;
    if (action === 'export') {
      mutate('export', { format: $('#export-format').value });
    } else {
      mutate(action);
    }
  };
});

$('#btn-add-anchor').onclick = async () => {
  const anchors = [
    ...project.anchors,
    {
      cueId: $('#anchor-cue').value.trim(),
      frame: Number($('#anchor-frame').value),
      fps: Number($('#anchor-fps').value),
    },
  ];
  await mutate('solve', { anchors });
};

$('#btn-lock').onclick = async () => {
  const cueIds = $('#lock-cues').value.split(',').map((s) => s.trim()).filter(Boolean);
  await mutate('locks', { cueIds });
};

$('#btn-merge').onclick = async () => {
  let theirs;
  try {
    theirs = JSON.parse($('#merge-theirs').value);
  } catch {
    notice('对方方案不是合法 JSON', 'error');
    return;
  }
  await mutate('merge', {
    baseVersion: Number($('#merge-base').value) || 1,
    theirs,
  });
};

refreshList();
