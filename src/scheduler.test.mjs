// 阅读排期闭环规则测试：node src/scheduler.test.mjs
import assert from 'node:assert/strict';
import {
  DAILY_LIMIT, RULES, STORAGE_KEY, LEGACY_KEY,
  todayStr, shiftDate, dayLoad,
  scheduleItem, releaseSlot, startReading, finishReading, setMeta,
  validateState, serialize, deserialize, seedItems, loadItems, normalizeItem,
} from './scheduler.js';

let passed = 0;
const t = (name, fn) => { fn(); passed += 1; console.log(`✓ ${name}`); };

const today = todayStr();
const tomorrow = shiftDate(today, 1);
const yesterday = shiftDate(today, -1);

const paper = (id, over = {}) => normalizeItem({
  id, title: `Paper ${id}`, authors: 'A.', year: 2024, venue: 'V',
  tags: [], abstract: '', cite: '', status: '待读',
  priority: '中', minutes: 30,
  plan: { date: null, locked: false, startedAt: null },
  revisions: [],
  ...over,
});

// ---------- 排入与容量（R1） ----------

t('种子数据自洽：文献、日期占用、修订链一致，无冲突', () => {
  assert.deepEqual(validateState(seedItems()), []);
});

t('R1：排入后当日总时长 ≤ 90 分钟则成功', () => {
  const items = seedItems(); // 今日已占 40 + 30 = 70
  const withNew = [...items, paper(4, { minutes: 20 })];
  const r = scheduleItem(withNew, 4, today);
  assert.equal(r.ok, true);
  assert.equal(dayLoad(r.items, today), 90);
});

t('R1：超出 90 分钟阻止排入，冲突列出日期、超时分钟、争用文献、触发规则', () => {
  const items = seedItems(); // 今日 70 分钟
  const withNew = [...items, paper(4, { minutes: 30 })];
  const r = scheduleItem(withNew, 4, today); // 70 + 30 = 100，超 10
  assert.equal(r.ok, false);
  assert.equal(r.conflict.date, today);
  assert.equal(r.conflict.overMinutes, 10);
  assert.equal(r.conflict.contenders.length, 3); // 当日 2 篇 + 待排入 1 篇
  assert.ok(r.conflict.contenders.some(c => c.title === 'Paper 4'));
  assert.equal(r.conflict.rule, RULES.R1);
  assert.equal(dayLoad(r.items ?? withNew, today), 70); // 原占用不变
});

t('R1：调大预计分钟撑爆当日容量同样被阻止', () => {
  const items = seedItems(); // 今日 40 + 30
  const r = setMeta(items, 2, { minutes: 60 }); // 40 + 60 = 100
  assert.equal(r.ok, false);
  assert.equal(r.conflict.overMinutes, 10);
  assert.equal(r.conflict.rule, RULES.R1);
});

// ---------- 锁定与释放（R2） ----------

t('R2：开始阅读后锁定当日位置，直接改期被阻止', () => {
  const items = seedItems(); // id=1 阅读中，锁定今日
  const r = scheduleItem(items, 1, tomorrow);
  assert.equal(r.ok, false);
  assert.equal(r.conflict.date, today); // 冲突指向被锁定的原日期
  assert.equal(r.conflict.rule, RULES.R2);
});

t('R2：改期必须先释放原日期，释放后腾出占用并可改期', () => {
  let items = seedItems();
  const rel = releaseSlot(items, 1);
  assert.equal(rel.ok, true);
  const released = rel.items.find(p => p.id === 1);
  assert.equal(released.plan.date, null);
  assert.equal(released.plan.locked, false);
  assert.equal(released.status, '待读'); // 未完成的阅读回到待读
  assert.equal(dayLoad(rel.items, today), 30); // 原日期占用已释放
  assert.equal(released.revisions.length, 1);
  assert.equal(released.revisions[0].type, 'release');
  assert.equal(released.revisions[0].fromDate, today);

  const re = scheduleItem(rel.items, 1, tomorrow);
  assert.equal(re.ok, true);
  assert.equal(re.items.find(p => p.id === 1).plan.date, tomorrow);
});

t('待读文献开始阅读即锁定当日位置', () => {
  const items = seedItems();
  const r = startReading(items, 2);
  assert.equal(r.ok, true);
  const p2 = r.items.find(p => p.id === 2);
  assert.equal(p2.status, '阅读中');
  assert.equal(p2.plan.locked, true);
  assert.equal(p2.plan.date, today);
  // 锁定后同样受 R2 约束
  assert.equal(scheduleItem(r.items, 2, tomorrow).ok, false);
});

t('未排期不能开始阅读；完成阅读后解除锁定、日期留作历史占用', () => {
  let items = [...seedItems(), paper(4)];
  assert.equal(startReading(items, 4).ok, false); // 未排期
  const fin = finishReading(items, 1);
  assert.equal(fin.ok, true);
  const p1 = fin.items.find(p => p.id === 1);
  assert.equal(p1.status, '已读');
  assert.equal(p1.plan.locked, false);
  assert.equal(p1.plan.date, today); // 历史占用保留
  assert.equal(dayLoad(fin.items, today), 70);
});

// ---------- 已读改期与修订留档（R3） ----------

