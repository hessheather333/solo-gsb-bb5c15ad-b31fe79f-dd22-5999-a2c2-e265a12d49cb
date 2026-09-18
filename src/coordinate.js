'use strict';

/**
 * 无线麦克风频率协调引擎
 *
 * 互调产物（任取两个不同频道 i、j，f 为载波频率 MHz）：
 *   二阶差频   |f_i - f_j|
 *   二阶和频   f_i + f_j
 *   三阶互调   |2 f_i - f_j|   （i、j 有序，即 2f1-f2 与 2f2-f1 都枚举）
 * 另检查载波相互重叠：|f_i - f_j| <= g_i/2 + g_j/2（g 为保护间隔）。
 *
 * 任一产物落入任一频道保护区 [f_k - g_k/2, f_k + g_k/2] 即判为冲突。
 *
 * 自动协调：在 [bandStart, bandEnd] 频段内、以 step 为步进的频点栅格上，
 * 仅移动未锁定频道（且偏移不超过 maxShift），用 DFS + MRV + 下界剪枝
 * 寻找无冲突方案，优化目标为总偏移 sum|f - f0| 最小；
 * 同分时按录入顺序选择逐频道更低频率（字典序）。
 */

const EPS = 1e-9;             // 数值容差，1e-9 MHz = 0.001 Hz
const CMP_EPS = 1e-7;         // 偏移量比较容差，0.1 Hz
const MAX_N = 8;
const NODE_CAP = 5_000_000;   // 搜索迭代上限
const GRID_CAP = 2_000_001;   // 栅格点数上限，防止频段/步进组合爆炸

const CONFLICT_TYPE = {
  CARRIER: 'CARRIER',
  IM2_DIFF: 'IM2_DIFF',
  IM2_SUM: 'IM2_SUM',
  IM3: 'IM3',
};

const TYPE_LABEL = {
  CARRIER: '载波重叠',
  IM2_DIFF: '二阶差频 |f1-f2|',
  IM2_SUM: '二阶和频 f1+f2',
  IM3: '三阶互调 |2f1-f2|',
};

const TYPE_ORDER = {
  CARRIER: 0,
  IM2_DIFF: 1,
  IM2_SUM: 2,
  IM3: 3,
};

class ValidationError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ValidationError';
    this.status = 400;
  }
}

function round9(x) {
  return Math.round(x / 1e-9) * 1e-9;
}

function round6(x) {
  return Math.round(x * 1e6) / 1e6;
}

/** 校验并归一化频道输入 */
function normalizeChannels(input) {
  if (!Array.isArray(input)) {
    throw new ValidationError('频道列表必须为数组');
  }
  if (input.length < 1 || input.length > MAX_N) {
    throw new ValidationError(`频道数量必须在 1 ~ ${MAX_N} 之间`);
  }
  const names = new Set();
  return input.map((raw, i) => {
    const name = typeof raw.name === 'string' ? raw.name.trim() : '';
    if (!name) {
      throw new ValidationError(`第 ${i + 1} 个频道缺少名称`);
    }
    if (names.has(name)) {
      throw new ValidationError(`频道名称重复：${name}`);
    }
    names.add(name);
    const frequencyMHz = Number(raw.frequencyMHz);
    const guardKhz = raw.guardKhz == null ? null : Number(raw.guardKhz);
    if (!Number.isFinite(frequencyMHz) || frequencyMHz < 10 || frequencyMHz > 3000) {
      throw new ValidationError(`频道「${name}」的频率无效（应在 10 ~ 3000 MHz 之间）`);
    }
    if (!Number.isFinite(guardKhz) || guardKhz <= 0 || guardKhz > 10000) {
      throw new ValidationError(`频道「${name}」的保护间隔无效（应在 0 ~ 10000 kHz 之间）`);
    }
    return {
      index: i,
      name,
      frequencyMHz: round6(frequencyMHz),
      guardKhz: round6(guardKhz),
      guardMHz: round6(guardKhz / 1000),
      locked: Boolean(raw.locked),
    };
  });
}

