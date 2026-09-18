'use strict';

const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
const DB_PATH = process.env.DB_PATH || path.join(DATA_DIR, 'coordinator.db');

let db;

function getDb() {
  if (db) return db;
  fs.mkdirSync(DATA_DIR, { recursive: true });
  db = new Database(DB_PATH);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  migrate(db);
  return db;
}

function migrate(database) {
  database.exec(`
    CREATE TABLE IF NOT EXISTS plans (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      name         TEXT NOT NULL,
      note         TEXT NOT NULL DEFAULT '',
      band_start   REAL NOT NULL,
      band_end     REAL NOT NULL,
      step_khz     REAL NOT NULL,
      max_shift_khz REAL NOT NULL,
      total_shift_mhz REAL NOT NULL DEFAULT 0,
      solved       INTEGER NOT NULL DEFAULT 1,
      created_at   TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS plan_channels (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      plan_id     INTEGER NOT NULL REFERENCES plans(id) ON DELETE CASCADE,
      channel_idx INTEGER NOT NULL,
      name        TEXT NOT NULL,
      original_frequency_mhz REAL NOT NULL,
      frequency_mhz REAL NOT NULL,
      guard_khz   REAL NOT NULL,
      locked      INTEGER NOT NULL DEFAULT 0,
      shift_mhz   REAL NOT NULL DEFAULT 0,
      UNIQUE(plan_id, channel_idx)
    );

    CREATE INDEX IF NOT EXISTS idx_plan_channels_plan ON plan_channels(plan_id);
  `);
}

function createPlan({ name, note, options, result }) {
  const database = getDb();
  const insertPlan = database.prepare(`
    INSERT INTO plans (name, note, band_start, band_end, step_khz, max_shift_khz, total_shift_mhz, solved)
    VALUES (@name, @note, @bandStart, @bandEnd, @stepKhz, @maxShiftKhz, @totalShiftMHz, @solved)
  `);
  const insertChannel = database.prepare(`
    INSERT INTO plan_channels
      (plan_id, channel_idx, name, original_frequency_mhz, frequency_mhz, guard_khz, locked, shift_mhz)
    VALUES
      (@planId, @channelIdx, @name, @originalFrequencyMHz, @frequencyMHz, @guardKhz, @locked, @shiftMHz)
  `);

  const txn = database.transaction((data) => {
    const info = insertPlan.run(data.plan);
    const planId = info.lastInsertRowid;
    for (const ch of data.channels) {
      insertChannel.run({
        planId,
        channelIdx: ch.index,
        name: ch.name,
        originalFrequencyMHz: ch.originalFrequencyMHz,
        frequencyMHz: ch.frequencyMHz,
        guardKhz: ch.guardKhz,
        locked: ch.locked ? 1 : 0,
        shiftMHz: ch.shiftMHz,
      });
    }
    return getPlan(planId);
  });

  return txn({
    plan: {
      name,
      note: note || '',
      bandStart: options.bandStart,
      bandEnd: options.bandEnd,
      stepKhz: options.stepKhz,
      maxShiftKhz: options.maxShiftKhz,
      totalShiftMHz: result.solved ? result.totalShiftMHz : 0,
      solved: result.solved ? 1 : 0,
    },
    channels: result.channels,
  });
}

function listPlans() {
  return getDb()
    .prepare(
      `SELECT id, name, note, band_start AS bandStart, band_end AS bandEnd,
              step_khz AS stepKhz, max_shift_khz AS maxShiftKhz,
              total_shift_mhz AS totalShiftMHz, solved, created_at AS createdAt
       FROM plans ORDER BY id DESC`
    )
    .all()
    .map((p) => ({ ...p, solved: Boolean(p.solved) }));
}

function getPlan(id) {
  const database = getDb();
  const plan = database
    .prepare(
      `SELECT id, name, note, band_start AS bandStart, band_end AS bandEnd,
              step_khz AS stepKhz, max_shift_khz AS maxShiftKhz,
              total_shift_mhz AS totalShiftMHz, solved, created_at AS createdAt
       FROM plans WHERE id = ?`
    )
    .get(id);
  if (!plan) return null;
  plan.solved = Boolean(plan.solved);
  plan.channels = database
    .prepare(
      `SELECT channel_idx AS "index", name,
              original_frequency_mhz AS originalFrequencyMHz,
              frequency_mhz AS frequencyMHz,
              guard_khz AS guardKhz, locked, shift_mhz AS shiftMHz
       FROM plan_channels WHERE plan_id = ? ORDER BY channel_idx`
    )
    .all(id)
    .map((c) => ({ ...c, locked: Boolean(c.locked), shifted: Math.abs(c.shiftMHz) > 1e-7 }));
  return plan;
}

function deletePlan(id) {
  return getDb().prepare('DELETE FROM plans WHERE id = ?').run(id).changes > 0;
}

module.exports = { getDb, createPlan, listPlans, getPlan, deletePlan };
