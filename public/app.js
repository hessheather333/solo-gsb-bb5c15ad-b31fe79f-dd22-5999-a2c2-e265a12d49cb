'use strict';

/* ---------- 状态 ---------- */
const MAX_DEVICES = 8;
let devices = [];
let seq = 0;
let currentResult = null;   // 最近一次协调/分析结果
let analyzeTimer = null;

const TYPE_COLORS = {
  CARRIER: '#e0607a',
  IM2_DIFF: '#e0a13c',
  IM2_SUM: '#58b3d6',
  IM3: '#c264e0',
};

const $ = (id) => document.getElementById(id);

function defaultDevice(i) {
  // 预置一个含等间隔三阶互调陷阱的例子，方便首次体验
  const presets = [
    { name: 'Mic-A', frequencyMHz: 510.0, guardKhz: 100 },
    { name: 'Mic-B', frequencyMHz: 510.2, guardKhz: 100 },
    { name: 'Mic-C', frequencyMHz: 510.4, guardKhz: 100 },
    { name: 'Mic-D', frequencyMHz: 510.6, guardKhz: 100 },
  ];
  const p = presets[i] || { name: `Mic-${String.fromCharCode(65 + i)}`, frequencyMHz: +(510 + i * 0.25).toFixed(3), guardKhz: 100 };
  return { uid: ++seq, name: p.name, frequencyMHz: p.frequencyMHz, guardKhz: p.guardKhz, locked: false };
}

function getOptions() {
  return {
    bandStart: parseFloat($('bandStart').value),
    bandEnd: parseFloat($('bandEnd').value),
    stepKhz: parseFloat($('stepKhz').value),
    maxShiftKhz: parseFloat($('maxShiftKhz').value),
  };
}

function payloadDevices() {
  return devices.map((d) => ({
    name: d.name,
    frequencyMHz: d.frequencyMHz,
    guardKhz: d.guardKhz,
    locked: d.locked,
  }));
}

/* ---------- 设备表 ---------- */
function renderTable() {
  const body = $('deviceBody');
  body.innerHTML = '';
  devices.forEach((d, i) => {
    const tr = document.createElement('tr');
    if (d.locked) tr.classList.add('row-locked');

    const shifted = currentResult && currentResult.channels && currentResult.channels[i];
    // 当前表中显示的频率（协调后采用结果频率）
    const displayFreq = shifted ? shifted.frequencyMHz : d.frequencyMHz;
    if (currentResult && currentResult.analysis && conflictIndexSet(currentResult).has(i)) {
      tr.classList.add('row-conflict');
    }

    tr.innerHTML = `
      <td class="col-idx">${i + 1}</td>
      <td class="col-name"><input data-k="name" type="text" value="${escapeHtml(d.name)}" maxlength="40"></td>
      <td class="col-freq"><input data-k="frequencyMHz" type="number" step="0.001" min="10" max="3000" value="${displayFreq}"></td>
      <td class="col-guard"><input data-k="guardKhz" type="number" step="1" min="1" max="10000" value="${d.guardKhz}"></td>
      <td class="col-lock"><input data-k="locked" type="checkbox" ${d.locked ? 'checked' : ''}></td>
      <td class="col-shift">${shiftHtml(shifted)}</td>
      <td class="col-del"><button class="del-btn" title="删除">✕</button></td>
    `;

    tr.querySelectorAll('input').forEach((inp) => {
      inp.addEventListener('input', () => {
        const k = inp.dataset.k;
        if (k === 'locked') {
          d.locked = inp.checked;
          tr.classList.toggle('row-locked', d.locked);
        } else if (k === 'name') {
          d.name = inp.value;
        } else {
          d[k] = inp.value === '' ? NaN : parseFloat(inp.value);
          // 手动改频率/保护后作废协调结果（偏移列、频谱），但不重建表格以免失焦
          if (currentResult) currentResult = null;
        }
        scheduleAnalyze();
      });
    });
    tr.querySelector('.del-btn').addEventListener('click', () => {
      devices.splice(i, 1);
      currentResult = null;
      renderAll();
      scheduleAnalyze();
    });

    body.appendChild(tr);
  });
  $('deviceCount').textContent = devices.length ? `（${devices.length} / ${MAX_DEVICES}）` : '';
  $('btnAdd').disabled = devices.length >= MAX_DEVICES;
}