function normalizeOptions(opts = {}) {
  const bandStart = Number(opts.bandStart);
  const bandEnd = Number(opts.bandEnd);
  const stepKhz = Number(opts.stepKhz);
  const maxShiftKhz = Number(opts.maxShiftKhz);
  if (!Number.isFinite(bandStart) || !Number.isFinite(bandEnd) || bandEnd <= bandStart) {
    throw new ValidationError('频段设置无效，要求 bandEnd > bandStart（MHz）');
  }
  if (!Number.isFinite(stepKhz) || stepKhz <= 0) {
    throw new ValidationError('步进必须为正数（kHz）');
  }
  if (!Number.isFinite(maxShiftKhz) || maxShiftKhz < 0) {
    throw new ValidationError('最大偏移必须为非负数（kHz）');
  }
  return {
    bandStart: round6(bandStart),
    bandEnd: round6(bandEnd),
    stepMHz: round6(stepKhz / 1000),
    maxShiftMHz: round6(maxShiftKhz / 1000),
  };
}

function view(ch, frequencyMHz) {
  return {
    index: ch.index,
    name: ch.name,
    frequencyMHz,
    guardMHz: ch.guardMHz,
    locked: ch.locked,
  };
}

function inZone(product, victim) {
  return product > EPS && Math.abs(product - victim.frequencyMHz) <= victim.guardMHz / 2 + EPS;
}

function makeConflict(type, a, b, product, victim) {
  return {
    type,
    typeLabel: TYPE_LABEL[type],
    productMHz: round6(product),
    sources: [
      { index: a.index, name: a.name, frequencyMHz: round6(a.frequencyMHz) },
      { index: b.index, name: b.name, frequencyMHz: round6(b.frequencyMHz) },
    ].sort((x, y) => x.index - y.index),
    victim: {
      index: victim.index,
      name: victim.name,
      frequencyMHz: round6(victim.frequencyMHz),
      guardKhz: round6(victim.guardMHz * 1000),
      distanceMHz: round6(Math.abs(product - victim.frequencyMHz)),
    },
  };
}

function pushProductConflicts(conflicts, type, a, b, product, victims) {
  for (const v of victims) {
    if (inZone(product, v)) {
      conflicts.push(makeConflict(type, a, b, product, v));
    }
  }
}

/**
 * 枚举给定频道集合的全部互调/载波冲突。
 * 频道对象需含 index/name/frequencyMHz/guardMHz（locked 可选）。
 */
function analyze(rawChannels) {
  const channels = rawChannels.map((c) => ({
    index: c.index,
    name: c.name,
    frequencyMHz: c.frequencyMHz,
    guardMHz: c.guardMHz != null ? c.guardMHz : round6(c.guardKhz / 1000),
    locked: Boolean(c.locked),
  }));
  const n = channels.length;
  const conflicts = [];

  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      const a = channels[i];
      const b = channels[j];

      // 载波相互重叠（对两个频道各自报一条）
      if (Math.abs(a.frequencyMHz - b.frequencyMHz) <= a.guardMHz / 2 + b.guardMHz / 2 + EPS) {
        const [v1, v2] = a.frequencyMHz <= b.frequencyMHz ? [a, b] : [b, a];
        conflicts.push(makeConflict(CONFLICT_TYPE.CARRIER, a, b, v1.frequencyMHz, v1));
        conflicts.push(makeConflict(CONFLICT_TYPE.CARRIER, a, b, v2.frequencyMHz, v2));
      }

      // 二阶差频 / 二阶和频
      pushProductConflicts(conflicts, CONFLICT_TYPE.IM2_DIFF, a, b, Math.abs(a.frequencyMHz - b.frequencyMHz), channels);
      pushProductConflicts(conflicts, CONFLICT_TYPE.IM2_SUM, a, b, a.frequencyMHz + b.frequencyMHz, channels);

      // 三阶互调（有序对）；频率完全相同时退化为载波本身，载波重叠已覆盖
      if (Math.abs(a.frequencyMHz - b.frequencyMHz) > EPS) {
        pushProductConflicts(
          conflicts, CONFLICT_TYPE.IM3, a, b,
          Math.abs(2 * a.frequencyMHz - b.frequencyMHz), channels
        );
        pushProductConflicts(
          conflicts, CONFLICT_TYPE.IM3, b, a,
          Math.abs(2 * b.frequencyMHz - a.frequencyMHz), channels
        );
      }
    }
  }

  conflicts.sort((x, y) => {
    if (x.victim.index !== y.victim.index) return x.victim.index - y.victim.index;
    if (x.productMHz !== y.productMHz) return x.productMHz - y.productMHz;
    if (TYPE_ORDER[x.type] !== TYPE_ORDER[y.type]) return TYPE_ORDER[x.type] - TYPE_ORDER[y.type];
    const sx = x.sources.map((s) => s.index).join(',');
    const sy = y.sources.map((s) => s.index).join(',');
    return sx.localeCompare(sy);
  });

  return {
    channelCount: n,
    conflictCount: conflicts.length,
    hasConflict: conflicts.length > 0,
    conflicts,
  };
}

