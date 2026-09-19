import React, { useEffect, useMemo, useState } from 'react';
import { createRoot } from 'react-dom/client';
import './styles.css';
import {
  DAILY_LIMIT, PRIORITIES, STORAGE_KEY,
  todayStr, dayLoad, scheduledOn,
  scheduleItem, releaseSlot, startReading, finishReading, setMeta,
  validateState, serialize, loadItems, normalizeItem,
} from './scheduler';

const WEEKDAYS = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];
const weekdayOf = d => WEEKDAYS[new Date(`${d}T00:00:00`).getDay()];
const fmtTime = iso => new Date(iso).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });

// 冲突卡片：日期 / 超时分钟 / 争用文献 / 触发规则
function ConflictBox({ conflict, onClose }) {
  return (
    <div className="conflict-box">
      <div className="conflict-head">
        <strong>⚠ 排期冲突 · 操作已阻止</strong>
        {onClose && <button onClick={onClose}>×</button>}
      </div>
      <dl>
        <div><dt>日期</dt><dd>{conflict.date || '—'}</dd></div>
        <div><dt>超时分钟</dt><dd>{conflict.overMinutes > 0 ? `+${conflict.overMinutes} 分钟` : '—'}</dd></div>
        <div><dt>争用文献</dt><dd>{conflict.contenders.length
          ? conflict.contenders.map(c => `${c.title}（${c.minutes}分钟）`).join('、')
          : '—'}</dd></div>
        <div><dt>触发规则</dt><dd>{conflict.rule}</dd></div>
      </dl>
    </div>
  );
}