function shiftHtml(ch) {
  if (!ch) return '<span class="shift-zero">—</span>';
  const khz = ch.shiftMHz * 1000;
  if (Math.abs(khz) < 0.0005) return '<span class="shift-zero">0 kHz</span>';
  const sign = khz > 0 ? '+' : '';
  const cls = khz > 0 ? 'shift-up' : 'shift-down';
  const arrow = khz > 0 ? '▲' : '▼';
  return `<span class="${cls}">${arrow} ${sign}${khz.toFixed(1)} kHz</span>`;
}

function conflictIndexSet(result) {
  const s = new Set();
  (result.analysis.conflicts || []).forEach((c) => s.add(c.victim.index));
  return s;
}

function refreshRowHighlights() {
  const rows = $('deviceBody').querySelectorAll('tr');
  let conflictIdx = new Set();
  if (currentResult && currentResult.analysis) conflictIdx = conflictIndexSet(currentResult);
  rows.forEach((tr, i) => tr.classList.toggle('row-conflict', conflictIdx.has(i)));
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (m) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[m]));
}

/* ---------- 状态提示 ---------- */
function setStatus(kind, html) {
  const el = $('statusBar');
  el.className = `status ${kind}`;
  el.innerHTML = html;
}
function clearStatus() { $('statusBar').className = 'status hidden'; }

/* ---------- API ---------- */
async function api(path, body) {
  const res = await fetch(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `请求失败 (${res.status})`);
  return data;
}

async function doAnalyze() {
  if (!devices.length) { currentResult = null; renderAll(); clearStatus(); return; }
  if (!validateInputs()) return;
  try {
    const analysis = await api('/api/analyze', { channels: payloadDevices() });
    currentResult = { channels: devices.map((d, i) => ({
      index: i, name: d.name, frequencyMHz: d.frequencyMHz, guardKhz: d.guardKhz, shiftMHz: 0, locked: d.locked,
    })), analysis };
    refreshRowHighlights();
    renderConflicts(analysis);
    drawSpectrum(currentResult);
    const n = analysis.conflictCount;
    if (n === 0) setStatus('ok', '✓ 当前频率方案无互调冲突。');
    else setStatus('err', `⚠ 检出 <b>${n}</b> 个互调/保护冲突，请查看下方明细或执行「自动协调」。`);
  } catch (e) {
    setStatus('err', `分析失败：${escapeHtml(e.message)}`);
  }
}

async function doCoordinate() {
  if (!devices.length) { setStatus('warn', '请先添加至少一台设备。'); return; }
  if (!validateInputs()) return;
  const options = getOptions();
  setStatus('info', '⏳ 正在搜索总偏移最小的无冲突方案…');
  try {
    const result = await api('/api/coordinate', { channels: payloadDevices(), options });
    currentResult = result;
    // 把结果频率写回设备表（作为新的工作频率基线），保留锁定状态
    devices = result.channels.map((c) => ({
      uid: ++seq, name: c.name, frequencyMHz: c.frequencyMHz, guardKhz: c.guardKhz, locked: c.locked,
    }));
    renderAll();
    if (result.solved) {
      const totalKhz = (result.totalShiftMHz * 1000).toFixed(1);
      if (result.optimal) {
        setStatus('ok', `✓ 已找到<b>总偏移最小</b>的无冲突方案：总偏移 <b>${totalKhz} kHz</b>，搜索 ${result.stats.nodes} 节点 / ${result.stats.durationMs} ms。`);
      } else {
        setStatus('warn', `⚠ ${escapeHtml(result.reason || '')}<br>当前方案总偏移 ${totalKhz} kHz，残余冲突 ${result.analysis.conflictCount} 个。`);
      }
    } else {
      setStatus('err', `✗ ${escapeHtml(result.reason || '无解')}`);
    }
  } catch (e) {
    setStatus('err', `协调失败：${escapeHtml(e.message)}`);
  }
}

function validateInputs() {
  const o = getOptions();
  if (!Number.isFinite(o.bandStart) || !Number.isFinite(o.bandEnd) || o.bandEnd <= o.bandStart) {
    setStatus('err', '频段设置无效：终点必须大于起点（MHz）。');
    return false;
  }
  if (!Number.isFinite(o.stepKhz) || o.stepKhz <= 0) {
    setStatus('err', '步进必须为正数（kHz）。');
    return false;
  }
  if (!Number.isFinite(o.maxShiftKhz) || o.maxShiftKhz < 0) {
    setStatus('err', '最大偏移必须为非负数（kHz）。');
    return false;
  }
  for (const d of devices) {
    if (!d.name || !d.name.trim()) { setStatus('err', '存在未命名的设备。'); return false; }
    if (!Number.isFinite(d.frequencyMHz)) { setStatus('err', `设备「${d.name || '?'}」的频率无效。`); return false; }
    if (!Number.isFinite(d.guardKhz) || d.guardKhz <= 0) { setStatus('err', `设备「${d.name}」的保护间隔无效。`); return false; }
  }
  const names = new Set(devices.map((d) => d.name.trim()));
  if (names.size !== devices.length) { setStatus('err', '设备名称不能重复。'); return false; }
  return true;
}

