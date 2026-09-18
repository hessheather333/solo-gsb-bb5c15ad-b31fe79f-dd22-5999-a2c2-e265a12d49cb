'use strict';

const assert = require('assert');
const { analyze, coordinate } = require('../src/coordinate');

let passed = 0;
function test(name, fn) {
  fn();
  passed++;
  console.log(`  ✓ ${name}`);
}

const ch = (name, f, guard = 100, locked = false) => ({ name, frequencyMHz: f, guardKhz: guard, locked });

/* ---------- 互调枚举 ---------- */

test('三阶互调 |2f1-f2| 落入第三频道保护区时被标出并附来源', () => {
  // 2×100.000 - 100.100 = 99.900 恰好落在「Mic-C」中心
  const r = analyze([ch('Mic-A', 100.0), ch('Mic-B', 100.1), ch('Mic-C', 99.9)]);
  const im3 = r.conflicts.filter((c) => c.type === 'IM3');
  assert.ok(im3.length >= 1, '应至少检出一条 IM3 冲突');
  const hit = im3.find((c) => c.victim.name === 'Mic-C');
  assert.ok(hit, '受害者应为 Mic-C');
  assert.strictEqual(hit.productMHz, 99.9);
  assert.deepStrictEqual(hit.sources.map((s) => s.name).sort(), ['Mic-A', 'Mic-B']);
});

test('二阶差频 |f1-f2| 落入第三频道保护区（镜像频点双向命中）', () => {
  // |21.0 - 10.2| = 10.8 → 命中 C(10.8)；|21.0 - 10.8| = 10.2 → 命中 B(10.2)
  const r = analyze([ch('A', 21.0, 100), ch('B', 10.2, 100), ch('C', 10.8, 100)]);
  const diffs = r.conflicts.filter((c) => c.type === 'IM2_DIFF');
  assert.strictEqual(diffs.length, 2, JSON.stringify(r.conflicts));
  assert.ok(diffs.some((c) => c.victim.name === 'C' && c.productMHz === 10.8));
  assert.ok(diffs.some((c) => c.victim.name === 'B' && c.productMHz === 10.2));
});

test('二阶和频 f1+f2 落入第三频道（镜像频点场景）', () => {
  // 50.0 + 60.0 = 110.0，Mic-C = 110.0
  const r = analyze([ch('A', 50.0, 100), ch('B', 60.0, 100), ch('C', 110.0, 100)]);
  const hit = r.conflicts.find((c) => c.type === 'IM2_SUM' && c.victim.name === 'C');
  assert.ok(hit, '应检出和频 110 MHz 命中 C');
  assert.strictEqual(hit.productMHz, 110.0);
});

test('载波保护带重叠被检出，边界恰好相切也算冲突', () => {
  const r = analyze([ch('A', 100.0, 200), ch('B', 100.2, 200)]); // 保护区各 ±0.1，恰好相切
  assert.ok(r.conflicts.some((c) => c.type === 'CARRIER'));
  const r2 = analyze([ch('A', 100.0, 200), ch('B', 100.201, 200)]); // 0.201 > 0.2 不相切
  assert.ok(!r2.conflicts.some((c) => c.type === 'CARRIER'));
});

test('无冲突时返回空列表（避开等间隔三阶互调陷阱）', () => {
  // 500/507/513：2*507-513=501、2*507-500=514 等均远离各频道 ±50 kHz 保护区
  const r = analyze([ch('A', 500.0, 100), ch('B', 507.0, 100), ch('C', 513.0, 100)]);
  assert.strictEqual(r.hasConflict, false, JSON.stringify(r.conflicts));
});

/* ---------- 自动协调 ---------- */

const opts = (bandStart, bandEnd, stepKhz = 50, maxShiftKhz = 500) => ({ bandStart, bandEnd, stepKhz, maxShiftKhz });

test('已无冲突时协调保持原值', () => {
  const r = coordinate([ch('A', 500.0), ch('B', 507.0), ch('C', 513.0)], opts(499, 514));
  assert.strictEqual(r.solved, true);
  assert.strictEqual(r.totalShiftMHz, 0);
});

test('有冲突时找到无冲突方案，且结果确实零冲突', () => {
  const r = coordinate([ch('A', 500.0), ch('B', 500.05), ch('C', 500.1)], opts(499.5, 500.6, 25, 400));
  assert.strictEqual(r.solved, true, r.reason);
  assert.strictEqual(r.analysis.hasConflict, false);
  assert.ok(r.totalShiftMHz > 0);
  // 步进对齐
  for (const c of r.channels) {
    const m = (c.frequencyMHz - 499.5) / 0.025;
    assert.ok(Math.abs(m - Math.round(m)) < 1e-6);
    assert.ok(Math.abs(c.shiftMHz) <= 0.4 + 1e-6);
  }
});

test('锁定频道不移动', () => {
  const r = coordinate(
    [ch('LOCK', 500.0, 100, true), ch('B', 500.05), ch('C', 500.1)],
    opts(499.5, 500.6, 25, 500)
  );
  assert.strictEqual(r.solved, true, r.reason);
  const lock = r.channels.find((c) => c.name === 'LOCK');
  assert.strictEqual(lock.frequencyMHz, 500.0);
  assert.strictEqual(lock.shiftMHz, 0);
  assert.strictEqual(r.analysis.hasConflict, false);
});

test('锁定频道之间互相冲突时判定无解且保持原值', () => {
  const r = coordinate(
    [ch('L1', 500.0, 400, true), ch('L2', 500.01, 400, true), ch('B', 520.0)],
    opts(499, 521)
  );
  assert.strictEqual(r.solved, false);
  assert.ok(r.fatalConflicts.length > 0);
  assert.strictEqual(r.channels[0].frequencyMHz, 500.0);
  assert.strictEqual(r.channels[1].frequencyMHz, 500.01);
});