// 详情页中的排期编辑器：优先级 / 预计分钟 / 计划阅读日 / 锁定与释放 / 修订留档
function ScheduleEditor({ item, items, run }) {
  const [dateDraft, setDateDraft] = useState(item.plan.date || todayStr());
  const [reason, setReason] = useState('');
  const [minutesDraft, setMinutesDraft] = useState(String(item.minutes));
  useEffect(() => setMinutesDraft(String(item.minutes)), [item.minutes]);
  const locked = item.plan.locked;

  const commitMinutes = () => {
    const m = Math.round(+minutesDraft);
    if (!Number.isFinite(m) || m <= 0 || m === item.minutes) { setMinutesDraft(String(item.minutes)); return; }
    if (!run(setMeta(items, item.id, { minutes: m }), `预计分钟已更新为 ${m}`)) {
      setMinutesDraft(String(item.minutes)); // 被 R1 阻止则还原
    }
  };
  const submitSchedule = () => {
    const ok = run(
      scheduleItem(items, item.id, dateDraft, { reason }),
      item.plan.date ? `已改期：${item.plan.date} → ${dateDraft}，修订记录已留档` : `已排入 ${dateDraft}`
    );
    if (ok) setReason('');
  };
  const release = () => {
    const ok = run(releaseSlot(items, item.id, { note: reason }), `已释放 ${item.plan.date}，原日期占用已解除`);
    if (ok) setReason('');
  };

  return (
    <div className="detail-section">
      <h4>阅读排期 <span>SCHEDULE · 单日上限 {DAILY_LIMIT} 分钟</span></h4>
      <div className="plan-grid">
        <div>
          <small>优先级</small>
          <div className="prio-row">
            {PRIORITIES.map(p => (
              <button key={p} className={item.priority === p ? 'on' : ''}
                onClick={() => run(setMeta(items, item.id, { priority: p }), `优先级已设为「${p}」`)}>{p}</button>
            ))}
          </div>
        </div>
        <div>
          <small>预计分钟</small>
          <input className="mins-input" type="number" min="5" step="5" value={minutesDraft}
            onChange={e => setMinutesDraft(e.target.value)}
            onBlur={commitMinutes}
            onKeyDown={e => e.key === 'Enter' && commitMinutes()} />
        </div>
      </div>

      {locked ? (
        <div className="lock-banner">
          <span>🔒 阅读中 · 当日位置已锁定（{item.plan.date}），改期必须先释放原日期。</span>
          <button onClick={release}>释放原日期</button>
        </div>
      ) : (
        <div className="date-row">
          <input type="date" value={dateDraft} onChange={e => setDateDraft(e.target.value)} />
          <button className="primary" onClick={submitSchedule}>
            {item.plan.date ? `改期（当前 ${item.plan.date}）` : '排入日期'}
          </button>
          {item.plan.date && <button className="outline" onClick={release}>释放</button>}
        </div>
      )}

      {item.status === '已读' && (
        <textarea className="reason" rows="2"
          placeholder="修订说明（已读文献改排期必填，将永久留档，原记录不可覆盖）…"
          value={reason} onChange={e => setReason(e.target.value)} />
      )}

      <div className="loop-actions">
        {item.status === '待读' && item.plan.date && !locked && (
          <button className="primary" onClick={() => run(startReading(items, item.id), '已开始阅读，当日位置已锁定')}>▶ 开始阅读</button>
        )}
        {item.status === '阅读中' && !locked && item.plan.date && (
          <button className="primary" onClick={() => run(startReading(items, item.id), '已补锁当日位置')}>🔒 补锁当日位置</button>
        )}
        {item.status === '阅读中' && (
          <button className="primary" onClick={() => run(finishReading(items, item.id), '已完成阅读')}>✓ 完成阅读</button>
        )}
        {item.status === '待读' && !item.plan.date && <small className="hint">尚未排期：选择计划阅读日后排入。</small>}
        {item.status === '已读' && <small className="hint">已读文献改排期需填写修订说明，原记录不可覆盖。</small>}
      </div>

      {item.revisions.length > 0 && (
        <div className="rev-list">
          <small>修订留档（{item.revisions.length} 条 · 只增不改）</small>
          {item.revisions.slice().reverse().map(r => (
            <div className="rev" key={r.seq}>
              <small>#{r.seq} · {fmtTime(r.at)} · {r.type === 'release' ? '释放日期' : '改期'} · 当时状态「{r.statusAt}」</small>
              <p>{r.fromDate || '未排期'} → {r.toDate || '未排期'} ｜ {r.reason}</p>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// 阅读排期视图：按日期分组的占用看板 + 一致性校验结果
function ScheduleView({ items, conflicts, onSelect, run, recheck }) {
  const today = todayStr();
  const dates = useMemo(() => [...new Set(items.map(p => p.plan.date).filter(Boolean))].sort(), [items]);
  const unscheduled = items.filter(p => !p.plan.date);

  const row = p => (
    <div className="sch-row" key={p.id}>
      <span className={`prio prio-${p.priority}`}>{p.priority}</span>
      <button className="sch-main" onClick={() => onSelect(p.id)}>
        <strong>{p.title}</strong>
        <small>{p.authors}</small>
      </button>
      <span className="mins">{p.minutes}′</span>
      <span className={`status ${p.status}`}>{p.plan.locked ? '🔒 ' : ''}{p.status}</span>
      <span className="sch-actions">
        {p.status === '待读' && p.plan.date && (
          <button onClick={() => run(startReading(items, p.id), '已开始阅读，当日位置已锁定')}>开始</button>
        )}
        {p.status === '阅读中' && (
          <>
            <button onClick={() => run(finishReading(items, p.id), '已完成阅读')}>完成</button>
            <button onClick={() => run(releaseSlot(items, p.id), `已释放 ${p.plan.date}`)}>释放</button>
          </>
        )}
        {!p.plan.date && <button onClick={() => onSelect(p.id)}>去排期</button>}
      </span>
    </div>
  );

  return (
    <div className="schedule">
      <div className="sch-summary">
        <div><small>已排期</small><strong>{items.length - unscheduled.length}<em> / {items.length} 篇</em></strong></div>
        <div><small>今日占用</small><strong>{dayLoad(items, today)}<em> / {DAILY_LIMIT} 分钟</em></strong></div>
        <div><small>校验冲突</small><strong className={conflicts.length ? 'bad' : ''}>{conflicts.length}<em> 处</em></strong></div>
        <button className="outline" onClick={recheck}>↻ 重新校验</button>
      </div>

      {conflicts.length > 0 && (
        <div className="conflict-panel">
          <h3>⚠ 一致性校验发现 {conflicts.length} 处冲突（重载后文献 / 日期占用 / 修订链不一致）</h3>
          {conflicts.map((c, i) => <ConflictBox key={i} conflict={c} />)}
        </div>
      )}

      {dates.map(date => {
        const rows = scheduledOn(items, date);
        const load = rows.reduce((s, p) => s + p.minutes, 0);
        const over = load - DAILY_LIMIT;
        return (
          <section className={`day-card${over > 0 ? ' over' : ''}${date === today ? ' today' : ''}`} key={date}>
            <header>
              <div className="day-title">
                <strong>{date}</strong><span>{weekdayOf(date)}</span>
                {date === today && <em>今天</em>}
              </div>
              <div className="day-load">{load}/{DAILY_LIMIT} 分钟{over > 0 && <b>超时 {over} 分钟</b>}</div>
            </header>
            <div className="bar"><i style={{ width: `${Math.min(100, (load / DAILY_LIMIT) * 100)}%` }} /></div>
            {rows.map(row)}
          </section>
        );
      })}

      <section className="day-card muted">
        <header><div className="day-title"><strong>未排期</strong><span>{unscheduled.length} 篇</span></div></header>
        {unscheduled.map(row)}
        {!unscheduled.length && <p className="empty-hint">全部文献均已排期 ✓</p>}
      </section>
    </div>
  );
}

function App() {
  const [initial] = useState(() => loadItems(localStorage));
  const [items, setItems] = useState(initial);
  const [view, setView] = useState('library');
  const [selected, setSelected] = useState(initial[0]?.id ?? null);
  const [query, setQuery] = useState('');
  const [tag, setTag] = useState('全部');
  const [statusFilter, setStatusFilter] = useState('全部');
  const [show, setShow] = useState(false);
  const [notice, setNotice] = useState('');
  const [conflict, setConflict] = useState(null);                 // 本次被阻止的操作
  const [loadConflicts, setLoadConflicts] = useState(() => validateState(initial)); // 重载一致性校验
  const [form, setForm] = useState({ title: '', authors: '', year: '2024', venue: '', abstract: '', tags: '' });

  // 持久化：任何变更都写回，重新加载后据此恢复
  useEffect(() => { localStorage.setItem(STORAGE_KEY, serialize(items)); }, [items]);
  // 实时复验：文献、日期占用、修订链保持一致
  useEffect(() => { setLoadConflicts(validateState(items)); }, [items]);
  useEffect(() => {
    if (!notice) return undefined;
    const timer = setTimeout(() => setNotice(''), 2600);
    return () => clearTimeout(timer);
  }, [notice]);

  // 所有闭环操作的统一入口：被阻止 → 展示冲突；成功 → 落库并提示
  const run = (result, okMsg) => {
    if (!result.ok) { setConflict(result.conflict); return false; }
    if (result.changed !== false) setItems(result.items);
    setConflict(null);
    if (okMsg) setNotice(okMsg);
    return true;
  };
  const recheck = () => {
    const found = validateState(items);
    setLoadConflicts(found);
    setNotice(found.length ? `校验发现 ${found.length} 处冲突` : '校验通过：文献、日期占用与修订链一致');
  };

  const tags = ['全部', ...new Set(items.flatMap(x => x.tags))];
  const filtered = useMemo(() => items.filter(x =>
    (statusFilter === '全部' || x.status === statusFilter) &&
    (tag === '全部' || x.tags.includes(tag)) &&
    `${x.title}${x.authors}${x.abstract}`.toLowerCase().includes(query.toLowerCase())
  ), [items, tag, query, statusFilter]);
  const cur = items.find(x => x.id === selected) || items[0];
  const update = (k, v) => setItems(items.map(x => (x.id === cur.id ? { ...x, [k]: v } : x)));

  const add = () => {
    if (!form.title) return;
    const p = normalizeItem({
      ...form, id: Date.now(), year: +form.year,
      tags: form.tags.split(',').map(x => x.trim()).filter(Boolean),
      status: '待读', priority: '中', minutes: 30,
      plan: { date: null, locked: false, startedAt: null }, revisions: [],
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
    a.href = URL.createObjectURL(new Blob([items.map(x => x.cite).join('\n')], { type: 'text/plain' }));
    a.download = 'references.txt';
    a.click();
    setNotice('引用列表已导出');
  };
  const openDetail = id => { setSelected(id); setView('library'); };
  const navBtn = (v, s) => () => { setView(v); setStatusFilter(s); };

  return (
    <div className="app">
      <aside>
        <div className="logo"><span>∴</span> LITERATURE</div>
        <div className="library-head"><span>我的研究库</span><strong>{items.length}<small> 篇文献</small></strong></div>
        <nav>
          <button className={view === 'library' && statusFilter === '全部' ? 'active' : ''} onClick={navBtn('library', '全部')}>▤ <span>所有文献</span><b>{items.length}</b></button>
          <button className={view === 'schedule' ? 'active' : ''} onClick={navBtn('schedule', '全部')}>◷ <span>阅读排期</span><b>{items.filter(p => p.plan.date).length}</b></button>
          <button className={view === 'library' && statusFilter === '待读' ? 'active' : ''} onClick={navBtn('library', '待读')}>▥ <span>待读</span><b>{items.filter(x => x.status === '待读').length}</b></button>
          <button className={view === 'library' && statusFilter === '已读' ? 'active' : ''} onClick={navBtn('library', '已读')}>✓ <span>已读</span><b>{items.filter(x => x.status === '已读').length}</b></button>
        </nav>
        <div className="side-tags"><small>标签</small>{tags.slice(1, 5).map(t => <button onClick={() => { setTag(t); setView('library'); }} key={t}># {t}</button>)}</div>
        <div className="side-foot"><small>本地数据库 · 排期闭环已启用</small></div>
      </aside>

      <main>
        {view === 'library' ? (
          <>
            <header>
              <div><span className="crumb">RESEARCH / LIBRARY</span><h1>{statusFilter === '全部' ? '所有文献' : statusFilter}</h1></div>
              <div className="actions">
                <button className="outline" onClick={download}>↓ 导出引用</button>
                <button className="primary" onClick={() => setShow(true)}>＋ 添加文献</button>
              </div>
            </header>
            <div className="toolbar">
              <div className="search">⌕<input placeholder="搜索标题、作者或摘要…" value={query} onChange={e => setQuery(e.target.value)} />{query && <button onClick={() => setQuery('')}>×</button>}</div>
              <div className="tag-filter">{tags.map(t => <button className={tag === t ? 'on' : ''} onClick={() => setTag(t)} key={t}>{t}</button>)}</div>
            </div>
            <div className="body">
              <section className="paper-list">
                {filtered.map(p => (
                  <button className={`paper ${selected === p.id ? 'selected' : ''}`} onClick={() => setSelected(p.id)} key={p.id}>
                    <div className="paper-year">{p.year}</div>
                    <div className="paper-copy">
                      <h3>{p.title}</h3>
                      <p>{p.authors}</p>
                      <div>
                        {p.tags.map(t => <span key={t}>#{t}</span>)}
                        {p.plan.date && <span className="plan-chip">◷ {p.plan.date} · {p.minutes}′ · {p.priority}</span>}
                      </div>
                    </div>
                    <small className={`status ${p.status}`}>{p.plan.locked ? '🔒 ' : ''}{p.status}</small>
                  </button>
                ))}
                {!filtered.length && <div className="no-result">没有找到匹配的文献</div>}
              </section>
              <section className="detail">
                {cur && (
                  <>
                    <div className="detail-top"><span className="status reading">{cur.status}</span><button onClick={() => setNotice('已加入收藏')}>☆ 收藏</button></div>
                    <h2>{cur.title}</h2>
                    <p className="authors">{cur.authors}</p>
                    <div className="cite-actions"><button onClick={bib}>▣ 复制引用</button></div>
                    <ScheduleEditor key={cur.id} item={cur} items={items} run={run} />
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
                      <textarea className="notes" placeholder="记录你的阅读想法…" value={cur.notes || ''} onChange={e => update('notes', e.target.value)} />
                    </div>
                  </>
                )}
              </section>
            </div>
          </>
        ) : (
          <>
            <header>
              <div><span className="crumb">RESEARCH / SCHEDULE</span><h1>阅读排期</h1></div>
              <div className="actions"><button className="outline" onClick={recheck}>↻ 一致性校验</button></div>
            </header>
            <ScheduleView items={items} conflicts={loadConflicts} onSelect={openDetail} run={run} recheck={recheck} />
          </>
        )}
      </main>

      {show && (
        <div className="modal-bg">
          <div className="modal">
            <button className="close" onClick={() => setShow(false)}>×</button>
            <span className="crumb">NEW REFERENCE</span>
            <h2>添加一篇文献</h2>
            <label>标题<input value={form.title} onChange={e => setForm({ ...form, title: e.target.value })} placeholder="论文或书籍标题" /></label>
            <label>作者<input value={form.authors} onChange={e => setForm({ ...form, authors: e.target.value })} /></label>
            <div className="two">
              <label>年份<input type="number" value={form.year} onChange={e => setForm({ ...form, year: e.target.value })} /></label>
              <label>出版物<input value={form.venue} onChange={e => setForm({ ...form, venue: e.target.value })} /></label>
            </div>
            <label>关键词<input value={form.tags} onChange={e => setForm({ ...form, tags: e.target.value })} placeholder="用逗号分隔" /></label>
            <label>摘要<textarea rows="3" value={form.abstract} onChange={e => setForm({ ...form, abstract: e.target.value })} /></label>
            <button className="primary full" onClick={add}>保存文献</button>
          </div>
        </div>
      )}

      {conflict && <div className="conflict-float"><ConflictBox conflict={conflict} onClose={() => setConflict(null)} /></div>}
      {notice && <div className="toast">{notice}</div>}
    </div>
  );
}

createRoot(document.getElementById('root')).render(<App />);
