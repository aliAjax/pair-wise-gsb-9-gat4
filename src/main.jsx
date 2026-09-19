import React, { useEffect, useMemo, useState } from 'react';
import { createRoot } from 'react-dom/client';
import './styles.css';
import {
  DAILY_LIMIT, PRIORITIES, todayStr, shiftDate,
  normalizeAll, normalizePaper, occupancyOf,
  schedulePaper, unschedulePaper, startReading, markRead,
  setPriority, validateSchedule, seedLibrary,
} from './schedule.js';

const STORE_KEY = 'research-library';

const load = () => {
  try {
    const raw = JSON.parse(localStorage.getItem(STORE_KEY));
    if (Array.isArray(raw) && raw.length) return normalizeAll(raw);
  } catch { /* 损坏数据回退到种子 */ }
  return seedLibrary();
};

const WEEK = ['日', '一', '二', '三', '四', '五', '六'];
const weekday = (d) => `周${WEEK[new Date(`${d}T00:00:00`).getDay()]}`;
const fmtTime = (iso) => {
  const d = new Date(iso);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
};
const PRI_WEIGHT = { 高: 0, 中: 1, 低: 2 };

// 冲突展示：日期 / 超时分钟 / 争用文献 / 触发规则
function ConflictBox({ c }) {
  return (
    <div className="conflict-box">
      <div className="conflict-head">⚠ 排期冲突被拦截 · 触发规则：{c.rule}</div>
      <div className="conflict-meta">
        <div><small>日期</small><b>{c.date || '—'}</b></div>
        <div><small>超时分钟</small><b>{c.overBy > 0 ? `+${c.overBy}` : 0}</b></div>
        <div><small>当日上限</small><b>{DAILY_LIMIT} 分钟</b></div>
      </div>
      {!!c.contenders?.length && (
        <div className="contenders">
          <small>争用文献</small>
          {c.contenders.map((x) => (
            <span key={x.id}>{x.locked ? '🔒 ' : ''}{x.title}（{x.minutes}分钟）</span>
          ))}
        </div>
      )}
      <p>{c.message}</p>
    </div>
  );
}

