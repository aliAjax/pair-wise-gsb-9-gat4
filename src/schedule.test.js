import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DAILY_LIMIT, RULE, todayStr, shiftDate,
  normalizeAll, occupancyOf, capacityConflict,
  schedulePaper, unschedulePaper, startReading, markRead,
  setPriority, validateSchedule, seedLibrary,
} from './schedule.js';

const TODAY = '2026-09-19';
const TOMORROW = shiftDate(TODAY, 1);

const mk = (id, over = {}) => ({
  id, title: `P${id}`, authors: 'A', year: 2024, venue: 'V', tags: [],
  abstract: '', status: '待读', cite: '', priority: '中',
  plan: { date: null, minutes: 30, locked: false, startedAt: null },
  revisions: [], ...over,
});

test('R1: 同一日期总时长超过 90 分钟时阻止排入，并列出超时文献', () => {
  let items = normalizeAll([mk(1), mk(2), mk(3)]);
  items = schedulePaper(items, 1, { date: TODAY, minutes: 50 }).items;
  items = schedulePaper(items, 2, { date: TODAY, minutes: 30 }).items;
  const r = schedulePaper(items, 3, { date: TODAY, minutes: 20 }); // 50+30+20=100 > 90
  assert.equal(r.ok, false);
  assert.equal(r.error.rule, RULE.CAPACITY);
  assert.equal(r.error.date, TODAY);
  assert.equal(r.error.overBy, 10);
  assert.deepEqual(r.error.contenders.map((c) => c.id), [1, 2]);
  // 被阻止后原数据不变
  assert.equal(occupancyOf(items)[TODAY].total, 80);
});

test('R1: 恰好 90 分钟允许排入', () => {
  let items = normalizeAll([mk(1), mk(2)]);
  items = schedulePaper(items, 1, { date: TODAY, minutes: 60 }).items;
  const r = schedulePaper(items, 2, { date: TODAY, minutes: 30 });
  assert.equal(r.ok, true);
  assert.equal(occupancyOf(r.items)[TODAY].total, DAILY_LIMIT);
});

test('R2: 改期必须释放原日期占用', () => {
  let items = normalizeAll([mk(1), mk(2)]);
  items = schedulePaper(items, 1, { date: TODAY, minutes: 60 }).items;
  items = schedulePaper(items, 2, { date: TOMORROW, minutes: 60 }).items;
  // 把 P2 改期到今天：今天 60+60=120 会超，先验证被阻止
  assert.equal(schedulePaper(items, 2, { date: TODAY, minutes: 60 }).ok, false);
  // 改成 30 分钟可以，且明天占用被释放
  const r = schedulePaper(items, 2, { date: TODAY, minutes: 30 });
  assert.equal(r.ok, true);
  assert.equal(occupancyOf(r.items)[TODAY].total, 90);
  assert.equal(occupancyOf(r.items)[TOMORROW], undefined);
  assert.deepEqual(r.revision.released, { date: TOMORROW, minutes: 60 });
});

test('R2: 开始阅读后锁定当日位置，禁止凭空取消，改期释放原日期', () => {
  let items = normalizeAll([mk(1)]);
  items = schedulePaper(items, 1, { date: TODAY, minutes: 40 }).items;
  items = startReading(items, 1, TODAY).items;
  const p = items.find((x) => x.id === 1);
  assert.equal(p.plan.locked, true);
  assert.equal(p.status, '阅读中');
  // 锁定后不能取消排期
  const cancel = unschedulePaper(items, 1);
  assert.equal(cancel.ok, false);
  assert.equal(cancel.error.rule, RULE.LOCK_RELEASE);
  // 锁定改期允许，释放原日期，修订记录触发 R2
  const move = schedulePaper(items, 1, { date: TOMORROW, minutes: 40 });
  assert.equal(move.ok, true);
  assert.equal(move.revision.rule, RULE.LOCK_RELEASE);
  assert.deepEqual(move.revision.released, { date: TODAY, minutes: 40 });
  assert.equal(occupancyOf(move.items)[TODAY], undefined);
});

test('开始阅读时无排期则自动排入今天；今日已满则阻止', () => {
  let items = normalizeAll([mk(1), mk(2)]);
  items = schedulePaper(items, 1, { date: TODAY, minutes: 90 }).items;
  const full = startReading(items, 2, TODAY);
  assert.equal(full.ok, false);
  assert.equal(full.error.rule, RULE.CAPACITY);
  const okItems = normalizeAll([mk(3)]);
  const r = startReading(okItems, 3, TODAY);
  assert.equal(r.ok, true);
  const p = r.items[0];
  assert.equal(p.plan.date, TODAY);
  assert.equal(p.plan.locked, true);
  assert.equal(p.status, '阅读中');
});

