// 阅读排期闭环引擎。
// 纯函数实现，不依赖 React / 浏览器：UI 与 node 测试共用同一套规则，
// 保证「排期 → 锁定 → 释放 → 修订留档 → 重载校验」闭环各处行为一致。

export const DAILY_LIMIT = 90; // 同一日期总时长上限（分钟）

export const RULES = {
  R1: 'R1 · 同一日期总时长不得超过 90 分钟',
  R2: 'R2 · 开始阅读后锁定当日位置，改期必须先释放原日期',
  R3: 'R3 · 已读文献改排期必须填写修订说明并留档，原记录不可覆盖',
};

export const PRIORITIES = ['高', '中', '低'];
export const STATUSES = ['待读', '阅读中', '已读'];

const pad = n => String(n).padStart(2, '0');

export const todayStr = (d = new Date()) =>
  `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

export const shiftDate = (dateStr, days) => {
  const d = new Date(`${dateStr}T00:00:00`);
  d.setDate(d.getDate() + days);
  return todayStr(d);
};

// ---------- 数据规范化 ----------

export function normalizeItem(raw) {
  const plan = raw.plan || {};
  const minutes = Math.round(+raw.minutes);
  return {
    ...raw,
    tags: Array.isArray(raw.tags) ? raw.tags : [],
    priority: PRIORITIES.includes(raw.priority) ? raw.priority : '中',
    minutes: Number.isFinite(minutes) && minutes > 0 ? minutes : 30,
    status: STATUSES.includes(raw.status) ? raw.status : '待读',
    plan: {
      date: plan.date || null,
      locked: Boolean(plan.locked && plan.date), // 锁定必须依附于某个日期
      startedAt: plan.startedAt || null,
    },
    revisions: Array.isArray(raw.revisions) ? raw.revisions : [],
  };
}

// ---------- 日期占用查询 ----------

export const scheduledOn = (items, date, excludeId = null) =>
  items.filter(p => p.plan.date === date && p.id !== excludeId);

export const dayLoad = (items, date, excludeId = null) =>
  scheduledOn(items, date, excludeId).reduce((sum, p) => sum + p.minutes, 0);

// ---------- 冲突对象 ----------
// 统一携带：日期、超时分钟、争用文献、触发规则

const asContender = p => ({
  id: p.id,
  title: p.title,
  minutes: p.minutes,
  priority: p.priority,
  status: p.status,
});

export function makeConflict(date, overMinutes, contenders, rule) {
  return { date: date || null, overMinutes, contenders: contenders.map(asContender), rule };
}

const fail = (date, overMinutes, contenders, rule) => ({
  ok: false,
  conflict: makeConflict(date, overMinutes, contenders, rule),
});

// ---------- 修订链（只增不改，原记录不可覆盖） ----------

function appendRevision(item, entry) {
  const revision = {
    seq: item.revisions.length + 1,
    at: new Date().toISOString(),
    ...entry,
  };
  return { ...item, revisions: [...item.revisions, revision] };
}

const replaceItem = (items, next) => items.map(p => (p.id === next.id ? next : p));

// ---------- 闭环操作 ----------

// 排入计划阅读日 / 改期
export function scheduleItem(items, id, date, { reason = '' } = {}) {
  const item = items.find(p => p.id === id);
  if (!item) return fail(date, 0, [], 'R0 · 文献不存在');
  if (!date) return fail(date, 0, [item], 'R0 · 必须选择计划阅读日');
  const fromDate = item.plan.date;
  if (fromDate === date) return { ok: true, items, changed: false };

  // R2：阅读中锁定当日位置，改期必须先释放原日期
  if (item.plan.locked && fromDate) return fail(fromDate, 0, [item], RULES.R2);
  // R3：已读文献改排期必须填写修订说明
  if (item.status === '已读' && !reason.trim()) return fail(date, 0, [item], RULES.R3);
  // R1：同一日期总时长不得超过 90 分钟
  const projected = dayLoad(items, date, id) + item.minutes;
  if (projected > DAILY_LIMIT) {
    return fail(date, projected - DAILY_LIMIT, [...scheduledOn(items, date, id), item], RULES.R1);
  }

  let next = { ...item, plan: { ...item.plan, date } };
  if (fromDate || item.status === '已读') {
    // 凡是改期（或已读文献的任何排期变更）都追加留档，原记录只增不改
    next = appendRevision(next, {
      type: 'reschedule',
      fromDate,
      toDate: date,
      reason: reason.trim() || '调整计划阅读日',
      statusAt: item.status,
    });
  }
  return { ok: true, items: replaceItem(items, next), changed: true };
}

// 释放原日期：解除锁定并腾出当日占用（改期的前置步骤）
export function releaseSlot(items, id, { note = '' } = {}) {
  const item = items.find(p => p.id === id);
  if (!item) return fail(null, 0, [], 'R0 · 文献不存在');
  if (!item.plan.date) return fail(null, 0, [item], 'R0 · 该文献尚未排期');
  // 已读文献的排期变更同样需要修订说明
  if (item.status === '已读' && !note.trim()) return fail(item.plan.date, 0, [item], RULES.R3);

  let next = {
    ...item,
    status: item.status === '阅读中' ? '待读' : item.status,
    plan: { date: null, locked: false, startedAt: null },
  };
  next = appendRevision(next, {
    type: 'release',
    fromDate: item.plan.date,
    toDate: null,
    reason: note.trim() || (item.plan.locked ? '释放锁定的原日期' : '释放计划日期'),
    statusAt: item.status,
  });
  return { ok: true, items: replaceItem(items, next), changed: true };
}

// 开始阅读：锁定当日位置
export function startReading(items, id) {
  const item = items.find(p => p.id === id);
  if (!item) return fail(null, 0, [], 'R0 · 文献不存在');
  if (!item.plan.date) return fail(null, 0, [item], 'R0 · 先排入计划阅读日才能开始阅读');
  if (item.status === '已读') {
    return fail(item.plan.date, 0, [item], 'R0 · 已读文献如需重读，请先改期并填写修订说明');
  }
  if (item.status === '阅读中' && item.plan.locked) return { ok: true, items, changed: false };

  // 阅读中但未锁定（历史数据修复路径）：有日期则补锁
  const next = {
    ...item,
    status: '阅读中',
    plan: { ...item.plan, locked: true, startedAt: item.plan.startedAt || new Date().toISOString() },
  };
  return { ok: true, items: replaceItem(items, next), changed: true };
}

// 完成阅读：解除锁定，日期作为历史占用保留
export function finishReading(items, id) {
  const item = items.find(p => p.id === id);
  if (!item) return fail(null, 0, [], 'R0 · 文献不存在');
  if (item.status !== '阅读中') {
    return fail(item.plan.date, 0, [item], 'R0 · 只有阅读中的文献才能标记完成');
  }
  const next = { ...item, status: '已读', plan: { ...item.plan, locked: false } };
  return { ok: true, items: replaceItem(items, next), changed: true };
}

// 调整优先级 / 预计分钟（分钟变化会重新校验当日容量）
export function setMeta(items, id, { priority, minutes } = {}) {
  const item = items.find(p => p.id === id);
  if (!item) return fail(null, 0, [], 'R0 · 文献不存在');
  const next = { ...item };
  if (priority !== undefined) {
    if (!PRIORITIES.includes(priority)) return fail(item.plan.date, 0, [item], 'R0 · 优先级无效');
    next.priority = priority;
  }
  if (minutes !== undefined) {
    const m = Math.round(+minutes);
    if (!Number.isFinite(m) || m <= 0) return fail(item.plan.date, 0, [item], 'R0 · 预计分钟必须为正整数');
    next.minutes = m;
  }
  if (next.plan.date) {
    const projected = dayLoad(items, next.plan.date, id) + next.minutes;
    if (projected > DAILY_LIMIT) {
      return fail(next.plan.date, projected - DAILY_LIMIT, [...scheduledOn(items, next.plan.date, id), next], RULES.R1);
    }
  }
  return { ok: true, items: replaceItem(items, next), changed: true };
}

// ---------- 重载一致性校验 ----------
// 重新加载后重算日期占用与修订链，冲突逐条列出：日期 / 超时分钟 / 争用文献 / 触发规则

export function validateState(items) {
  const conflicts = [];

  // 1) 日期占用一致性：重算每日负载是否超限
  const dates = [...new Set(items.map(p => p.plan.date).filter(Boolean))].sort();
  for (const date of dates) {
    const occupants = scheduledOn(items, date);
    const total = occupants.reduce((s, p) => s + p.minutes, 0);
    if (total > DAILY_LIMIT) {
      conflicts.push(makeConflict(date, total - DAILY_LIMIT, occupants, RULES.R1));
    }
  }

  // 2) 锁定一致性：锁定必须有日期；阅读中必须已锁定当日位置
  for (const p of items) {
    if (p.plan.locked && !p.plan.date) conflicts.push(makeConflict(null, 0, [p], RULES.R2));
    if (p.status === '阅读中' && !p.plan.locked) conflicts.push(makeConflict(p.plan.date, 0, [p], RULES.R2));
  }

  // 3) 修订链一致性：seq 连续递增、字段齐全、已读改期必有说明
  for (const p of items) {
    const broken = p.revisions.some((r, i) =>
      r.seq !== i + 1 || !r.at || !r.type ||
      (r.type === 'reschedule' && r.statusAt === '已读' && !(r.reason || '').trim()));
    if (broken) conflicts.push(makeConflict(p.plan.date, 0, [p], RULES.R3));
  }

  return conflicts;
}

// ---------- 持久化 ----------

export const STORAGE_KEY = 'reading-loop-v2';
export const LEGACY_KEY = 'research-library';

export function serialize(items) {
  return JSON.stringify({ version: 2, savedAt: new Date().toISOString(), items });
}

export function deserialize(json) {
  const data = JSON.parse(json);
  if (!data || data.version !== 2 || !Array.isArray(data.items)) {
    throw new Error('存档缺失或版本不兼容');
  }
  return data.items.map(normalizeItem);
}

function migrateV1(raw) {
  return normalizeItem({
    ...raw,
    priority: '中',
    minutes: 30,
    plan: { date: null, locked: false, startedAt: null },
    revisions: [],
  });
}

export function loadItems(storage) {
  try {
    const raw = storage.getItem(STORAGE_KEY);
    if (raw) return deserialize(raw);
  } catch { /* 存档损坏则回退迁移 */ }
  try {
    const legacy = JSON.parse(storage.getItem(LEGACY_KEY) || 'null');
    if (Array.isArray(legacy) && legacy.length) return legacy.map(migrateV1);
  } catch { /* 忽略损坏的旧档 */ }
  return seedItems();
}

// ---------- 种子数据 ----------

export function seedItems() {
  const today = todayStr();
  const yesterday = shiftDate(today, -1);
  return [
    normalizeItem({
      id: 1,
      title: 'The Extended Mind',
      authors: 'Clark, A. & Chalmers, D.',
      year: 1998,
      venue: 'Analysis',
      tags: ['具身认知', '经典'],
      abstract: '本文提出心智延展论：当外部环境稳定地承担认知功能时，心智边界可以超越头脑与身体。',
      cite: 'Clark, A. & Chalmers, D. (1998). The Extended Mind. Analysis.',
      status: '阅读中',
      priority: '高',
      minutes: 40,
      plan: { date: today, locked: true, startedAt: new Date().toISOString() },
      revisions: [],
    }),
    normalizeItem({
      id: 2,
      title: 'Situated Learning',
      authors: 'Lave, J. & Wenger, E.',
      year: 1991,
      venue: 'Cambridge University Press',
      tags: ['学习科学', '社会'],
      abstract: '学习发生在真实情境的参与过程中，知识与共同体实践不可分割。',
      cite: 'Lave, J. & Wenger, E. (1991). Situated Learning.',
      status: '待读',
      priority: '中',
      minutes: 30,
      plan: { date: today, locked: false, startedAt: null },
      revisions: [],
    }),
    normalizeItem({
      id: 3,
      title: 'Designing with Data',
      authors: 'Miller, S.',
      year: 2022,
      venue: 'MIT Press',
      tags: ['设计研究', '方法'],
      abstract: '一套面向设计师的数据研究方法，讨论如何把定性洞察转化为可行动的设计决策。',
      cite: 'Miller, S. (2022). Designing with Data.',
      status: '已读',
      priority: '低',
      minutes: 50,
      plan: { date: yesterday, locked: false, startedAt: null },
      revisions: [{
        seq: 1,
        at: new Date(Date.now() - 864e5).toISOString(),
        type: 'reschedule',
        fromDate: shiftDate(today, -2),
        toDate: yesterday,
        reason: '与导师讨论顺延一天，补充对比阅读',
        statusAt: '已读',
      }],
    }),
  ];
}