/**
 * 一对频道产生的互调产物频率（差频/和频/两个方向的三阶互调）。
 * 注意：互调冲突是三通道约束——来源对 (i,j) 的产物可能命中第三个频道 k，
 * 因此协调搜索时不能只做两两一致性检查，必须维护“已分配频道对产物集合”。
 */
function pairProducts(f1, f2) {
  return [
    Math.abs(f1 - f2),
    f1 + f2,
    Math.abs(2 * f1 - f2),
    Math.abs(2 * f2 - f1),
  ].filter((p) => p > EPS);
}

function hitsZone(product, frequencyMHz, guardMHz) {
  return Math.abs(product - frequencyMHz) <= guardMHz / 2 + EPS;
}

function carrierHits(f1, g1, f2, g2) {
  return Math.abs(f1 - f2) <= g1 / 2 + g2 / 2 + EPS;
}

// 内联版本：逐个把 (f1,f2) 的 4 个产物交给回调，避免热路径分配数组
function eachProduct(f1, f2, fn) {
  const d = f1 - f2;
  if (fn(Math.abs(d))) return true;
  if (fn(f1 + f2)) return true;
  const p3 = 2 * f1 - f2;
  if (p3 > EPS && fn(p3)) return true;
  const p4 = 2 * f2 - f1;
  if (p4 > EPS && fn(Math.abs(p4))) return true;
  return false;
}

function productHitsExistingRange(p, views, start, end) {
  for (let i = start; i < end; i++) {
    const v = views[i];
    if (Math.abs(p - v.frequencyMHz) <= v.guardMHz / 2 + EPS) return true;
  }
  return false;
}

/**
 * 判定新增频道（nf / ng）与一组已存在频道（views[0..upto)）是否完全兼容。
 * @param products 已存在频道两两产生的全部产物频率（长度 productLen）
 */
function compatible(views, upto, products, productLen, nIndex, nf, ng) {
  // 1) 载波重叠
  for (let i = 0; i < upto; i++) {
    const e = views[i];
    if (carrierHits(nf, ng, e.frequencyMHz, e.guardMHz)) return false;
  }
  // 2) 历史产物落入新频道保护区
  for (let i = 0; i < productLen; i++) {
    if (hitsZone(products[i], nf, ng)) return false;
  }
  // 3) 新频道与每个旧频道的新对产物，命中新频道或任一旧频道（含来源之外的第三频道）
  for (let i = 0; i < upto; i++) {
    const ef = views[i].frequencyMHz;
    const eg = views[i].guardMHz;
    let bad = false;
    eachProduct(nf, ef, (p) => {
      if (hitsZone(p, nf, ng) || hitsZone(p, ef, eg) || productHitsExistingRange(p, views, 0, upto)) {
        bad = true;
        return true;
      }
      return false;
    });
    if (bad) return false;
  }
  return true;
}

/** 一组频道两两产生的全部产物频率 */
function allPairProducts(views) {
  const products = [];
  for (let i = 0; i < views.length; i++) {
    for (let j = i + 1; j < views.length; j++) {
      for (const p of pairProducts(views[i].frequencyMHz, views[j].frequencyMHz)) {
        products.push(p);
      }
    }
  }
  return products;
}