test('R3: 已读文献改排期必须填写修订说明，留档且原记录不可覆盖', () => {
  let items = normalizeAll([mk(1, { status: '已读' })]);
  items = schedulePaper(items, 1, { date: TODAY, minutes: 60 }).items;
  // 无说明 → 阻止
  const blocked = schedulePaper(items, 1, { date: TOMORROW, minutes: 60 });
  assert.equal(blocked.ok, false);
  assert.equal(blocked.error.rule, RULE.READ_ARCHIVE);
  // 有说明 → 允许，修订链追加，原记录保留
  const r = schedulePaper(items, 1, { date: TOMORROW, minutes: 45, reason: '二刷重点章节' });
  assert.equal(r.ok, true);
  const p = r.items[0];
  assert.equal(p.revisions.length, 2);
  assert.deepEqual(p.revisions[0].to, { date: TODAY, minutes: 60 }); // 原记录仍在
  assert.equal(p.revisions[1].reason, '二刷重点章节');
  assert.equal(p.revisions[1].rule, RULE.READ_ARCHIVE);
  assert.equal(p.plan.date, TOMORROW);
});

test('修订链只追加：多次改期后历史完整', () => {
  let items = normalizeAll([mk(1)]);
  items = schedulePaper(items, 1, { date: TODAY, minutes: 30 }).items;
  items = schedulePaper(items, 1, { date: TOMORROW, minutes: 30 }).items;
  items = schedulePaper(items, 1, { date: TOMORROW, minutes: 50 }).items;
  const revs = items[0].revisions;
  assert.equal(revs.length, 3);
  assert.equal(revs[0].from.date, null);
  assert.equal(revs[2].from.date, TOMORROW);
  assert.equal(revs[2].to.minutes, 50);
});

test('重载一致性：序列化往返后文献、日期占用、修订链一致', () => {
  let items = seedLibrary();
  items = schedulePaper(items, 2, { date: TOMORROW, minutes: 30, reason: '今天排满了' }).items;
  const reloaded = normalizeAll(JSON.parse(JSON.stringify(items)));
  assert.deepEqual(occupancyOf(reloaded), occupancyOf(items));
  assert.deepEqual(
    reloaded.map((x) => x.revisions),
    items.map((x) => x.revisions),
  );
  assert.deepEqual(validateSchedule(reloaded), []);
});

test('冲突报告：列出日期、超时分钟、争用文献和触发规则', () => {
  // 构造一个被外部篡改的超容状态，验证重载校验能发现
  const items = normalizeAll([
    mk(1, { plan: { date: TODAY, minutes: 50, locked: false, startedAt: null } }),
    mk(2, { plan: { date: TODAY, minutes: 50, locked: false, startedAt: null } }),
  ]);
  const conflicts = validateSchedule(items);
  assert.equal(conflicts.length, 1);
  const c = conflicts[0];
  assert.equal(c.date, TODAY);
  assert.equal(c.overBy, 10);
  assert.equal(c.rule, RULE.CAPACITY);
  assert.deepEqual(c.contenders.map((x) => x.id), [1, 2]);
});

test('旧数据迁移与优先级设置', () => {
  const legacy = [{ id: 9, title: 'Old', status: '待读', tags: [] }];
  const [p] = normalizeAll(legacy);
  assert.deepEqual(p.plan, { date: null, minutes: 30, locked: false, startedAt: null });
  assert.equal(p.priority, '中');
  const items = setPriority([p], 9, '高');
  assert.equal(items[0].priority, '高');
  assert.equal(setPriority([p], 9, '无效')[0].priority, '中');
});

test('标记已读解除锁定，排期保留为历史', () => {
  let items = normalizeAll([mk(1)]);
  items = startReading(items, 1, TODAY).items;
  items = markRead(items, 1);
  const p = items[0];
  assert.equal(p.status, '已读');
  assert.equal(p.plan.locked, false);
  assert.equal(p.plan.date, TODAY);
});

test('capacityConflict 不超容时返回 null', () => {
  const items = normalizeAll([mk(1, { plan: { date: TODAY, minutes: 10, locked: false, startedAt: null } })]);
  assert.equal(capacityConflict(items, 2, TODAY, 80), null);
  assert.equal(capacityConflict(items, 2, TODAY, 81).overBy, 1);
});
