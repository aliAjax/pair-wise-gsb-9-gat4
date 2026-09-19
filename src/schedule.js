// 阅读排期闭环引擎 —— 纯函数，无 UI 依赖，可在 Node 下直接测试。
//
// 规则：
//   R1 每日容量上限：同一计划阅读日总时长不得超过 DAILY_LIMIT 分钟，超出阻止排入。
//   R2 锁定释放：开始阅读后当日位置锁定；改期必须释放原日期占用（不允许凭空取消）。
//   R3 修订留档：已读文献改排期必须填写修订说明；修订只追加，原记录不可覆盖。

export const DAILY_LIMIT = 90;

export const RULE = {
  CAPACITY: 'R1 每日容量上限(90分钟)',
  LOCK_RELEASE: 'R2 锁定改期释放',
  READ_ARCHIVE: 'R3 已读修订留档',
  INPUT: 'R0 输入校验',
};

export const PRIORITIES = ['高', '中', '低'];

const pad = (n) => String(n).padStart(2, '0');

export const todayStr = (d = new Date()) =>
  `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

export const shiftDate = (dateStr, days) => {
  const d = new Date(`${dateStr}T00:00:00`);
  d.setDate(d.getDate() + days);
  return todayStr(d);
};

let revSeq = 0;
const revId = () => `rev-${Date.now().toString(36)}-${(revSeq++).toString(36)}`;

// 旧数据迁移：补齐 priority / plan / revisions 字段
export function normalizePaper(p) {
  return {
    priority: '中',
    ...p,
    plan: {
      date: null,
      minutes: 30,
      locked: false,
      startedAt: null,
      ...(p.plan || {}),
    },
    revisions: Array.isArray(p.revisions) ? p.revisions : [],
  };
}

export const normalizeAll = (items) => (Array.isArray(items) ? items : []).map(normalizePaper);

// 日期占用表：{ [date]: { date, total, entries[] } }
export function occupancyOf(items, excludeId = null) {
  const occ = {};
  for (const p of items) {
    if (p.id === excludeId) continue;
    const plan = p.plan;
    if (!plan || !plan.date) continue;
    if (!occ[plan.date]) occ[plan.date] = { date: plan.date, total: 0, entries: [] };
    occ[plan.date].total += plan.minutes;
    occ[plan.date].entries.push({
      id: p.id,
      title: p.title,
      minutes: plan.minutes,
      locked: !!plan.locked,
      status: p.status,
      priority: p.priority,
    });
  }
  return occ;
}

const conflict = (rule, date, overBy, contenders, message) => ({
  rule, date, overBy, limit: DAILY_LIMIT, contenders, message,
});

// R1：目标日期排入后是否超容量；超则返回冲突对象（含争用文献），否则 null
export function capacityConflict(items, id, date, minutes) {
  const day = occupancyOf(items, id)[date];
  if (!day) return null;
  const overBy = day.total + minutes - DAILY_LIMIT;
  if (overBy <= 0) return null;
  return conflict(
    RULE.CAPACITY, date, overBy, day.entries,
    `${date} 已排 ${day.total} 分钟，再排入 ${minutes} 分钟将超时 ${overBy} 分钟（上限 ${DAILY_LIMIT}）`,
  );
}

// 排期 / 改期。成功返回 { ok, items, revision }，失败返回 { ok:false, error }
export function schedulePaper(items, id, { date, minutes, reason = '' }) {
  const paper = items.find((x) => x.id === id);
  if (!paper) return { ok: false, error: conflict(RULE.INPUT, date, 0, [], '文献不存在') };
  if (!date) return { ok: false, error: conflict(RULE.INPUT, date, 0, [], '必须选择计划阅读日') };
  minutes = Number(minutes);
  if (!Number.isFinite(minutes) || minutes <= 0) {
    return { ok: false, error: conflict(RULE.INPUT, date, 0, [], '预计分钟必须为正整数') };
  }
  minutes = Math.round(minutes);

  const old = paper.plan;
  const isMove = !!(old.date && old.date !== date);
  const isChange = old.date !== date || old.minutes !== minutes;

  // R3：已读文献改排期（已有排期记录）必须填写修订说明
  if (paper.status === '已读' && old.date && isChange && !reason.trim()) {
    return {
      ok: false,
      error: conflict(
        RULE.READ_ARCHIVE, date, 0,
        [{ id: paper.id, title: paper.title, minutes }],
        '已读文献改排期必须填写修订说明：修订将追加留档，原记录不可覆盖',
      ),
    };
  }

  // R1：容量校验（排除自身，自身旧占用随改期释放）
  const cap = capacityConflict(items, id, date, minutes);
  if (cap) return { ok: false, error: cap };

  // 修订链：任何排期变更都追加留档，原记录保留在 revisions 中
  const revision = isChange
    ? {
        id: revId(),
        at: new Date().toISOString(),
        paperId: id,
        from: { date: old.date, minutes: old.minutes },
        to: { date, minutes },
        reason: reason.trim() || (old.date ? (isMove ? '改期' : '调整时长') : '首次排期'),
        // R2：改期释放原日期占用
        released: isMove ? { date: old.date, minutes: old.minutes } : null,
        rule: isMove && old.locked ? RULE.LOCK_RELEASE
          : paper.status === '已读' ? RULE.READ_ARCHIVE
          : RULE.CAPACITY,
      }
    : null;

  const items2 = items.map((x) =>
    x.id === id
      ? {
          ...x,
          plan: { ...x.plan, date, minutes },
          revisions: revision ? [...x.revisions, revision] : x.revisions,
        }
      : x,
  );
  return { ok: true, items: items2, revision };
}

// 取消排期。锁定文献禁止凭空取消（R2：只能改期释放）；已读需修订说明（R3）
export function unschedulePaper(items, id, { reason = '' } = {}) {
  const paper = items.find((x) => x.id === id);
  if (!paper) return { ok: false, error: conflict(RULE.INPUT, null, 0, [], '文献不存在') };
  const old = paper.plan;
  if (!old.date) return { ok: true, items };
  if (old.locked) {
    return {
      ok: false,
      error: conflict(
        RULE.LOCK_RELEASE, old.date, 0,
        [{ id, title: paper.title, minutes: old.minutes, locked: true }],
        '阅读已开始，当日位置已锁定：只能改期（自动释放原日期），不能取消排期',
      ),
    };
  }
  if (paper.status === '已读' && !reason.trim()) {
    return {
      ok: false,
      error: conflict(
        RULE.READ_ARCHIVE, old.date, 0,
        [{ id, title: paper.title, minutes: old.minutes }],
        '已读文献取消排期必须填写修订说明',
      ),
    };
  }
  const revision = {
    id: revId(),
    at: new Date().toISOString(),
    paperId: id,
    from: { date: old.date, minutes: old.minutes },
    to: { date: null, minutes: old.minutes },
    reason: reason.trim() || '取消排期',
    released: { date: old.date, minutes: old.minutes },
    rule: paper.status === '已读' ? RULE.READ_ARCHIVE : RULE.CAPACITY,
  };
  const items2 = items.map((x) =>
    x.id === id
      ? { ...x, plan: { ...x.plan, date: null }, revisions: [...x.revisions, revision] }
      : x,
  );
  return { ok: true, items: items2, revision };
}

// 开始阅读：锁定当日位置；无排期时自动排入今天（仍受 R1 约束）
export function startReading(items, id, today = todayStr()) {
  const paper = items.find((x) => x.id === id);
  if (!paper) return { ok: false, error: conflict(RULE.INPUT, today, 0, [], '文献不存在') };
  let next = items;
  if (!paper.plan.date) {
    const r = schedulePaper(items, id, {
      date: today,
      minutes: paper.plan.minutes || 30,
      reason: '开始阅读，自动排入今天',
    });
    if (!r.ok) return r;
    next = r.items;
  }
  return {
    ok: true,
    items: next.map((x) =>
      x.id === id
        ? {
            ...x,
            status: '阅读中',
            plan: { ...x.plan, locked: true, startedAt: x.plan.startedAt || new Date().toISOString() },
          }
        : x,
    ),
  };
}

// 标记已读：当日锁定解除，排期作为历史记录保留
export function markRead(items, id) {
  return items.map((x) =>
    x.id === id ? { ...x, status: '已读', plan: { ...x.plan, locked: false } } : x,
  );
}

export const setPriority = (items, id, priority) =>
  PRIORITIES.includes(priority)
    ? items.map((x) => (x.id === id ? { ...x, priority } : x))
    : items;

// 重载一致性校验：日期占用超容、修订链断链都会被列出
export function validateSchedule(items) {
  const conflicts = [];
  const occ = occupancyOf(items);
  for (const date of Object.keys(occ).sort()) {
    const day = occ[date];
    if (day.total > DAILY_LIMIT) {
      conflicts.push(conflict(
        RULE.CAPACITY, date, day.total - DAILY_LIMIT, day.entries,
        `${date} 共排 ${day.total} 分钟，超时 ${day.total - DAILY_LIMIT} 分钟（上限 ${DAILY_LIMIT}）`,
      ));
    }
  }
  const ids = new Set(items.map((x) => x.id));
  for (const p of items) {
    for (const rev of p.revisions || []) {
      if (rev.paperId !== p.id || !ids.has(rev.paperId)) {
        conflicts.push(conflict(
          RULE.READ_ARCHIVE, rev.to?.date || null, 0,
          [{ id: p.id, title: p.title }],
          `修订记录 ${rev.id} 与文献不匹配，修订链不一致`,
        ));
      }
    }
  }
  return conflicts;
}

// 初始数据（日期相对首次加载计算）
export function seedLibrary() {
  const today = todayStr();
  const yesterday = shiftDate(today, -1);
  const dayBefore = shiftDate(today, -2);
  return normalizeAll([
    {
      id: 1, title: 'The Extended Mind', authors: 'Clark, A. & Chalmers, D.', year: 1998,
      venue: 'Analysis', tags: ['具身认知', '经典'],
      abstract: '本文提出心智延展论：当外部环境稳定地承担认知功能时，心智边界可以超越头脑与身体。',
      status: '阅读中', cite: 'Clark, A. & Chalmers, D. (1998). The Extended Mind. Analysis.',
      priority: '高',
      plan: { date: today, minutes: 45, locked: true, startedAt: new Date().toISOString() },
      revisions: [],
    },
    {
      id: 2, title: 'Situated Learning', authors: 'Lave, J. & Wenger, E.', year: 1991,
      venue: 'Cambridge University Press', tags: ['学习科学', '社会'],
      abstract: '学习发生在真实情境的参与过程中，知识与共同体实践不可分割。',
      status: '待读', cite: 'Lave, J. & Wenger, E. (1991). Situated Learning.',
      priority: '中',
      plan: { date: today, minutes: 30, locked: false, startedAt: null },
      revisions: [],
    },
    {
      id: 3, title: 'Designing with Data', authors: 'Miller, S.', year: 2022,
      venue: 'MIT Press', tags: ['设计研究', '方法'],
      abstract: '一套面向设计师的数据研究方法，讨论如何把定性洞察转化为可行动的设计决策。',
      status: '已读', cite: 'Miller, S. (2022). Designing with Data.',
      priority: '低',
      plan: { date: yesterday, minutes: 60, locked: false, startedAt: null },
      revisions: [
        {
          id: 'rev-seed-1', at: new Date().toISOString(), paperId: 3,
          from: { date: dayBefore, minutes: 40 }, to: { date: yesterday, minutes: 60 },
          reason: '实际篇幅超预期，改期一天并上调时长',
          released: { date: dayBefore, minutes: 40 },
          rule: RULE.READ_ARCHIVE,
        },
      ],
    },
  ]);
}