/* ---------- 冲突明细 ---------- */
function renderConflicts(analysis) {
  const box = $('conflictList');
  box.innerHTML = '';
  $('conflictSummary').textContent = analysis.hasConflict ? `— ${analysis.conflictCount} 个冲突` : '— 无冲突';
  if (!analysis.hasConflict) {
    box.innerHTML = '<div class="no-conflict">✓ 所有频道保护区内均未检出 |f1-f2|、f1+f2、|2f1-f2| 互调产物或载波重叠</div>';
    return;
  }
  analysis.conflicts.forEach((c) => {
    const item = document.createElement('div');
    item.className = `conflict-item t-${c.type}`;
    const src = c.sources.map((s) => `${escapeHtml(s.name)}@${s.frequencyMHz.toFixed(3)}`).join(' , ');
    let formula = '';
    const [s1, s2] = [c.sources[0], c.sources[1]];
    if (c.type === 'IM3') {
      // 判断是哪个方向
      if (Math.abs(Math.abs(2 * s1.frequencyMHz - s2.frequencyMHz) - c.productMHz) < 1e-6) {
        formula = `|2×${s1.frequencyMHz.toFixed(3)} − ${s2.frequencyMHz.toFixed(3)}|`;
      } else {
        formula = `|2×${s2.frequencyMHz.toFixed(3)} − ${s1.frequencyMHz.toFixed(3)}|`;
      }
    } else if (c.type === 'IM2_DIFF') {
      formula = `|${s1.frequencyMHz.toFixed(3)} − ${s2.frequencyMHz.toFixed(3)}|`;
    } else if (c.type === 'IM2_SUM') {
      formula = `${s1.frequencyMHz.toFixed(3)} + ${s2.frequencyMHz.toFixed(3)}`;
    } else {
      formula = '载波保护带重叠';
    }
    item.innerHTML = `
      <div class="conflict-head">
        <span class="badge t-${c.type}">${c.typeLabel}</span>
        <span class="conflict-math">${formula} = ${c.productMHz.toFixed(3)} MHz</span>
      </div>
      <div>
        来源频道：<b>${src}</b> → 命中受害者 <b>${escapeHtml(c.victim.name)}</b>
        @${c.victim.frequencyMHz.toFixed(3)} MHz（保护 ±${(c.victim.guardKhz / 2).toFixed(1)} kHz，
        频偏 ${(c.victim.distanceMHz * 1000).toFixed(2)} kHz）
      </div>
    `;
    box.appendChild(item);
  });
}