test('最大偏移过小导致无解：保持原值并说明原因', () => {
  const r = coordinate([ch('A', 500.0, 400), ch('B', 500.02, 400)], opts(499.9, 500.2, 25, 50));
  assert.strictEqual(r.solved, false);
  assert.ok(/不存在|没有可用频点/.test(r.reason));
  assert.strictEqual(r.channels[0].frequencyMHz, 500.0);
  assert.strictEqual(r.channels[1].frequencyMHz, 500.02);
});

test('频段边界：解必须落在闭区间 [bandStart, bandEnd]', () => {
  const r = coordinate([ch('A', 100.0), ch('B', 100.05)], {
    bandStart: 100.0, bandEnd: 100.3, stepKhz: 100, maxShiftKhz: 300,
  });
  assert.strictEqual(r.solved, true, r.reason);
  for (const c of r.channels) {
    assert.ok(c.frequencyMHz >= 100.0 - 1e-9 && c.frequencyMHz <= 100.3 + 1e-9);
  }
});

/* ---------- 与暴力枚举对拍：最优性 + 同分字典序 ---------- */

function bruteForce(rawChannels, o) {
  const norm = require('../src/coordinate').normalizeChannels(rawChannels);
  const grid = [];
  const mMax = Math.floor((o.bandEnd - o.bandStart) / (o.stepKhz / 1000) + 1e-6);
  for (let m = 0; m <= mMax; m++) {
    grid.push(Math.round((o.bandStart + m * (o.stepKhz / 1000)) * 1e6) / 1e6);
  }
  const maxShift = o.maxShiftKhz / 1000;
  const domains = norm.map((c) =>
    c.locked
      ? [c.frequencyMHz]
      : grid.filter((f) => Math.abs(f - c.frequencyMHz) <= maxShift + 1e-7)
  );
  let best = null;
  let bestTotal = Infinity;
  const cur = domains.map(() => 0);
  const rec = (i) => {
    if (i === norm.length) {
      const views = norm.map((c, k) => ({
        index: c.index, name: c.name, frequencyMHz: domains[k][cur[k]], guardMHz: c.guardMHz,
      }));
      if (analyze(views).hasConflict) return;
      let total = 0;
      for (let k = 0; k < norm.length; k++) total += Math.abs(views[k].frequencyMHz - norm[k].frequencyMHz);
      total = Math.round(total / 1e-9) * 1e-9;
      if (best === null || total < bestTotal - 1e-7) {
        bestTotal = total;
        best = views.map((v) => v.frequencyMHz);
      } else if (Math.abs(total - bestTotal) <= 1e-7) {
        for (let k = 0; k < norm.length; k++) {
          if (views[k].frequencyMHz < best[k] - 1e-7) { best = views.map((v) => v.frequencyMHz); break; }
          if (views[k].frequencyMHz > best[k] + 1e-7) break;
        }
      }
      return;
    }
    for (let v = 0; v < domains[i].length; v++) {
      cur[i] = v;
      rec(i + 1);
    }
  };
  rec(0);
  return best;
}

// 固定伪随机，保证可复现
let seed = 42;
const rand = () => {
  seed = (seed * 1103515245 + 12345) & 0x7fffffff;
  return seed / 0x7fffffff;
};

test('随机实例对拍：总偏移最优且同分取字典序最低（200 组）', () => {
  for (let t = 0; t < 200; t++) {
    const n = 2 + Math.floor(rand() * 3); // 2~4 台，暴力可承受
    const base = 500;
    const chans = [];
    for (let i = 0; i < n; i++) {
      const f = base + Math.round(rand() * 20) * 0.025; // 0~500 kHz 内
      chans.push(ch(`CH${i + 1}`, Math.round(f * 1e3) / 1e3, 50 + Math.floor(rand() * 4) * 50, rand() < 0.25));
    }
    const o = { bandStart: 499.7, bandEnd: 500.7, stepKhz: 25, maxShiftKhz: 300 };
    const expected = bruteForce(chans, o);
    const r = coordinate(chans, o);
    if (expected === null) {
      assert.strictEqual(r.solved, false, `实例 ${t} 应无解: ${JSON.stringify(chans)}`);
      continue;
    }
    assert.ok(r.solved, `实例 ${t} 应有解: ${r.reason}`);
    const got = r.channels.map((c) => c.frequencyMHz);
    assert.strictEqual(r.analysis.hasConflict, false, `实例 ${t} 结果仍有冲突`);
    const expTotal = expected.reduce((s, f, k) => s + Math.abs(f - r.channels[k].originalFrequencyMHz), 0);
    assert.ok(
      Math.abs(r.totalShiftMHz - expTotal) <= 1e-6,
      `实例 ${t} 非最优: got ${r.totalShiftMHz} expected ${expTotal}, chans=${JSON.stringify(chans)} got=${got} exp=${expected}`
    );
    for (let k = 0; k < n; k++) {
      assert.ok(Math.abs(got[k] - expected[k]) <= 1e-7,
        `实例 ${t} 同分选择错误: got ${got} expected ${expected}`);
    }
  }
});

test('最多 8 台设备上限校验', () => {
  const many = Array.from({ length: 9 }, (_, i) => ch(`X${i}`, 500 + i));
  assert.throws(() => coordinate(many, opts(499, 510)), /1 ~ 8/);
});

console.log(`\n全部通过：${passed} 项测试`);
