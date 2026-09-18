'use strict';

const path = require('path');
const express = require('express');
const { coordinate, analyze, normalizeChannels, ValidationError } = require('./coordinate');
const db = require('./db');

const app = express();
const PORT = Number(process.env.PORT) || 3000;

app.use(express.json({ limit: '256kb' }));
app.use(express.static(path.join(__dirname, '..', 'public')));

function asyncOr(fn) {
  return (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
}

// 仅分析当前录入（互调枚举），不保存
app.post('/api/analyze', asyncOr((req, res) => {
  const channels = normalizeChannels(req.body && req.body.channels);
  res.json(analyze(channels));
}));

// 自动协调（不保存）
app.post('/api/coordinate', asyncOr((req, res) => {
  const body = req.body || {};
  res.json(coordinate(body.channels, body.options || {}));
}));

// 保存方案
app.post('/api/plans', asyncOr((req, res) => {
  const body = req.body || {};
  const name = typeof body.name === 'string' ? body.name.trim() : '';
  if (!name) throw new ValidationError('方案名称不能为空');
  if (name.length > 100) throw new ValidationError('方案名称不能超过 100 个字符');
  // 重新计算一次，保证存库数据可信
  const result = coordinate(body.channels, body.options || {});
  const plan = db.createPlan({
    name,
    note: typeof body.note === 'string' ? body.note.slice(0, 1000) : '',
    options: {
      bandStart: Number(body.options.bandStart),
      bandEnd: Number(body.options.bandEnd),
      stepKhz: Number(body.options.stepKhz),
      maxShiftKhz: Number(body.options.maxShiftKhz),
    },
    result,
  });
  res.status(201).json(plan);
}));

app.get('/api/plans', asyncOr((req, res) => {
  res.json(db.listPlans());
}));

app.get('/api/plans/:id', asyncOr((req, res) => {
  const plan = db.getPlan(Number(req.params.id));
  if (!plan) return res.status(404).json({ error: '方案不存在' });
  res.json(plan);
}));

app.delete('/api/plans/:id', asyncOr((req, res) => {
  const ok = db.deletePlan(Number(req.params.id));
  if (!ok) return res.status(404).json({ error: '方案不存在' });
  res.status(204).end();
}));

app.use((err, req, res, next) => {
  if (err instanceof ValidationError) {
    return res.status(err.status).json({ error: err.message });
  }
  console.error(err);
  res.status(500).json({ error: '服务器内部错误' });
});

app.listen(PORT, () => {
  db.getDb(); // 启动时初始化数据库
  console.log(`无线麦克风频率协调服务已启动： http://localhost:${PORT}`);
});

module.exports = app;