/** 候选频率与全部锁定频道是否兼容（同时复核锁定频道对的产物） */
function compatibleWithLocked(lockedViews, lockedProducts, ci, fi, gi) {
  return compatible(lockedViews, lockedViews.length, lockedProducts, lockedProducts.length, ci, fi, gi);
}

function resultChannel(ch, frequencyMHz) {
  return {
    index: ch.index,
    name: ch.name,
    originalFrequencyMHz: round6(ch.frequencyMHz),
    frequencyMHz: round6(frequencyMHz),
    guardKhz: round6(ch.guardMHz * 1000),
    locked: ch.locked,
    shiftMHz: round9(frequencyMHz - ch.frequencyMHz),
    shifted: Math.abs(frequencyMHz - ch.frequencyMHz) > CMP_EPS,
  };
}

function resultFromViews(channels, finalViews, extra = {}) {
  const resultChannels = channels.map((c) => {
    const fv = finalViews.find((v) => v.index === c.index);
    return resultChannel(c, fv.frequencyMHz);
  });
  const totalShiftMHz = round9(resultChannels.reduce((s, c) => s + Math.abs(c.shiftMHz), 0));
  return {
    channels: resultChannels,
    totalShiftMHz,
    analysis: analyze(finalViews),
    ...extra,
  };
}

function noSolution(channels, reason, extra) {
  return {
    solved: false,
    optimal: false,
    reason,
    ...resultFromViews(channels, channels.map((c) => view(c, c.frequencyMHz)), extra),
  };
}

/**
 * 自动协调主入口。
 */