/* ---------- 频谱绘制 ---------- */
function drawSpectrum(result) {
  const canvas = $('spectrum');
  const ctx = canvas.getContext('2d');
  const W = canvas.width, H = canvas.height;
  ctx.clearRect(0, 0, W, H);
  const legend = $('spectrumLegend');
  legend.innerHTML = '';

  if (!result || !result.channels.length) return;

  const freqs = result.channels.map((c) => c.frequencyMHz);
  const guards = result.channels.map((c) => (c.guardKhz || 0) / 2000); // MHz half-width
  let lo = Math.min(...freqs.map((f, i) => f - guards[i]));
  let hi = Math.max(...freqs.map((f, i) => f + guards[i]));
  const pad = Math.max((hi - lo) * 0.12, 0.05);
  lo -= pad; hi += pad;

  const ml = 54, mr = 18, mt = 18, mb = 38;
  const xOf = (f) => ml + ((f - lo) / (hi - lo)) * (W - ml - mr);
  const baseY = H - mb;

  // 网格与频率刻度
  ctx.strokeStyle = '#2f3b4a';
  ctx.fillStyle = '#8b9bab';
  ctx.font = '11px monospace';
  ctx.textAlign = 'center';
  const ticks = 8;
  for (let t = 0; t <= ticks; t++) {
    const f = lo + ((hi - lo) * t) / ticks;
    const x = xOf(f);
    ctx.beginPath(); ctx.moveTo(x, mt); ctx.lineTo(x, baseY); ctx.stroke();
    ctx.fillText(f.toFixed(2), x, baseY + 18);
  }
  // 基线
  ctx.strokeStyle = '#44525f';
  ctx.beginPath(); ctx.moveTo(ml, baseY); ctx.lineTo(W - mr, baseY); ctx.stroke();

  // 互调产物刻度（冲突的产物画在顶部）
  const prods = (result.analysis && result.analysis.conflicts) || [];
  prods.forEach((c) => {
    const x = xOf(c.productMHz);
    if (x < ml || x > W - mr) return;
    ctx.strokeStyle = TYPE_COLORS[c.type];
    ctx.globalAlpha = 0.75;
    ctx.beginPath();
    ctx.moveTo(x, mt + 4); ctx.lineTo(x, baseY - 4);
    ctx.setLineDash([3, 4]); ctx.stroke(); ctx.setLineDash([]);
    ctx.globalAlpha = 1;
  });

  // 频道：保护带 + 载波线 + 名称
  const laneH = 20;
  result.channels.forEach((ch, i) => {
    const x = xOf(ch.frequencyMHz);
    const half = ((ch.guardKhz || 0) / 2) / 1000;
    const y = mt + 12 + (i % 4) * (laneH + 4);
    const color = ch.locked ? '#b07cf0' : '#4da3ff';
    // 保护区
    ctx.fillStyle = color;
    ctx.globalAlpha = 0.18;
    ctx.fillRect(xOf(ch.frequencyMHz - half), y - 7, Math.max(2, xOf(ch.frequencyMHz + half) - xOf(ch.frequencyMHz - half)), 14);
    ctx.globalAlpha = 1;
    // 载波
    ctx.strokeStyle = color; ctx.lineWidth = 2;
    ctx.beginPath(); ctx.moveTo(x, y - 9); ctx.lineTo(x, y + 9); ctx.stroke();
    ctx.lineWidth = 1;
    // 名称
    ctx.fillStyle = color;
    ctx.font = 'bold 10px monospace';
    ctx.textAlign = 'center';
    ctx.fillText(ch.name, x, y - 12);
  });

  // 图例
  legend.innerHTML =
    `<span><span class="dot" style="background:#4da3ff"></span>未锁定频道</span>` +
    `<span><span class="dot" style="background:#b07cf0"></span>锁定频道</span>` +
    Object.entries(TYPE_COLORS).map(([t, col]) =>
      `<span><span class="dot" style="background:${col}"></span>${({ CARRIER: '载波重叠', IM2_DIFF: '差频', IM2_SUM: '和频', IM3: '三阶互调' })[t]}</span>`
    ).join('');
}

/* ---------- 方案保存 ---------- */
function openSaveModal() {
  if (!devices.length) { setStatus('warn', '没有可保存的设备。'); return; }
  if (!validateInputs()) return;
  $('planName').value = `方案 ${new Date().toLocaleString('zh-CN', { hour12: false })}`;
  $('planNote').value = '';
  $('saveModal').classList.remove('hidden');
  $('planName').focus();
}

async function confirmSave() {
  const name = $('planName').value.trim();
  if (!name) { setStatus('err', '方案名称不能为空。'); return; }
  try {
    const res = await fetch('/api/plans', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name,
        note: $('planNote').value.trim(),
        channels: payloadDevices(),
        options: getOptions(),
      }),
    });
    const result = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(result.error || '保存失败');
    $('saveModal').classList.add('hidden');
    // 用服务端返回的协调结果（plan 的 channels 字段）刷新工作区
    currentResult = null;
    devices = (result.channels || []).map((c) => ({
      uid: ++seq,
      name: c.name,
      frequencyMHz: c.frequencyMHz,
      guardKhz: c.guardKhz,
      locked: c.locked,
    }));
    renderAll();
    setStatus(result.solved
      ? `✓ 方案「${escapeHtml(name)}」已保存，总偏移 ${(result.totalShiftMHz * 1000).toFixed(1)} kHz，残余冲突 0。`
      : `✓ 方案「${escapeHtml(name)}」已保存（无解状态，频率保持原值）。`);
    doAnalyze();
    loadPlans();
  } catch (e) {
    setStatus('err', `保存失败：${escapeHtml(e.message)}`);
  }
}

