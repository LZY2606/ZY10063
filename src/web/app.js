const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];

const state = { project: null, lastLoss: null, lastExport: '' };

function fmt(ms) {
  const seconds = Math.floor(ms / 1000);
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const secs = seconds % 60;
  return [hours, minutes, secs].map((value) => String(value).padStart(2, '0')).join(':') + '.' + String(ms % 1000).padStart(3, '0');
}

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"]/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[char]));
}

async function api(path, options = {}) {
  const response = await fetch(path, {
    method: options.method || 'GET',
    headers: { 'content-type': 'application/json' },
    body: options.body ? JSON.stringify(options.body) : undefined
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw Object.assign(new Error(payload.error || 'Request failed'), { payload, status: response.status });
  return payload;
}

function parseList(value) {
  return value.split(',').map((item) => item.trim()).filter(Boolean);
}

function selectedCandidateIds() {
  return { candidateIdA: $('#candidateA').value, candidateIdB: $('#candidateB').value };
}

function cueDiagnostics(cueId) {
  return (state.project.diagnostics || []).filter((item) => item.cueId === cueId || item.previousCueId === cueId);
}

function renderCue(cue, options = {}) {
  const diagnostics = options.diagnostics || cueDiagnostics(cue.id);
  const badClass = diagnostics.length ? 'bad' : 'good';
  const badges = diagnostics.map((item) => `<span class="badge ${item.severity}">${escapeHtml(item.code)}</span>`).join('');
  const movement = options.movement ? `<div>Δ ${options.movement.startDelta} → ${options.movement.endDelta} ms</div>` : '';
  return `<article class="cue ${badClass}">
    <div><div class="cue-id">${escapeHtml(cue.id)}</div><div>#${cue.sourceSequence}</div>${movement}</div>
    <div class="time">${fmt(cue.start)}<br>${fmt(cue.end)}<br>${cue.end - cue.start} ms</div>
    <div><div class="text">${escapeHtml(cue.text)}</div>${badges}</div>
    <details><summary>raw</summary><pre class="raw">${escapeHtml(cue.rawBlock)}</pre></details>
  </article>`;
}

function renderOriginal() {
  if (!state.project) return;
  $('#version').textContent = state.project.version;
  $('#breakpointCount').textContent = state.project.source.breakpoints.length;
  $('#diagnosticCount').textContent = state.project.diagnostics.length;
  $('#breakpoints').innerHTML = state.project.source.breakpoints.map((point) => {
    const reasonText = point.reasons.map((reason) => `${reason.type}(${reason.ms ?? reason.fps ?? ''})`).join(', ');
    return `<div class="badge warning">${escapeHtml(point.afterCueId)} → ${escapeHtml(point.beforeCueId)}: ${escapeHtml(reasonText)}</div>`;
  }).join('');
  $('#originalRows').innerHTML = state.project.timeline.cues.map((cue) => renderCue(cue)).join('');
}

function renderCandidates() {
  if (!state.project) return;
  const candidates = Object.values(state.project.candidates);
  $('#candidateList').innerHTML = candidates.map((candidate) => {
    const movements = new Map(candidate.movements?.map((item) => [item.cueId, item]) || []);
    const rows = candidate.cues.map((cue) => renderCue(cue, { movement: movements.get(cue.id), diagnostics: [] })).join('');
    const totalMovement = candidate.diff?.totalMovement ?? '—';
    return `<article class="candidate-card">
      <div class="candidate-head">
        <div><strong>${escapeHtml(candidate.name)}</strong> <span class="badge ${candidate.status === 'active' ? 'ok' : 'warning'}">${candidate.status}</span></div>
        <div>v${candidate.version} · movement ${totalMovement} ms</div>
      </div>
      <p>base: ${escapeHtml(candidate.baseCandidateId || 'original')}; stretch: ${escapeHtml((candidate.stretchCueIds || []).join(', ') || 'none')}; locked: ${escapeHtml((candidate.lockedCueIds || []).join(', ') || 'none')}</p>
      <button class="small" data-lock="${candidate.id}">更新锁定 cue</button>
      <div class="cue-list">${rows}</div>
    </article>`;
  }).join('');
  const selectOptions = '<option value="">原时间轴</option>' + candidates.map((candidate) => `<option value="${candidate.id}">${escapeHtml(candidate.name)} (${candidate.status})</option>`).join('');
  for (const id of ['solveBase', 'candidateA', 'candidateB', 'exportCandidate']) $('#' + id).innerHTML = selectOptions;
}

function renderDiff() {
  if (!state.project) return;
  const candidates = Object.values(state.project.candidates);
  $('#diffTracks').innerHTML = candidates.map((candidate) => {
    const tracks = candidate.diff?.tracks || [];
    return `<article class="candidate-card"><h3>${escapeHtml(candidate.name)}</h3>${tracks.map((track) => {
      const changes = track.changes.map((change) => typeof change === 'string' ? change : `${change.field}: ${change.base ?? '∅'} → ${change.target ?? '∅'}`).join('; ');
      return `<div class="diff-track ${track.status}"><strong>${escapeHtml(track.cueId)}</strong><span>${track.status}</span><span>${escapeHtml(changes)}</span></div>`;
    }).join('') || '<p>无差异</p>'}</article>`;
  }).join('');
}

function renderThreeWay() {
  const merged = Object.values(state.project?.candidates || {}).filter((candidate) => candidate.origin === 'merge');
  $('#threeWayRows').innerHTML = merged.flatMap((candidate) => (candidate.conflicts || []).map((conflict) => {
    const column = (label, cue) => `<div><h3>${label}</h3>${cue ? `<div class="cue-id">${escapeHtml(cue.id)}</div><div class="time">${fmt(cue.start)} → ${fmt(cue.end)}</div><pre>${escapeHtml(cue.text)}</pre>` : '<p>删除</p>'}</div>`;
    return `<article><h3>${escapeHtml(conflict.kind)} · ${escapeHtml(conflict.cueId)} · ${escapeHtml((conflict.fields || []).join(', '))}</h3><div class="three-way">${column('Base', conflict.base)}${column('同事 A', conflict.a)}${column('同事 B', conflict.b)}</div></article>`;
  })).join('') || '<p>暂无冲突；非冲突字段会在服务端自动合入。</p>';
}

function renderConflictNotice(payload) {
  if (payload?.status === 409) {
    $('#conflictNotice').hidden = false;
    $('#conflictNotice').textContent = '落后版本，拒绝静默覆盖。请刷新页面后基于 v' + payload.actualVersion + '重试；服务端返回了当前项目差异。';
  } else if (payload?.status === 422) {
    $('#conflictNotice').hidden = false;
    const set = (payload.conflictSet || []).map((edge) => `${edge.code}: ${edge.previousCueId || ''}→${edge.cueId} (${edge.requiredMs}ms)`).join('\n');
    $('#conflictNotice').textContent = '无可行解。最小冲突集合（不自动忽略约束）：\n' + set;
  } else {
    $('#conflictNotice').hidden = true;
  }
}

async function refresh() {
  if (!state.project) return;
  state.project = await api('/api/projects/' + state.project.id);
  renderOriginal();
  renderCandidates();
  renderDiff();
  renderThreeWay();
}

$('#sampleBtn').addEventListener('click', () => {
  $('#importText').value = `WEBVTT
NOTE fps=24

1
00:00:00.000 --> 00:00:01.800
<v Aoi>第一段台词，这里故意非常长长长长长长长长长长长长长长长长

2
00:00:01.720 --> 00:00:03.200
<v Sora>第二个人立刻接话，造成说话人切换间隔不足

3
00:00:03.000 --> 00:00:04.200
<v Sora>第三个 cue 与前一个倒序重叠
`;
});

$('#importBtn').addEventListener('click', async () => {
  try {
    state.project = await api('/api/projects', {
      method: 'POST',
      body: {
        title: $('#title').value,
        content: $('#importText').value,
        format: $('#format').value,
        fps: $('#fps').value,
        requestId: 'import-' + crypto.randomUUID()
      }
    });
    await refresh();
    renderConflictNotice(null);
  } catch (error) {
    renderConflictNotice(error.payload || { status: error.status });
  }
});

$('#solveBtn').addEventListener('click', async () => {
  if (!state.project) return;
  let anchors = [];
  try { anchors = JSON.parse($('#anchors').value || '[]'); }
  catch { anchors = []; }
  try {
    await api('/api/projects/' + state.project.id + '/solve', {
      method: 'POST',
      body: {
        baseCandidateId: $('#solveBase').value || null,
        expectedVersion: state.project.version,
        requestId: 'solve-' + crypto.randomUUID(),
        rules: {
          minimumGapMs: Number($('#gap').value),
          speakerGapMs: Number($('#speakerGap').value),
          maximumCps: Number($('#cps').value),
          preserveSpeakerRuns: $('#speakerRuns').checked
        },
        anchors,
        stretchCueIds: parseList($('#stretchIds').value),
        lockedCueIds: parseList($('#lockedIds').value)
      }
    });
    await refresh();
  } catch (error) {
    renderConflictNotice(error.payload || { status: error.status });
    if (error.status === 422) {
      state.project = { ...state.project, diagnostics: error.payload.diagnostics || [] };
      renderOriginal();
    }
  }
});

$('#mergeBtn').addEventListener('click', async () => {
  const ids = selectedCandidateIds();
  if (!ids.candidateIdA || !ids.candidateIdB) return alert('请选择两个同事的候选方案');
  try {
    await api('/api/projects/' + state.project.id + '/merge', {
      method: 'POST',
      body: { ...ids, expectedVersion: state.project.version, requestId: 'merge-' + crypto.randomUUID() }
    });
    await refresh();
  } catch (error) {
    renderConflictNotice(error.payload);
  }
});

$('#exportBtn').addEventListener('click', async () => {
  const body = {
    candidateId: $('#exportCandidate').value || null,
    targetFormat: $('#exportFormat').value,
    fps: $('#fps').value,
    expectedVersion: state.project.version,
    requestId: 'export-' + crypto.randomUUID()
  };
  const result = await api('/api/projects/' + state.project.id + '/export', { method: 'POST', body });
  state.lastLoss = result.lossReport;
  state.lastExport = result.content;
  $('#lossReport').textContent = JSON.stringify(result.lossReport, null, 2);
  $('#exportContent').textContent = result.content;
  await refresh();
});

document.addEventListener('click', async (event) => {
  const candidateId = event.target.dataset.lock;
  if (!candidateId || !state.project) return;
  const locked = prompt('输入要锁定的 cue IDs（逗号分隔）', state.project.candidates[candidateId].lockedCueIds.join(','));
  if (locked === null) return;
  try {
    await api('/api/projects/' + state.project.id + '/candidates/' + candidateId + '/lock', {
      method: 'POST',
      body: { lockedCueIds: parseList(locked), expectedVersion: state.project.version }
    });
    await refresh();
  } catch (error) {
    renderConflictNotice(error.payload);
  }
});

$$('.tabs button').forEach((button) => {
  button.addEventListener('click', () => {
    $$('.tabs button').forEach((item) => item.classList.remove('active'));
    $$('.tab').forEach((item) => item.classList.remove('active'));
    button.classList.add('active');
    $('#' + button.dataset.tab).classList.add('active');
  });
});

async function init() {
  const health = await api('/api/health');
  $('#health').textContent = '在线 · events v' + health.version;
  const projects = await api('/api/projects');
  if (projects.projects.length) {
    state.project = projects.projects.at(-1);
    await refresh();
  }
}

init().catch((error) => {
  $('#health').textContent = '离线';
  console.error(error);
});