function coordinate(rawChannels, rawOpts) {
  const channels = normalizeChannels(rawChannels);
  const opts = normalizeOptions(rawOpts);
  const startedAt = Date.now();
  const stats = (nodes) => ({ nodes, durationMs: Date.now() - startedAt });

  const mMax = Math.floor((opts.bandEnd - opts.bandStart) / opts.stepMHz + 1e-6);
  if (mMax + 1 > GRID_CAP) {
    throw new ValidationError('频段/步进组合导致栅格点数过大（> 200 万），请增大步进或缩小频段');
  }

  const locked = channels.filter((c) => c.locked);
  const unlocked = channels.filter((c) => !c.locked);
  const lockedViews = locked.map((c) => view(c, c.frequencyMHz));

  // 锁定频道之间的冲突不可消除，直接判定无解
  if (locked.length >= 2) {
    const lockAnalysis = analyze(lockedViews);
    if (lockAnalysis.hasConflict) {
      return noSolution(
        channels,
        '锁定频道之间存在不可消除的冲突（互调产物或保护带重叠），请先解锁或手动修改这些频道。',
        { fatalConflicts: lockAnalysis.conflicts, stats: stats(0) }
      );
    }
  }

  // 为每个未锁定频道建立频点域：栅格对齐 + 最大偏移 + 与锁定频道无冲突
  const domains = new Map();
  const lockedProducts = allPairProducts(lockedViews);
  for (const ch of unlocked) {
    const cand = [];
    for (let m = 0; m <= mMax; m++) {
      const f = round6(opts.bandStart + m * opts.stepMHz);
      const shift = Math.abs(f - ch.frequencyMHz);
      if (shift > opts.maxShiftMHz + CMP_EPS) continue;
      if (!compatibleWithLocked(lockedViews, lockedProducts, ch.index, f, ch.guardMHz)) continue;
      cand.push({ frequencyMHz: f, shift: round9(shift) });
    }
    // 偏移小者优先、同偏移频率低者优先——尽早得到高质量可行解以加强剪枝
    cand.sort((a, b) => a.shift - b.shift || a.frequencyMHz - b.frequencyMHz);
    if (cand.length === 0) {
      return noSolution(
        channels,
        `频道「${ch.name}」在 ${opts.bandStart} ~ ${opts.bandEnd} MHz 频段、步进 ${(
          opts.stepMHz * 1000
        ).toFixed(3)} kHz、最大偏移 ${(opts.maxShiftMHz * 1000).toFixed(1)} kHz 内没有可用频点。`,
        { stats: stats(0) }
      );
    }
    domains.set(ch.index, cand);
  }

  // 全部频道已锁定：上面已验证锁定频道间无冲突
  if (unlocked.length === 0) {
    const finalViews = channels.map((c) => view(c, c.frequencyMHz));
    return { solved: true, reason: null, ...resultFromViews(channels, finalViews, { stats: stats(1) }) };
  }

  // DFS + MRV + 下界剪枝。
  // 增量维护全部频道对的互调产物：锁定-锁定（固定）+ 锁定-已分配 + 已分配-已分配。
  // 受害者集合恒为“锁定频道 + 已分配的未锁定频道”，保证三通道约束不遗漏。
  const assignment = new Map(); // index -> frequencyMHz
  const victimViews = lockedViews.map((v) => ({ ...v })); // 压栈时追加已分配频道
  const productList = lockedProducts.slice();
  let best = null;             // Map<index, frequencyMHz>
  let bestTotal = Infinity;
  let nodes = 0;
  let limited = false;

  // 记忆化：已赋值未锁定频道的“频点选择”完全决定未来子树。
  // 键为按录入顺序排列的栅格序号（-1 表示未赋值）。
  const memo = new Set();
  const freqToIndex = new Map();
  for (const ch of unlocked) {
    const m = new Map();
    domains.get(ch.index).forEach((c, k) => m.set(c.frequencyMHz, k));
    freqToIndex.set(ch.index, m);
  }
  function stateKey() {
    let key = '';
    for (const ch of unlocked) {
      const f = assignment.get(ch.index);
      key += (f === undefined ? -1 : freqToIndex.get(ch.index).get(f)) + ',';
    }
    return key;
  }

  function tick() {
    nodes++;
    if (nodes > NODE_CAP) { limited = true; return false; }
    return true;
  }

  // 由当前完整赋值记录一个叶子解（explicit 为剪枝分支构造的假设映射，可为空）
  function recordLeaf(explicit) {
    const byIndex = new Map();
    let total = 0;
    for (const ch of unlocked) {
      const f = explicit ? explicit.get(ch.index) : assignment.get(ch.index);
      byIndex.set(ch.index, f);
      total += Math.abs(f - ch.frequencyMHz);
    }
    total = round9(total);
    if (best === null || total < bestTotal - CMP_EPS) {
      bestTotal = total;
      best = byIndex;
      return;
    }
    if (total <= bestTotal + CMP_EPS) {
      // 同分：按录入顺序（index 升序）选择更低频率（字典序）
      for (const ch of unlocked) {
        const f = byIndex.get(ch.index);
        const bf = best.get(ch.index);
        if (f < bf - CMP_EPS) {
          best = byIndex;
          return;
        }
        if (f > bf + CMP_EPS) return;
      }
    }
  }

  // 下界追平当前最优时，唯一可能打平的路径是每个剩余频道依次取“当前最小偏移的
  // 兼容频点”（MRV 顺序动态选择）。逐条验证，成功则记录该叶子；不改写搜索状态。
  function tryMinRemainLeaf(picked, pickedFreq) {
    const hypViews = victimViews.map((v) => ({ ...v }));
    const hypProducts = productList.slice();
    const hypMap = new Map(assignment);
    const addChannel = (ch, f) => {
      for (let i = 0; i < hypViews.length; i++) {
        eachProduct(f, hypViews[i].frequencyMHz, (p) => { hypProducts.push(p); return false; });
      }
      hypViews.push({ index: ch.index, frequencyMHz: f, guardMHz: ch.guardMHz });
      hypMap.set(ch.index, f);
    };
    addChannel(picked, pickedFreq);
    while (hypMap.size < unlocked.length) {
      let next = null;
      let nextCand = null;
      for (const ch of unlocked) {
        if (hypMap.has(ch.index)) continue;
        let cand = null;
        const list = domains.get(ch.index);
        for (let k = 0; k < list.length; k++) {
          if (compatible(hypViews, hypViews.length, hypProducts, hypProducts.length, ch.index, list[k].frequencyMHz, ch.guardMHz)) {
            cand = list[k];
            break;
          }
        }
        if (!cand) return;
        if (next === null || cand.shift < nextCand.shift) { next = ch; nextCand = cand; }
      }
      addChannel(next, nextCand.frequencyMHz);
    }
    recordLeaf(hypMap);
  }

  function usedShift() {
    let used = 0;
    for (const [idx, f] of assignment) used += Math.abs(f - channels[idx].frequencyMHz);
    return round9(used);
  }

  // 贪心构造初始可行解（MRV 顺序，逐个取偏移最小的兼容频点），为剪枝提供高质量上界
  function greedySeed() {
    const gViews = victimViews.map((v) => ({ ...v }));
    const gProducts = productList.slice();
    const gMap = new Map();
    let total = 0;
    while (gMap.size < unlocked.length) {
      let pick = null;
      let pickCand = null;
      let pickCount = Infinity;
      for (const ch of unlocked) {
        if (gMap.has(ch.index)) continue;
        let cand = null;
        let count = 0;
        const list = domains.get(ch.index);
        for (let k = 0; k < list.length; k++) {
          if (compatible(gViews, gViews.length, gProducts, gProducts.length, ch.index, list[k].frequencyMHz, ch.guardMHz)) {
            count++;
            if (!cand) cand = list[k];
          }
        }
        if (!cand) return; // 贪心失败不影响正确性
        if (count < pickCount || (count === pickCount && cand.shift < pickCand.shift)) {
          pick = ch; pickCand = cand; pickCount = count;
        }
      }
      for (let i = 0; i < gViews.length; i++) {
        eachProduct(pickCand.frequencyMHz, gViews[i].frequencyMHz, (p) => { gProducts.push(p); return false; });
      }
      gViews.push({ index: pick.index, frequencyMHz: pickCand.frequencyMHz, guardMHz: pick.guardMHz });
      gMap.set(pick.index, pickCand.frequencyMHz);
      total += pickCand.shift;
    }
    bestTotal = round9(total);
    best = gMap;
  }

  function dfs() {
    if (nodes > NODE_CAP) { limited = true; return; }
    if (assignment.size === unlocked.length) {
      recordLeaf();
      return;
    }

    const viewLen = victimViews.length;
    const prodLen = productList.length;

    // 记忆化剪枝：相同赋值状态已被访问过时，其全部子树结果已计入 best
    const sKey = stateKey();
    if (memo.has(sKey)) return;

    // MRV + 前向检查（look-ahead）+ 动态下界：
    // 候选压入 scratch（复用 victimViews/productList 末尾，检查后回滚），
    // 验证每个其他未赋值频道仍至少有一个兼容频点；记录各频道可行最小偏移。
    const remain = unlocked.filter((ch) => !assignment.has(ch.index));
    const minFeasibleShift = new Map(); // 频道 index -> 当前可行最小偏移
    let picked = null;
    let pickedFeasible = null;
    for (const ch of remain) {
      const list = domains.get(ch.index);
      const feasible = [];
      for (let k = 0; k < list.length; k++) {
        const c = list[k];
        if (!tick()) return;
        // 压入假设候选（位于 victimViews[viewLen]，新产物从 prodLen 开始）
        victimViews.push({ index: ch.index, frequencyMHz: c.frequencyMHz, guardMHz: ch.guardMHz });
        for (let i = 0; i < viewLen; i++) {
          eachProduct(c.frequencyMHz, victimViews[i].frequencyMHz, (p) => { productList.push(p); return false; });
        }
        if (!compatible(victimViews, viewLen, productList, prodLen, ch.index, c.frequencyMHz, ch.guardMHz)) {
          victimViews.length = viewLen;
          productList.length = prodLen;
          continue;
        }
        let ok = true;
        for (const other of remain) {
          if (other.index === ch.index) continue;
          const olist = domains.get(other.index);
          let hasOne = false;
          for (let ok2 = 0; ok2 < olist.length; ok2++) {
            if (!tick()) { victimViews.length = viewLen; productList.length = prodLen; return; }
            // scratch 当前为“已提交频道 + 假设候选 P”，据此对其他频道 O 做完整兼容检查
            if (compatible(victimViews, viewLen + 1, productList, productList.length, other.index, olist[ok2].frequencyMHz, other.guardMHz)) {
              hasOne = true;
              break;
            }
          }
          if (!hasOne) { ok = false; break; }
        }
        victimViews.length = viewLen;
        productList.length = prodLen;
        if (ok) feasible.push(c);
      }
      if (feasible.length === 0) { memo.add(sKey); return; } // 当前赋值下该变量无可前向满足的候选
      minFeasibleShift.set(ch.index, feasible[0].shift); // 域已按 (shift, freq) 排序
      if (picked === null || feasible.length < pickedFeasible.length) {
        picked = ch;
        pickedFeasible = feasible;
      }
    }

    // 下界剪枝（动态）：已用偏移 + 各剩余频道当前可行最小偏移之和
    const used = usedShift();
    let remainLB = 0;
    for (const [, s] of minFeasibleShift) remainLB += s;
    remainLB = round9(remainLB);
    if (used + remainLB > bestTotal + CMP_EPS) { memo.add(sKey); return; }
    if (used + remainLB > bestTotal - CMP_EPS) {
      // 下界已追平当前最优：只有“逐个频道取当前最小偏移”的唯一路径可能打平
      if (Math.abs(pickedFeasible[0].shift - minFeasibleShift.get(picked.index)) <= CMP_EPS) {
        tryMinRemainLeaf(picked, pickedFeasible[0].frequencyMHz);
      }
      memo.add(sKey);
      return;
    }

    // 扣除 picked 后其余频道的动态下界（用于逐分支剪枝）
    const lbOthers = round9(remainLB - minFeasibleShift.get(picked.index));
    for (const c of pickedFeasible) {
      if (round9(used + c.shift + lbOthers) > bestTotal + CMP_EPS) break; // 候选按 shift 升序，后续更差

      // 压入新频道及其与每个既有频道（含锁定）构成的新产物
      victimViews.push({ index: picked.index, frequencyMHz: c.frequencyMHz, guardMHz: picked.guardMHz });
      for (let i = 0; i < viewLen; i++) {
        eachProduct(c.frequencyMHz, victimViews[i].frequencyMHz, (p) => { productList.push(p); return false; });
      }
      assignment.set(picked.index, c.frequencyMHz);

      dfs();

      // 回滚
      assignment.delete(picked.index);
      productList.length = prodLen;
      victimViews.length = viewLen;
      if (limited) return;
    }
    memo.add(sKey);
  }

  greedySeed();
  dfs();
  const searchStats = stats(nodes);

  if (limited && best === null) {
    return {
      solved: false,
      optimal: false,
      searchLimited: true,
      reason:
        '组合空间过大，搜索在限定计算量（500 万节点）内既未找到无冲突方案、也未能证明无解；所有频道保持原值。请缩小频段、增大步进或减小最大偏移后重试。',
      ...resultFromViews(channels, channels.map((c) => view(c, c.frequencyMHz)), { stats: searchStats }),
    };
  }

  if (best === null) {
    return noSolution(
      channels,
      '在给定频段、步进、最大偏移与锁定条件下不存在无冲突方案；所有频道保持原值。请放宽最大偏移或频段范围、减小保护间隔，或解锁部分频道后重试。',
      { stats: searchStats }
    );
  }

  const finalViews = channels.map((c) => view(c, c.locked ? c.frequencyMHz : best.get(c.index)));
  if (limited) {
    // 找到了经验证零冲突的方案（很可能已非常接近最优），但计算量触顶、未能完成最优性证明
    return {
      solved: true,
      optimal: false,
      searchLimited: true,
      reason:
        `已找到总偏移 ${(round9(bestTotal) * 1000).toFixed(3)} kHz 的无冲突方案，但组合空间过大、搜索在 500 万节点处终止，未完成全局最优性证明。可缩小频段或最大偏移后重试以获得严格最优解。`,
      ...resultFromViews(channels, finalViews, { stats: searchStats }),
    };
  }
  return { solved: true, optimal: true, reason: null, ...resultFromViews(channels, finalViews, { stats: searchStats }) };
}

module.exports = {
  MAX_N,
  CONFLICT_TYPE,
  TYPE_LABEL,
  ValidationError,
  normalizeChannels,
  analyze,
  coordinate,
};
