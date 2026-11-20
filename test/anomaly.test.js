'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { detectAnomalies } = require('../server/anomaly');

const mk = (over = {}) => ({
  id: 1, request_id: 'r1', ts: '2026-11-20T00:00:00.000Z', version: 'v1',
  group_key: 'g1', position: 2, impressed: 1, clicked: 0, session_id: 's1', ...over,
});

test('全点机器人会话被标记', () => {
  const samples = Array.from({ length: 6 }, (_, i) => mk({
    id: i + 1, request_id: `r${i}`, clicked: 1, session_id: 'bot',
  }));
  const flags = detectAnomalies(samples);
  assert.equal(flags.size, 6);
  assert.equal(flags.get(1), 'bot_full_click');
});

test('正常会话不被误伤', () => {
  const samples = Array.from({ length: 6 }, (_, i) => mk({
    id: i + 1, request_id: `r${i}`, clicked: i % 2, session_id: 'human',
  }));
  assert.equal(detectAnomalies(samples).size, 0);
});

test('高频会话被标记（60 秒窗口 >30 请求）', () => {
  const base = Date.parse('2026-11-20T00:00:00Z');
  const samples = Array.from({ length: 35 }, (_, i) => mk({
    id: i + 1, request_id: `r${i}`, session_id: 'flood',
    ts: new Date(base + i * 1000).toISOString(),
  }));
  const flags = detectAnomalies(samples);
  assert.equal(flags.size, 35);
  assert.equal(flags.get(1), 'high_frequency');
});

test('重复 request_id：保留首条，后续标记', () => {
  const samples = [
    mk({ id: 1, request_id: 'dup' }),
    mk({ id: 2, request_id: 'dup' }),
    mk({ id: 3, request_id: 'ok' }),
  ];
  const flags = detectAnomalies(samples);
  assert.equal(flags.get(2), 'duplicate_request');
  assert.equal(flags.has(1), false);
  assert.equal(flags.has(3), false);
});

test('有点击无曝光与非法位置', () => {
  const samples = [
    mk({ id: 1, clicked: 1, impressed: 0 }),
    mk({ id: 2, request_id: 'r2', position: 0 }),
    mk({ id: 3, request_id: 'r3' }),
  ];
  const flags = detectAnomalies(samples);
  assert.equal(flags.get(1), 'click_without_impression');
  assert.equal(flags.get(2), 'invalid_position');
  assert.equal(flags.has(3), false);
});