t('R3：已读文献改排期必须填写修订说明', () => {
  const items = seedItems(); // id=3 已读
  const noReason = scheduleItem(items, 3, tomorrow);
  assert.equal(noReason.ok, false);
  assert.equal(noReason.rule, undefined); // 无 rule 字段，防误用
  assert.equal(noReason.conflict.rule, RULES.R3);
  const withReason = scheduleItem(items, 3, tomorrow, { reason: '重读并补笔记' });
  assert.equal(withReason.ok, true);
});

t('R3：修订留档只增不改，原记录不可覆盖', () => {
  const items = seedItems();
  const before = items.find(p => p.id === 3).revisions;
  const snapshot = JSON.stringify(before);

  const r1 = scheduleItem(items, 3, tomorrow, { reason: '第一次改期' });
  const rev1 = r1.items.find(p => p.id === 3).revisions;
  assert.equal(rev1.length, before.length + 1);
  assert.equal(JSON.stringify(rev1.slice(0, before.length)), snapshot); // 原记录未被覆盖
  assert.equal(rev1.at(-1).reason, '第一次改期');
  assert.equal(rev1.at(-1).fromDate, yesterday);
  assert.equal(rev1.at(-1).toDate, tomorrow);
  assert.equal(rev1.at(-1).seq, before.length + 1);

  const r2 = scheduleItem(r1.items, 3, shiftDate(tomorrow, 1), { reason: '第二次改期' });
  const rev2 = r2.items.find(p => p.id === 3).revisions;
  assert.equal(rev2.length, before.length + 2);
  assert.equal(JSON.stringify(rev2.slice(0, rev1.length)), JSON.stringify(rev1)); // 依旧只增不改
});

t('R3：已读文献释放日期同样需要修订说明', () => {
  const items = seedItems();
  assert.equal(releaseSlot(items, 3).ok, false);
  assert.equal(releaseSlot(items, 3).conflict.rule, RULES.R3);
  assert.equal(releaseSlot(items, 3, { note: '归档，不再重读' }).ok, true);
});

// ---------- 持久化与重载校验 ----------

t('持久化往返：文献、日期占用、修订链重新加载后一致', () => {
  let items = seedItems();
  items = scheduleItem(items, 3, tomorrow, { reason: '重读' }).items;
  items = releaseSlot(items, 1).items;
  const restored = deserialize(serialize(items));
  assert.deepEqual(restored, items); // 文献与修订链逐字段一致
  assert.deepEqual(validateState(restored), []);
  for (const d of [today, yesterday, tomorrow]) {
    assert.equal(dayLoad(restored, d), dayLoad(items, d)); // 日期占用一致
  }
});

t('重载校验：超限日期被列出（日期 / 超时分钟 / 争用文献 / 触发规则）', () => {
  const tampered = [
    paper(1, { minutes: 50, plan: { date: today, locked: false, startedAt: null } }),
    paper(2, { minutes: 60, plan: { date: today, locked: false, startedAt: null } }),
  ]; // 110 分钟，超 20
  const conflicts = validateState(tampered);
  assert.equal(conflicts.length, 1);
  assert.equal(conflicts[0].date, today);
  assert.equal(conflicts[0].overMinutes, 20);
  assert.equal(conflicts[0].contenders.length, 2);
  assert.equal(conflicts[0].rule, RULES.R1);
});

t('重载校验：锁定异常与修订链损坏分别触发 R2 / R3', () => {
  const badLock = [paper(1, { status: '阅读中', plan: { date: today, locked: false, startedAt: null } })];
  assert.ok(validateState(badLock).some(c => c.rule === RULES.R2));

  const badChain = [paper(1, {
    status: '已读',
    revisions: [{ seq: 5, at: new Date().toISOString(), type: 'reschedule', fromDate: yesterday, toDate: today, reason: '', statusAt: '已读' }],
  })];
  assert.ok(validateState(badChain).some(c => c.rule === RULES.R3));
});

t('旧版文献库自动迁移进排期闭环', () => {
  const store = new Map();
  const storage = { getItem: k => store.get(k) ?? null, setItem: (k, v) => store.set(k, v) };
  storage.setItem(LEGACY_KEY, JSON.stringify([
    { id: 9, title: 'Legacy', authors: 'B.', year: 2000, venue: 'V', tags: ['旧'], abstract: '', cite: '', status: '待读' },
  ]));
  const items = loadItems(storage);
  assert.equal(items.length, 1);
  assert.equal(items[0].priority, '中');
  assert.equal(items[0].minutes, 30);
  assert.deepEqual(items[0].plan, { date: null, locked: false, startedAt: null });
  assert.deepEqual(items[0].revisions, []);
  // 迁移后可正常排期
  assert.equal(scheduleItem(items, 9, today).ok, true);
});

t('v2 存档优先于旧档加载', () => {
  const store = new Map();
  const storage = { getItem: k => store.get(k) ?? null, setItem: (k, v) => store.set(k, v) };
  storage.setItem(STORAGE_KEY, serialize(seedItems()));
  storage.setItem(LEGACY_KEY, JSON.stringify([{ id: 9, title: 'Legacy' }]));
  assert.equal(loadItems(storage).length, 3);
});

console.log(`\n${passed} 项闭环规则测试全部通过`);