function App() {
  const [items, setItems] = useState(load);
  const [view, setView] = useState('library');
  const [selected, setSelected] = useState(1);
  const [query, setQuery] = useState('');
  const [tag, setTag] = useState('全部');
  const [statusFilter, setStatusFilter] = useState('全部');
  const [show, setShow] = useState(false);
  const [notice, setNotice] = useState('');
  const [planError, setPlanError] = useState(null);
  const [planForm, setPlanForm] = useState({ date: '', minutes: 30, reason: '' });
  const [form, setForm] = useState({ title: '', authors: '', year: '2024', venue: '', abstract: '', tags: '' });

  useEffect(() => localStorage.setItem(STORE_KEY, JSON.stringify(items)), [items]);
  useEffect(() => {
    if (!notice) return;
    const t = setTimeout(() => setNotice(''), 3200);
    return () => clearTimeout(t);
  }, [notice]);

  const cur = items.find((x) => x.id === selected) || items[0];

  // 切换选中文献时同步排期表单
  useEffect(() => {
    if (!cur) return;
    setPlanForm({ date: cur.plan.date || '', minutes: cur.plan.minutes, reason: '' });
    setPlanError(null);
  }, [cur?.id]);

  // 重载/变更后的一致性校验：文献、日期占用、修订链
  const conflicts = useMemo(() => validateSchedule(items), [items]);
  const occ = useMemo(() => occupancyOf(items), [items]);

  const tags = ['全部', ...new Set(items.flatMap((x) => x.tags))];
  const filtered = useMemo(
    () => items.filter((x) =>
      (tag === '全部' || x.tags.includes(tag)) &&
      (statusFilter === '全部' || x.status === statusFilter) &&
      `${x.title}${x.authors}${x.abstract}`.toLowerCase().includes(query.toLowerCase())),
    [items, tag, statusFilter, query],
  );

  const update = (k, v) => setItems(items.map((x) => (x.id === cur.id ? { ...x, [k]: v } : x)));

  // —— 排期闭环动作 ——
  const applyResult = (r, okMsg) => {
    if (!r.ok) { setPlanError(r.error); return; }
    setPlanError(null);
    setItems(r.items);
    let msg = okMsg;
    if (r.revision?.released) msg += `，已释放 ${r.revision.released.date} 的 ${r.revision.released.minutes} 分钟`;
    if (r.revision) msg += '（修订已留档）';
    setNotice(msg);
  };

  const savePlan = () => {
    const r = schedulePaper(items, cur.id, {
      date: planForm.date, minutes: planForm.minutes, reason: planForm.reason,
    });
    applyResult(r, cur.plan.date ? '改期完成' : '已排入计划');
    if (r.ok) setPlanForm({ ...planForm, reason: '' });
  };

  const cancelPlan = () => {
    const r = unschedulePaper(items, cur.id, { reason: planForm.reason });
    applyResult(r, '已取消排期');
    if (r.ok) setPlanForm({ date: '', minutes: planForm.minutes, reason: '' });
  };

  const beginReading = () => {
    const r = startReading(items, cur.id, todayStr());
    applyResult(r, `已开始阅读，锁定 ${r.ok ? r.items.find((x) => x.id === cur.id).plan.date : ''} 当日位置`);
  };

  const finishReading = () => {
    setItems(markRead(items, cur.id));
    setNotice('已标记为已读，当日锁定解除；后续改排期需填写修订说明');
  };

  const add = () => {
    if (!form.title) return;
    const p = normalizePaper({
      ...form, id: Date.now(), year: +form.year,
      tags: form.tags.split(',').map((x) => x.trim()).filter(Boolean),
      status: '待读',
      cite: `${form.authors} (${form.year}). ${form.title}. ${form.venue}.`,
    });
    setItems([...items, p]);
    setSelected(p.id);
    setForm({ title: '', authors: '', year: '2024', venue: '', abstract: '', tags: '' });
    setShow(false);
    setNotice('文献已加入研究库，可在详情中排期');
  };

  const bib = () => { navigator.clipboard?.writeText(cur.cite); setNotice('引用文本已复制'); };
  const download = () => {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([items.map((x) => x.cite).join('\n')], { type: 'text/plain' }));
    a.download = 'references.txt';
    a.click();
    setNotice('引用列表已导出');
  };

  // —— 排期看板数据 ——
  const today = todayStr();
  const boardDates = useMemo(() => {
    const set = new Set(Object.keys(occ));
    for (let i = 0; i < 7; i++) set.add(shiftDate(today, i));
    return [...set].sort();
  }, [occ, today]);
  const unscheduled = items.filter((x) => !x.plan.date);

  const openPaper = (id) => { setSelected(id); setView('library'); };

  const needReason = cur?.status === '已读' && !!cur?.plan.date;

  return (
    <div className="app">
      <aside>
        <div className="logo"><span>∴</span> LITERATURE</div>
        <div className="library-head">
          <span>我的研究库</span>
          <strong>{items.length}<small> 篇文献</small></strong>
        </div>
        <nav>
          <button className={view === 'library' ? 'active' : ''} onClick={() => setView('library')}>
            ▤ <span>所有文献</span><b>{items.length}</b>
          </button>
          <button className={view === 'schedule' ? 'active' : ''} onClick={() => setView('schedule')}>
            ◷ <span>阅读排期</span>
            <b>{conflicts.length ? `⚠${conflicts.length}` : `${occ[today]?.total || 0}/${DAILY_LIMIT}`}</b>
          </button>
          <button onClick={() => { setView('library'); setStatusFilter('待读'); }}>
            ▥ <span>待读</span><b>{items.filter((x) => x.status === '待读').length}</b>
          </button>
          <button onClick={() => { setView('library'); setStatusFilter('已读'); }}>
            ✓ <span>已读</span><b>{items.filter((x) => x.status === '已读').length}</b>
          </button>
        </nav>
        <div className="side-tags">
          <small>标签</small>
          {tags.slice(1, 5).map((t) => <button onClick={() => { setTag(t); setView('library'); }} key={t}># {t}</button>)}
        </div>
        <div className="side-foot">
          <small>每日上限 {DAILY_LIMIT} 分钟 · 修订链留档</small>
          <small>本地数据库 · 已同步</small>
        </div>
      </aside>

      <main>
        {view === 'library' ? (
          <>
            <header>
              <div>
                <span className="crumb">RESEARCH / LIBRARY</span>
                <h1>所有文献</h1>
              </div>
              <div className="actions">
                <button className="outline" onClick={download}>↓ 导出引用</button>
                <button className="primary" onClick={() => setShow(true)}>＋ 添加文献</button>
              </div>
            </header>
            <div className="toolbar">
              <div className="search">
                ⌕<input placeholder="搜索标题、作者或摘要…" value={query} onChange={(e) => setQuery(e.target.value)} />
                {query && <button onClick={() => setQuery('')}>×</button>}
              </div>
              <div className="tag-filter">
                {['全部', '待读', '阅读中', '已读'].map((s) => (
                  <button key={s} className={statusFilter === s ? 'on' : ''}
                    onClick={() => setStatusFilter(s)}>{s === '全部' ? '全部状态' : s}</button>
                ))}
                <span className="filter-sep" />
                {tags.map((t) => (
                  <button className={tag === t ? 'on' : ''} onClick={() => setTag(t)} key={t}>{t}</button>
                ))}
              </div>
            </div>
            <div className="body">
              <section className="paper-list">
                {filtered.map((p) => (
                  <button className={'paper ' + (selected === p.id ? 'selected' : '')} onClick={() => setSelected(p.id)} key={p.id}>
                    <div className="paper-year">{p.year}</div>
                    <div className="paper-copy">
                      <h3>{p.plan.locked ? '🔒 ' : ''}{p.title}</h3>
                      <p>{p.authors}</p>
                      <div>
                        <em className={`pri pri-${p.priority}`}>{p.priority}</em>
                        {p.tags.map((t) => <span key={t}>#{t}</span>)}
                        {p.plan.date && <span className="plan-chip">◷ {p.plan.date} · {p.plan.minutes}′</span>}
                      </div>
                    </div>
                    <small className={'status ' + p.status}>{p.status}</small>
                  </button>
                ))}
                {!filtered.length && <div className="no-result">没有找到匹配的文献</div>}
              </section>

              <section className="detail">
                {cur && (
                  <>
                    <div className="detail-top">
                      <span className="status reading">{cur.status}</span>
                      <button onClick={() => setNotice('已加入收藏')}>☆ 收藏</button>
                    </div>
                    <h2>{cur.title}</h2>
                    <p className="authors">{cur.authors}</p>
                    <div className="cite-actions">
                      <button onClick={bib}>▣ 复制引用</button>
                      {cur.status !== '阅读中' && <button onClick={beginReading}>▶ 开始阅读</button>}
                      {cur.status === '阅读中' && <button onClick={finishReading}>✓ 标记为已读</button>}
                      {cur.status === '已读' && (
                        <button onClick={() => { update('status', '待读'); setNotice('已退回待读'); }}>标记为待读</button>
                      )}
                    </div>

                    <div className="detail-section plan-section">
                      <h4>阅读排期 <span>SCHEDULE · 每日上限 {DAILY_LIMIT} 分钟</span></h4>
                      <div className="plan-row">
                        <div className="pri-picker">
                          <small>优先级</small>
                          <div>
                            {PRIORITIES.map((p) => (
                              <button key={p} className={cur.priority === p ? 'on' : ''}
                                onClick={() => { setItems(setPriority(items, cur.id, p)); }}>{p}</button>
                            ))}
                          </div>
                        </div>
                        <label>计划阅读日
                          <input type="date" value={planForm.date}
                            onChange={(e) => setPlanForm({ ...planForm, date: e.target.value })} />
                        </label>
                        <label>预计分钟
                          <input type="number" min="5" step="5" value={planForm.minutes}
                            onChange={(e) => setPlanForm({ ...planForm, minutes: e.target.value })} />
                        </label>
                      </div>
                      <label className="reason-label">修订说明{needReason && <b>（已读文献改排期必填，留档不可覆盖）</b>}
                        <input value={planForm.reason} placeholder="改期原因，将追加到修订链…"
                          onChange={(e) => setPlanForm({ ...planForm, reason: e.target.value })} />
                      </label>
                      {planForm.date && occ[planForm.date] && (
                        <div className="day-load">
                          {planForm.date} 已占 {occ[planForm.date].total}/{DAILY_LIMIT} 分钟
                          {occ[planForm.date].total + Number(planForm.minutes || 0) -
                            (cur.plan.date === planForm.date ? cur.plan.minutes : 0) > DAILY_LIMIT &&
                            <b> · 排入将超上限</b>}
                        </div>
                      )}
                      <div className="plan-actions">
                        <button className="primary" onClick={savePlan}>
                          {cur.plan.date ? '改期 / 保存排期' : '排入计划'}
                        </button>
                        {cur.plan.date && <button className="outline" onClick={cancelPlan}>取消排期</button>}
                        {cur.plan.locked && <span className="lock-hint">🔒 阅读中：当日位置已锁定，改期将释放原日期</span>}
                      </div>
                      {planError && <ConflictBox c={planError} />}
                    </div>

                    <div className="detail-section">
                      <h4>修订留档 <span>REVISIONS · 只追加，原记录不可覆盖</span></h4>
                      {cur.revisions.length === 0 && <p className="empty-rev">暂无修订记录</p>}
                      <div className="rev-chain">
                        {[...cur.revisions].reverse().map((r) => (
                          <div className="rev-item" key={r.id}>
                            <div className="rev-head">
                              <b>{r.from.date || '未排期'}·{r.from.minutes}′</b>
                              <i>→</i>
                              <b>{r.to.date || '取消排期'}·{r.to.minutes}′</b>
                              <span className="rev-rule">{r.rule}</span>
                            </div>
                            <p>{r.reason}</p>
                            <small>{fmtTime(r.at)}{r.released ? ` · 已释放 ${r.released.date} 的 ${r.released.minutes} 分钟` : ''}</small>
                          </div>
                        ))}
                      </div>
                    </div>

                    <div className="detail-section">
                      <h4>摘要 <span>ABSTRACT</span></h4>
                      <p>{cur.abstract}</p>
                    </div>
                    <div className="detail-section">
                      <h4>出版信息 <span>PUBLICATION</span></h4>
                      <div className="pub-grid">
                        <div><small>出版物</small><strong>{cur.venue}</strong></div>
                        <div><small>年份</small><strong>{cur.year}</strong></div>
                      </div>
                    </div>
                    <div className="detail-section">
                      <h4>引用文本 <span>BIBTEX / TEXT</span></h4>
                      <div className="cite-box">{cur.cite}<button onClick={bib}>复制</button></div>
                    </div>
                    <div className="detail-section">
                      <h4>我的笔记 <span>PRIVATE</span></h4>
                      <textarea className="notes" placeholder="记录你的阅读想法…"
                        value={cur.notes || ''} onChange={(e) => update('notes', e.target.value)} />
                    </div>
                  </>
                )}
              </section>
            </div>
          </>
        ) : (
          <>
            <header>
              <div>
                <span className="crumb">RESEARCH / SCHEDULE</span>
                <h1>阅读排期</h1>
              </div>
              <div className="actions">
                <span className="limit-chip">每日上限 {DAILY_LIMIT} 分钟</span>
                <button className="primary" onClick={() => setShow(true)}>＋ 添加文献</button>
              </div>
            </header>
            <div className="schedule-board">
              {conflicts.length > 0 && (
                <div className="conflict-banner">
                  <h3>⚠ 重载校验发现 {conflicts.length} 处冲突（日期占用 / 修订链不一致）</h3>
                  {conflicts.map((c, i) => <ConflictBox c={c} key={i} />)}
                </div>
              )}
              {boardDates.map((d) => {
                const day = occ[d];
                const total = day?.total || 0;
                const over = total > DAILY_LIMIT;
                const entries = [...(day?.entries || [])].sort(
                  (a, b) => PRI_WEIGHT[a.priority] - PRI_WEIGHT[b.priority] || a.title.localeCompare(b.title));
                return (
                  <div className={'day-card' + (over ? ' over' : '') + (d === today ? ' today' : '')} key={d}>
                    <div className="day-head">
                      <div>
                        <b>{d}</b> <span>{weekday(d)}{d === today ? ' · 今天' : ''}</span>
                      </div>
                      <div className="day-meter">
                        <small>{total}/{DAILY_LIMIT} 分钟{over && ` · 超时 ${total - DAILY_LIMIT} 分钟`}</small>
                        <div className="meter"><i style={{ width: `${Math.min(100, (total / DAILY_LIMIT) * 100)}%` }} /></div>
                      </div>
                    </div>
                    {entries.map((e) => (
                      <button className="day-entry" key={e.id} onClick={() => openPaper(e.id)}>
                        <em className={`pri pri-${e.priority}`}>{e.priority}</em>
                        <span className="entry-title">{e.locked ? '🔒 ' : ''}{e.title}</span>
                        <small className={'status ' + e.status}>{e.status}</small>
                        <b>{e.minutes}′</b>
                      </button>
                    ))}
                    {!entries.length && <div className="day-empty">未安排文献</div>}
                  </div>
                );
              })}
              <div className="day-card unscheduled">
                <div className="day-head"><div><b>未排期</b> <span>{unscheduled.length} 篇</span></div></div>
                {unscheduled.map((p) => (
                  <button className="day-entry" key={p.id} onClick={() => openPaper(p.id)}>
                    <em className={`pri pri-${p.priority}`}>{p.priority}</em>
                    <span className="entry-title">{p.title}</span>
                    <small className={'status ' + p.status}>{p.status}</small>
                    <b>{p.plan.minutes}′</b>
                  </button>
                ))}
                {!unscheduled.length && <div className="day-empty">全部文献均已排期</div>}
              </div>
            </div>
          </>
        )}
      </main>

      {show && (
        <div className="modal-bg">
          <div className="modal">
            <button className="close" onClick={() => setShow(false)}>×</button>
            <span className="crumb">NEW REFERENCE</span>
            <h2>添加一篇文献</h2>
            <label>标题<input value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} placeholder="论文或书籍标题" /></label>
            <label>作者<input value={form.authors} onChange={(e) => setForm({ ...form, authors: e.target.value })} /></label>
            <div className="two">
              <label>年份<input type="number" value={form.year} onChange={(e) => setForm({ ...form, year: e.target.value })} /></label>
              <label>出版物<input value={form.venue} onChange={(e) => setForm({ ...form, venue: e.target.value })} /></label>
            </div>
            <label>关键词<input value={form.tags} onChange={(e) => setForm({ ...form, tags: e.target.value })} placeholder="用逗号分隔" /></label>
            <label>摘要<textarea rows="3" value={form.abstract} onChange={(e) => setForm({ ...form, abstract: e.target.value })} /></label>
            <button className="primary full" onClick={add}>保存文献</button>
          </div>
        </div>
      )}
      {notice && <div className="toast">{notice}</div>}
    </div>
  );
}

createRoot(document.getElementById('root')).render(<App />);