async function loadPlans() {
  const box = $('planList');
  try {
    const plans = await (await fetch('/api/plans')).json();
    if (!plans.length) {
      box.innerHTML = '<p class="hint">暂无已保存方案。完成一次自动协调后点击「保存方案」。</p>';
      return;
    }
    box.innerHTML = '';
    plans.forEach((p) => {
      const div = document.createElement('div');
      div.className = 'plan-item';
      const freqs = (p.channels || []).map((c) =>
        `${escapeHtml(c.name)}:${c.frequencyMHz.toFixed(3)}${c.locked ? '🔒' : ''}`
      ).join('  ');
      div.innerHTML = `
        <div class="plan-info">
          <div class="plan-name">${escapeHtml(p.name)}
            <span class="tag ${p.solved ? 'tag-solved' : 'tag-failed'}">${p.solved ? '无冲突' : '无解/原值'}</span>
          </div>
          <div class="plan-meta">
            #${p.id} · 频段 ${p.bandStart}–${p.bandEnd} MHz · 步进 ${p.stepKhz} kHz ·
            最大偏移 ${p.maxShiftKhz} kHz · 总偏移 ${(p.totalShiftMHz * 1000).toFixed(1)} kHz · ${p.createdAt}
          </div>
          <div class="plan-freqs">${freqs}</div>
        </div>
        <div class="plan-actions">
          <button class="btn" data-act="load">载入</button>
          <button class="btn btn-danger" data-act="del">删除</button>
        </div>
      `;
      div.querySelector('[data-act="load"]').addEventListener('click', () => loadPlan(p.id));
      div.querySelector('[data-act="del"]').addEventListener('click', () => deletePlan(p.id));
      box.appendChild(div);
    });
  } catch (e) {
    box.innerHTML = `<p class="hint">加载方案失败：${escapeHtml(e.message)}</p>`;
  }
}

async function loadPlan(id) {
  try {
    const p = await (await fetch(`/api/plans/${id}`)).json();
    $('bandStart').value = p.bandStart;
    $('bandEnd').value = p.bandEnd;
    $('stepKhz').value = p.stepKhz;
    $('maxShiftKhz').value = p.maxShiftKhz;
    devices = p.channels.map((c) => ({
      uid: ++seq,
      name: c.name,
      frequencyMHz: c.frequencyMHz,
      guardKhz: c.guardKhz,
      locked: c.locked,
    }));
    currentResult = null;
    renderAll();
    doAnalyze();
    setStatus('info', `已载入方案「${escapeHtml(p.name)}」。`);
    window.scrollTo({ top: 0, behavior: 'smooth' });
  } catch (e) {
    setStatus('err', `载入失败：${escapeHtml(e.message)}`);
  }
}

async function deletePlan(id) {
  if (!confirm('确定删除该方案？此操作不可撤销。')) return;
  const res = await fetch(`/api/plans/${id}`, { method: 'DELETE' });
  if (!res.ok) { setStatus('err', '删除失败。'); return; }
  loadPlans();
}

/* ---------- 渲染与事件 ---------- */
function renderAll() {
  renderTable();
  if (currentResult) {
    renderConflicts(currentResult.analysis);
    drawSpectrum(currentResult);
  } else {
    renderConflicts({ hasConflict: false, conflictCount: 0, conflicts: [] });
    drawSpectrum({ channels: devices.map((d, i) => ({ index: i, name: d.name, frequencyMHz: d.frequencyMHz, guardKhz: d.guardKhz, locked: d.locked })), analysis: { conflicts: [] } });
  }
}

function scheduleAnalyze() {
  clearTimeout(analyzeTimer);
  analyzeTimer = setTimeout(doAnalyze, 250);
}

function init() {
  devices = [0, 1, 2].map(defaultDevice);
  renderAll();
  $('btnAdd').addEventListener('click', () => {
    if (devices.length >= MAX_DEVICES) return;
    devices.push(defaultDevice(devices.length));
    currentResult = null;
    renderAll();
    scheduleAnalyze();
  });
  $('btnAnalyze').addEventListener('click', doAnalyze);
  $('btnCoordinate').addEventListener('click', doCoordinate);
  $('btnSave').addEventListener('click', openSaveModal);
  $('btnCancelSave').addEventListener('click', () => $('saveModal').classList.add('hidden'));
  $('btnConfirmSave').addEventListener('click', confirmSave);
  ['bandStart', 'bandEnd', 'stepKhz', 'maxShiftKhz'].forEach((id) =>
    $(id).addEventListener('input', scheduleAnalyze)
  );
  loadPlans();
  scheduleAnalyze();
}

init();
