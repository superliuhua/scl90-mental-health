/* ============================================================
   SCL-90 心理健康测评 · 应用逻辑（本地存储 / 计分 / 渲染工具）
   ============================================================ */

/* ---------- 本地存储 ---------- */
const Store = {
  _ns: 'scl90__',
  get(key, fallback) { try { const v = window.localStorage.getItem(this._ns + key); return v ? JSON.parse(v) : fallback; } catch (_) { return fallback; } },
  set(key, val) { try { window.localStorage.setItem(this._ns + key, JSON.stringify(val)); } catch (_) {} },
  del(key) { try { window.localStorage.removeItem(this._ns + key); } catch (_) {} },
  activation: { get: () => Store.get('activation', null), set: (a) => Store.set('activation', a), clear: () => Store.del('activation') },
  progress:   { get: () => Store.get('progress', null), set: (p) => Store.set('progress', p), clear: () => Store.del('progress') },
  records:    { get: () => Store.get('records', []), set: (r) => Store.set('records', r), clear: () => Store.del('records') }
};

/* ---------- 计分 ---------- */
function gradeOf(avg) {
  if (avg < 2.0) return 'normal';
  if (avg < 3.0) return 'mild';
  if (avg < 4.0) return 'moderate';
  return 'severe';
}
const GRADE_LABEL = { normal: '正常', mild: '轻度', moderate: '中度', severe: '重度' };
function severityLabel(totalAvg) { return GRADE_LABEL[gradeOf(totalAvg)] + '症状'; }

/* 计算一份完整报告 */
function computeReport(answers) {
  const total = Object.values(answers).reduce((s, v) => s + Number(v) || s, 0);
  const totalAvg = +(total / 90).toFixed(2);
  const positiveItems = [];
  Object.entries(answers).forEach(([q, v]) => { if (v >= 2) positiveItems.push(v); });
  const positiveCount = positiveItems.length;
  const positiveAvg = positiveCount ? +(positiveItems.reduce((a, b) => a + b, 0) / positiveCount).toFixed(2) : 0;

  const factors = DIMENSIONS.map(dim => {
    const vals = dim.items.map(q => Number(answers[q]) || 0);
    const raw = vals.reduce((a, b) => a + b, 0);
    const avg = +(raw / dim.items.length).toFixed(2);
    return {
      key: dim.key, cn: dim.cn, short: dim.short, name: dim.name,
      count: dim.items.length, raw, avg, grade: gradeOf(avg)
    };
  });

  let topFactor = factors[0];
  ALL_FACTORS.forEach(f => { if (f.avg > topFactor.avg) topFactor = f; });

  // 危机分级
  let crisisLevel = 'none';
  const forcedByFactor = factors.some(f => f.avg >= 4.0);
  const q15 = Number(answers[15]) || 0; // 第 15 题「想结束自己的生命」
  let forced = forcedByFactor || q15 >= 3;
  let strong = factors.some(f => f.avg >= 3.0) || total > 160;
  if (forced) crisisLevel = 'forced'; else if (strong) crisisLevel = 'strong';

  const triggers = [];
  factors.forEach(f => { if (f.avg >= 2.0) triggers.push(`${f.short}因子 ${f.avg.toFixed(1)} 分（${GRADE_LABEL[f.grade]}）`); });
  if (q15 >= 1) triggers.push(`第 15 题「想结束自己的生命」得分 ${q15} 分（${OPTIONS[q15 - 1].label}）`);

  return {
    total, totalAvg, positiveCount, positiveAvg, factors, topFactor, crisisLevel,
    forcedByFactor, q15, triggers, severity: GRADE_LABEL[gradeOf(totalAvg)],
    created: Date.now()
  };
}

/* ---------- 格式化 ---------- */
function pad(n) { return n < 10 ? '0' + n : '' + n; }
function fmtDate(ts) {
  const d = new Date(ts);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}
const WEEKDAY = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];
function fmtWeekday(ts) { return WEEKDAY[new Date(ts).getDay()]; }
function fmtDateTime(ts) {
  const d = new Date(ts);
  return `${fmtDate(ts)} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/* ---------- UI 组件：Toast / 确认弹窗 / 键盘页签 ---------- */
let toastTimer;
function showToast(msg, variant) {
  let el = document.querySelector('.toast');
  if (!el) { el = document.createElement('div'); el.className = 'toast'; document.body.appendChild(el); }
  el.className = 'toast ' + (variant || '');
  el.textContent = msg;
  requestAnimationFrame(() => el.classList.add('show'));
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.classList.remove('show'); }, 2400);
}

/* 确认弹窗：返回 Promise<boolean>。danger=true 时确认键为警示色 */
function confirmDialog({ title, text, confirmText = '确认', cancelText = '取消', danger = false }) {
  return new Promise(resolve => {
    const lastFocus = document.activeElement;
    const mask = document.createElement('div');
    mask.className = 'modal-mask';
    mask.setAttribute('role', 'presentation');
    mask.innerHTML = `
      <div class="modal confirm-modal" role="alertdialog" aria-modal="true" aria-label="${title}">
        <h3 class="confirm-modal__title">${title}</h3>
        ${text ? `<p class="confirm-modal__text">${text}</p>` : ''}
        <div class="confirm-modal__actions">
          <button class="btn btn--secondary" data-act="cancel" type="button">${cancelText}</button>
          <button class="btn ${danger ? 'btn--danger' : 'btn--primary'}" data-act="ok" type="button">${confirmText}</button>
        </div>
      </div>`;
    document.body.appendChild(mask);
    const okBtn = mask.querySelector('[data-act="ok"]');
    const dismiss = (val) => { mask.remove(); document.dispatchEvent(new Event('focusrestore')); (lastFocus && lastFocus.focus && lastFocus.focus()); resolve(val); };
    mask.querySelector('[data-act="cancel"]').onclick = () => dismiss(false);
    okBtn.onclick = () => dismiss(true);
    mask.addEventListener('click', e => { if (e.target === mask) dismiss(false); });
    okBtn.focus();
  });
}

/* 页签组：加 ARIA roles + 方向键导航。container 选中 tabbar，cb(key) 渲染内容，activeKey 指定初始激活 */
function initTabs(container, attr, cb, activeKey) {
  const tabs = Array.from(container.querySelectorAll('.tab'));
  if (!tabs.length) return cb && cb(tabs[0] && tabs[0].dataset[attr]);
  container.setAttribute('role', 'tablist');
  tabs.forEach(t => { t.setAttribute('role', 'tab'); t.setAttribute('aria-selected', 'false'); });
  let idx = 0;
  const set = (i) => {
    idx = Math.max(0, Math.min(tabs.length - 1, i));
    tabs.forEach((t, n) => t.classList.toggle('active', n === idx));
    tabs.forEach((t, n) => t.setAttribute('aria-selected', n === idx));
    tabs[idx].focus();
    cb && cb(tabs[idx].dataset[attr]);
  };
  tabs.forEach((t, n) => {
    t.tabIndex = n === 0 ? 0 : -1;
    t.addEventListener('click', () => set(n));
    t.addEventListener('keydown', e => {
      let next = null;
      if (e.key === 'ArrowRight' || e.key === 'ArrowDown') next = idx + 1;
      else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') next = idx - 1;
      else if (e.key === 'Home') next = 0;
      else if (e.key === 'End') next = tabs.length - 1;
      if (next !== null) { e.preventDefault(); set(next); }
    });
  });
  let init = tabs.findIndex(t => t.classList.contains('active'));
  if (activeKey) { const k = tabs.findIndex(t => t.dataset[attr] === activeKey); if (k >= 0) init = k; }
  idx = init >= 0 ? init : 0;
  tabs.forEach((t, n) => t.setAttribute('aria-selected', n === idx));
  tabs[idx].setAttribute('tabindex', '0');
  return { set, show: () => cb && cb(tabs[idx].dataset[attr]) };
}

/* ---------- 激活码校验（本地演示逻辑） ---------- */
const DEMO_CODES = { 'ORD-8X3K': 'valid', 'ORD-5M2P': 'expired' };
function validateCode(code) {
  const c = (code || '').trim().toUpperCase();
  if (c === 'EXPIRED' || c === 'ORD-5M2P') return { ok: false, reason: 'expired', order: 'ORD-20260820-5M2P', created: '2026年8月20日' };
  if (c === 'VALID' || c === 'ORD-8X3K') return { ok: true, order: 'ORD-20260917-8X3K' };
  return { ok: false, reason: 'invalid' };
}
const VALIDITY_DAYS = 24;
function activationExpire(order) { return Date.now() + VALIDITY_DAYS * 24 * 3600 * 1000; }

/* 渲染激活页：根据激活状态显示 有效进入 / 欢迎回来 / 失效 */
function renderActivation() {
  const wrap = document.getElementById('activation-root');
  if (!wrap) return;
  const query = new URLSearchParams(location.search);
  let state = query.get('s'); // 调试/演示可强制指定：valid | reopen | expired | entry
  const act = Store.activation.get();

  if (['valid', 'reopen', 'expired', 'entry'].indexOf(state) === -1) {
    // 根据本地激活记录推导
    if (!act) state = 'entry';
    else if (act.expireAt && act.expireAt < Date.now()) state = 'expired';
    else if (act.used) state = 'reopen';
    else state = 'valid';
  }

  const records = Store.records.get();
  const last = records[0];
  const remainText = () => {
    if (!act || !act.expireAt) return '';
    const left = act.expireAt - Date.now();
    const days = Math.floor(left / 86400000);
    const hours = Math.floor((left % 86400000) / 3600000);
    return `剩余 ${days} 天 ${hours} 小时`;
  };

  if (state === 'valid') {
    wrap.innerHTML = `
      <section class="brand-section">
        <span class="brand-tag">SCL-90 症状自评量表</span>
        <h2 class="brand-title">心理健康测评</h2>
        <p class="brand-subtitle">专业 · 匿名 · 完整 90 题自评报告</p>
      </section>
      <section class="activation-card">
        <div class="activation-header">
          <div class="check-icon"><svg viewBox="0 0 24 24"><polyline points="5 12 10 17 19 8"/></svg></div>
          <span class="activation-title">激活成功</span>
        </div>
        <div class="activation-info">
          <div class="info-row"><span class="info-label">订单号</span><span class="info-value">${(act||{}).order || 'ORD-20260917-8X3K'}</span></div>
          <div class="info-row"><span class="info-label">有效期</span><span class="info-value validity">${remainText() || '剩余 24 天'}</span></div>
        </div>
        <p class="activation-note">激活后 24 天内可无限次测评与查看报告</p>
      </section>
      <section class="instructions" aria-label="使用说明">
        <div class="instruction-item"><span class="instruction-dot"></span><span>约 15 分钟完成 90 题</span></div>
        <div class="instruction-item"><span class="instruction-dot"></span><span>匿名作答，结果仅保存在本地</span></div>
        <div class="instruction-item"><span class="instruction-dot"></span><span>九大维度完整解读报告</span></div>
      </section>
      <button class="btn-primary" id="startBtn" type="button">开始测评</button>
      <p class="risk-notice">本测评结果仅作自我参考，不能替代专业医疗诊断</p>`;
    document.getElementById('startBtn').onclick = () => { Store.activation.set({ order: 'ORD-20260917-8X3K', expireAt: activationExpire('ORD-20260917-8X3K'), used: true }); location.href = 'home.html'; };
    return;
  }

  if (state === 'reopen') {
    wrap.innerHTML = `
      <section class="brand-section">
        <div class="brand-tag">SCL-90 症状自评量表</div>
        <h1 class="brand-title">欢迎回来</h1>
        <p class="brand-subtitle">该链接已激活，可继续使用</p>
      </section>
      <section class="status-card">
        <div class="status-header">
          <div class="status-icon-circle">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
              <circle cx="12" cy="12" r="10"></circle><line x1="12" y1="16" x2="12" y2="12"></line><line x1="12" y1="8" x2="12.01" y2="8"></line>
            </svg>
          </div>
          <span class="status-text">链接已激活</span>
        </div>
        <div class="status-info">
          <div class="status-row"><span class="status-label">订单号</span><span class="status-value">${(act||{}).order || 'ORD-20260917-8X3K'}</span></div>
          <div class="status-row"><span class="status-label">剩余有效期</span><span class="status-value validity">${remainText() || '剩余 24 天'}</span></div>
        </div>
        <p class="status-tip">您已激活该链接，可直接进入测评</p>
      </section>
      ${last ? `<section class="history-section">
        <h2 class="history-title">上次测评记录</h2>
        <div class="history-item" id="lastRecord">
          <div class="history-left">
            <span class="history-date">${fmtDate(last.created)}</span>
            <span class="history-score"><strong>${last.total}</strong>分</span>
            <span class="history-tag ${last.crisisLevel==='none'?'normal':last.crisisLevel==='forced'?'severe':'moderate'}">${last.severity}</span>
          </div>
          <div class="history-right"><span>查看报告</span><span class="history-arrow">›</span></div>
        </div>
      </section>` : ''}
      <button class="btn-primary" id="continueBtn" type="button">继续测评</button>
      <a class="secondary-link" id="allRecords" href="history.html">查看我的所有记录</a>`;
    const btn = document.getElementById('continueBtn');
    btn.onclick = () => {
      const p = Store.progress.get();
      location.href = (p && Object.keys(p.answers).length >= 1) ? 'quiz.html' : 'home.html';
    };
    const lr = document.getElementById('lastRecord');
    if (lr) lr.onclick = () => location.href = 'report.html?id=' + last.id;
    return;
  }

  if (state === 'expired') {
    wrap.innerHTML = `
      <section class="brand-section">
        <span class="brand-tag">SCL-90 症状自评量表</span>
        <h2 class="brand-title">链接已失效</h2>
        <p class="brand-subtitle">该激活链接已超过有效期</p>
      </section>
      <section class="status-card">
        <div class="status-header">
          <div class="status-icon">
            <svg viewBox="0 0 24 24" fill="none"><path d="M12 8v5" stroke="#A86B6B" stroke-width="2" stroke-linecap="round"/><circle cx="12" cy="16" r="1" fill="#A86B6B"/><circle cx="12" cy="12" r="9" stroke="#A86B6B" stroke-width="2"/></svg>
          </div>
          <span class="status-text">链接已失效</span>
        </div>
        <p class="status-reason">该链接生成于 2026年8月20日，已超过 24 天有效期</p>
        <div class="order-number">ORD-20260820-5M2P</div>
      </section>
      <section class="guide-section">
        <p class="guide-text">如需继续测评，请重新购买获取新的激活链接</p>
        <button class="btn btn--secondary" id="supportBtn" style="width:100%">联系客服</button>
      </section>
      <button class="btn-disabled" disabled>无法进入</button>
      <footer class="footer-tip">如有疑问请通过购买渠道联系客服</footer>`;
    document.getElementById('supportBtn').onclick = () => showToast('演示环境：请联系你购买测评链接的商家渠道获取有效激活链接。');
    return;
  }

  // state === 'entry'：激活入口（输入激活码）
  wrap.innerHTML = `
    <section class="brand-section">
      <span class="brand-tag">SCL-90 症状自评量表</span>
      <h2 class="brand-title">心理健康测评</h2>
      <p class="brand-subtitle">专业 · 匿名 · 完整 90 题自评报告</p>
    </section>
    <form class="entry-form" id="entryForm">
      <label class="entry-label" for="codeInput">请输入激活码（购买链接后自动发货）</label>
      <input class="entry-field" id="codeInput" type="text" placeholder="例如：ORD-8X3K" autocomplete="off" />
      <div class="demo-chip-row">
        <span class="demo-chip" data-code="ORD-8X3K">有效码 · ORD-8X3K</span>
        <span class="demo-chip" data-code="EXPIRED">失效码</span>
      </div>
      <div class="demo-chip-row">
        <button class="btn-primary" id="activateBtn" style="margin-top:6px" type="submit">激活并开始测评</button>
      </div>
    </form>
    <section class="instructions" aria-label="使用说明">
      <div class="instruction-item"><span class="instruction-dot"></span><span>约 15 分钟完成 90 题</span></div>
      <div class="instruction-item"><span class="instruction-dot"></span><span>匿名作答，结果仅保存在本地</span></div>
      <div class="instruction-item"><span class="instruction-dot"></span><span>九大维度完整解读报告</span></div>
    </section>
    <button class="btn btn--secondary" type="button" id="previewBtn" style="width:100%">预览三种链接状态</button>
    <p class="entry-note">· 本演示应用为纯前端 Demo，激活逻辑以本地模拟实现，不采集任何个人信息<br>· 本测评结果仅作自我参考，不能替代专业医疗诊断</p>`;

  const form = document.getElementById('entryForm');
  const activate = () => {
    const input = document.getElementById('codeInput');
    const res = validateCode(input.value);
    if (!res.ok) {
      if (res.reason === 'expired') { location.href = 'index.html?s=expired'; return; }
      input.focus(); input.select();
      showToast('激活码无效，请核对后重试', 'brand'); return;
    }
    Store.activation.set({ order: res.order, expireAt: activationExpire(res.order), used: false });
    location.href = 'index.html?s=valid';
  };
  form.addEventListener('submit', e => { e.preventDefault(); activate(); });
  document.getElementById('previewBtn').onclick = () => { location.href = 'index.html?s=reopen'; };
  wrap.querySelectorAll('.demo-chip').forEach(chip => {
    chip.onclick = () => {
      const code = chip.getAttribute('data-code');
      const input = document.getElementById('codeInput');
      input.value = code;
      const res = validateCode(code);
      if (!res.ok && res.reason === 'expired') { location.href = 'index.html?s=expired'; return; }
      Store.activation.set({ order: res.order, expireAt: activationExpire(res.order), used: false });
      location.href = 'index.html?s=valid';
    };
  });
}

/* ---------- 首页（介绍 / 适合人群 / 九大维度） ---------- */
const HOME_VIEWS = {
  intro: `
    <section class="hero">
      <span class="hero-tag">SCL-90 症状自评量表</span>
      <h2 class="hero-title">了解你的心理状态</h2>
      <p class="hero-subtitle">用 90 道题，和自己好好聊一聊</p>
      <div class="hero-badges">
        <span class="hero-badge">约 15 分钟</span><span class="hero-badge">90 道题目</span><span class="hero-badge">匿名测评</span>
      </div>
    </section>
    <section class="intro-card">
      <h3 class="intro-card-title">关于 SCL-90</h3>
      <div class="intro-card-text">
        <p>SCL-90（症状自评量表）是目前全球应用最广泛的心理健康测评工具之一，由德若伽提斯（L.R.Derogatis）于 1975 年编制。</p>
        <p>量表包含 90 个自评项目，从躯体化、强迫症状、人际关系敏感、抑郁、焦虑、敌对、恐怖、偏执、精神病性等九个维度，全面反映你的心理状态。</p>
        <p>它不是诊断工具，而是一面镜子——帮助你看见当下的自己，觉察情绪的起伏与内心的声音。</p>
      </div>
    </section>
    <div class="safety-bar"><span class="icon">🔒</span><span>免登录 · 匿名作答 · 本地保存</span></div>`,
  who: `
    <section class="section-header">
      <p class="section-subtitle">适合人群</p>
      <h2 class="section-title">你可能需要这份测评，如果……</h2>
      <p class="section-desc">以下任何一种情况持续一段时间，都值得花 15 分钟认真了解一下自己。</p>
    </section>
    <section class="card-list">
      <article class="person-card">
        <div class="card-icon icon-green">💼</div>
        <div class="card-content"><h3 class="card-title">长期压力大的上班族</h3><p class="card-desc">经常感到焦虑、烦躁、睡眠差，想确认是不是只是压力大</p></div>
      </article>
      <article class="person-card">
        <div class="card-icon icon-blue">🔍</div>
        <div class="card-content"><h3 class="card-title">想深入了解自我的人</h3><p class="card-desc">无明显困扰，但有自我探索意愿，想全面认识自己的心理特质</p></div>
      </article>
      <article class="person-card">
        <div class="card-icon icon-pink">💗</div>
        <div class="card-content"><h3 class="card-title">关注亲友心理健康的人</h3><p class="card-desc">替家人朋友做初筛，想知道如何更好地帮助他们</p></div>
      </article>
      <article class="person-card">
        <div class="card-icon icon-gold">🌱</div>
        <div class="card-content"><h3 class="card-title">咨询/就医前的探索者</h3><p class="card-desc">身体难受但检查无异常、社恐不愿面对面，想先匿名自测摸清方向</p></div>
      </article>
    </section>
    <aside class="tip-box"><span class="tip-icon">💡</span><span class="tip-text">14 岁以下建议在监护人陪同下使用</span></aside>`,
  dims: `
    <section class="section-header">
      <h2 class="section-title">九大测评维度</h2>
      <p class="section-desc">SCL-90 从九个方面全面评估你的心理健康状态，每个维度对应不同的心理症状群。</p>
    </section>
    <section class="dim-list">
      ${ALL_FACTORS.map((d, i) => `
        <details class="dim-item">
          <summary>
            <div class="dim-left"><span class="dim-index">${'①②③④⑤⑥⑦⑧⑨'[i]}</span><span class="dim-name">${d.name}</span></div>
            <span class="dim-arrow">˅</span>
          </summary>
          <div class="dim-detail">${INTERPRETATION[d.key].def}</div>
        </details>`).join('')}
    </section>
    <p class="extra-note">* 另含睡眠/饮食等 7 项附加题目</p>`
};

function renderHome() {
  const wrap = document.getElementById('home-content');
  const tabbar = document.getElementById('home-tabbar');
  if (!wrap) return;
  const show = (tab) => {
    wrap.classList.remove('pane-enter'); void wrap.offsetWidth;
    wrap.innerHTML = HOME_VIEWS[tab];
    wrap.classList.add('pane-enter');
    window.scrollTo(0, 0);
  };
  initTabs(tabbar, 'tab', show);
  show(tabbar.querySelector('.tab.active') && tabbar.querySelector('.tab.active').dataset.tab || 'intro');
}

/* ---------- 作答页 ---------- */
function stateFromProgress() {
  let p = Store.progress.get();
  if (!p) { p = { answers: {}, current: 0, startedAt: Date.now() }; Store.progress.set(p); }
  return p;
}

function computeElapsed(startedAt) {
  const sec = Math.max(1, Math.round((Date.now() - startedAt) / 60000));
  if (sec < 60) return `约 ${sec} 分钟`;
  const h = Math.floor(sec / 60);
  return `${h} 小时 ${sec % 60} 分钟`;
}

const RESUMED_KEY = 'scl90__resumeBanner';
function renderQuiz() {
  const root = document.getElementById('quiz-root');
  if (!root) return;
  const p = stateFromProgress();
  const resumeMode = Store.get('resumeFlag', null);
  Store.del('resumeFlag');

  const qIndex = Math.min(p.current, 89);
  const qNo = qIndex + 1;
  const percent = Math.round(qNo / 90 * 100);

  // 断点续答提示
  let banner = '';
  const hadProgress = Object.keys(p.answers).length > 0 &&
    (resumeMode === true || localStorage.getItem(RESUMED_KEY) === '1' || p.current > 0);
  if (hadProgress) {
    banner = `<div class="resume-banner" aria-label="断点续答提示">
      <div class="resume-banner__icon" aria-hidden="true">i</div>
      <div>
        <div class="resume-banner__text">您上次做到第 ${qNo} 题，已为您自动保存进度</div>
        <div class="resume-banner__sub">答案仅保存在本设备，卸载后将丢失</div>
      </div>
    </div>`;
  }

  root.innerHTML = `
    <div class="nav-split">
      <div class="nav-split__back" id="quizBack"><span class="arw">‹</span><span>返回</span></div>
      <h1 class="nav-split__title">第 ${qNo} / 90 题</h1>
      <span class="nav-split__prog">进度 ${percent}%</span>
    </div>
    <div class="progress-track">
      <div class="progress-fill" style="width:${percent}%"></div>
    </div>
    ${banner}
    <section class="question-section">
      <span class="question-tag">第 ${qNo} 题</span>
      <p class="question-text">${QUESTIONS[qIndex]}</p>
      <p class="question-hint">请根据最近一周的实际感觉选择</p>
    </section>
    <main class="options-list" id="optionsList"></main>
    <footer class="question-action">
      <button class="btn btn--secondary" id="prevBtn">上一题</button>
      ${qNo === 90 ? '<button class="btn btn--primary" id="nextBtn">提交并查看报告</button>'
                   : '<button class="btn btn--primary" id="nextBtn">下一题</button>'}
    </footer>`;

  const list = document.getElementById('optionsList');
  list.setAttribute('role', 'radiogroup');
  list.setAttribute('aria-label', `第 ${qNo} 题选项`);
  const renderOptions = () => {
    const chosen = p.answers[qNo];
    list.innerHTML = OPTIONS.map(o => `
      <label class="option-item ${chosen === o.score ? 'selected' : ''}" data-score="${o.score}" for="q${qNo}_${o.score}">
        <input class="visually-hidden" id="q${qNo}_${o.score}" type="radio" name="q${qNo}" value="${o.score}" ${chosen === o.score ? 'checked' : ''}>
        <span class="option-radio"><span class="option-radio-inner"></span></span>
        <span class="option-label">${o.label}</span>
        <span class="option-score">${o.score}分</span>
      </label>`).join('');
    list.querySelectorAll('input[type="radio"]').forEach(input => {
      input.addEventListener('change', () => {
        p.answers[qNo] = Number(input.value);
        p.current = qIndex;
        Store.progress.set(p);
        renderOptions();
      });
    });
    const el = list.querySelector('input:checked') || list.querySelector('input');
    if (el) el.tabIndex = 0;
  };
  renderOptions();

  const saveAndGo = (next) => {
    if (next >= 0 && next < 90) {
      p.current = next; Store.progress.set(p); renderQuiz();
    }
  };

  document.getElementById('prevBtn').onclick = () => { if (qIndex > 0) { p.current = qIndex - 1; Store.progress.set(p); } renderQuiz(); };
  document.getElementById('nextBtn').onclick = () => {
    if (typeof p.answers[qNo] === 'undefined') { showToast('请先选择本道题的答案'); return; }
    if (qNo === 90) {
      // 第 90 题作答完成 → 进入「提交完成」概览页（暂存，待用户确认提交）
      Store.set('pendingComplete', { answers: p.answers, duration: computeElapsed(p.startedAt), startedAt: p.startedAt });
      location.href = 'submit.html';
    } else {
      p.current = qIndex + 1; Store.progress.set(p); renderQuiz();
    }
  };
  document.getElementById('quizBack').onclick = () => {
    confirmDialog({
      title: '退出作答？', text: '退出后进度将自动保存，可稍后继续。返回首页继续作答即可。',
      confirmText: '返回首页', cancelText: '继续作答'
    }).then(ok => { if (ok) { localStorage.setItem(RESUMED_KEY, '1'); location.href = 'home.html'; } });
  };
}

/* ---------- 计分页：提交完成(generate from answers without saving) ---------- */
function renderSubmitDone() {
  // 提交完成已完成页：score.html 展示「已完成」概览
  const root = document.getElementById('submit-root');
  if (!root) return;
  const survey = Store.get('pendingComplete', null);
  root.innerHTML = `
    <div class="nav-split">
      <div class="nav-split__back" onclick="location.href='home.html'"><span class="arw">‹</span><span>返回</span></div>
      <h1 class="nav-split__title">第 90 / 90 题</h1>
      <span class="nav-split__prog">进度 100%</span>
    </div>
    <div class="progress-track"><div class="progress-fill" style="width:100%"></div></div>
    <section class="completion">
      <div class="completion__iconWrap">
        <div class="completion__glow"></div>
        <div class="completion__icon"><svg viewBox="0 0 24 24"><polyline points="5 12 10 17 19 7"/></svg></div>
      </div>
      <h2 class="completion__title">90 题已完成</h2>
      <p class="completion__desc">您已完成全部 90 道题目，提交后将生成您的专属测评报告</p>
    </section>
    <div style="padding: 0 16px">
      <div class="overview-grid">
        <div class="overview-cell"><div class="overview-label">总用时</div><div class="overview-value">${(survey && survey.duration) || '约 15 分钟'}</div></div>
        <div class="overview-cell"><div class="overview-label">已答题数</div><div class="overview-value green-deep">90 / 90</div></div>
        <div class="overview-cell"><div class="overview-label">完成度</div><div class="overview-value green">100%</div></div>
      </div>
      <div class="tips-box"><p class="tips-text">提交后结果不可修改，请确认每题均按真实情况作答</p></div>
    </div>
    <div style="padding:16px;display:flex;gap:10px;margin-top:auto">
      <button class="btn btn--secondary" onclick="location.href='quiz.html'">上一题</button>
      <button class="btn btn--primary" id="doSubmit">提交并查看报告</button>
    </div>`;
  document.getElementById('doSubmit').onclick = () => {
    const s = Store.get('pendingComplete', null);
    if (s && s.answers) {
      const record = computeReport(s.answers);
      record.id = 'r_' + Date.now().toString(36);
      record.duration = s.duration || '约 15 分钟';
      const records = Store.records.get();
      records.unshift(record); Store.records.set(records);
      Store.progress.clear(); Store.del('pendingComplete');
      location.href = 'report.html?id=' + record.id;
    } else location.href = 'report.html';
  };
}

/* ---------- 报告页 （总览 / 因子解读 / 相关推荐 / 高危提示） ---------- */
function getRequestedRecord() {
  const id = new URLSearchParams(location.search).get('id');
  const records = Store.records.get();
  if (id) return records.find(r => r.id === id) || records[0];
  return records[0];
}

function radarSVG(factors, topKey) {
  const order = ['somatization', 'obsession', 'interpersonal', 'depression', 'anxiety', 'hostility', 'phobia', 'paranoid', 'psychotic'];
  const cx = 150, cy = 164, R = 78;
  const n = 9;
  const ang = (i) => (-90 + i * (360 / n)) * Math.PI / 180;
  const pt = (i, r) => [cx + r * Math.cos(ang(i)), cy + r * Math.sin(ang(i))];
  const norm = (avg) => Math.min(1, Math.max(0, (avg - 1) / 3)); // 1~4 -> 0~1
  const data = factors.map(f => pt(order.indexOf(f.key), R * (0.2 + 0.8 * norm(f.avg))));

  const rings = [0.25, 0.5, 0.75, 1];
  let pol = rings.map(r => `<polygon points="${order.map((k, i) => pt(i, R * r).join(',')).join(' ')}" fill="none" stroke="#E5DFD5" stroke-width="1"/>`).join('');
  let axes = order.map((k, i) => { const [ax, ay] = pt(i, R); return `<line x1="${cx}" y1="${cy}" x2="${ax}" y2="${ay}" stroke="#E5DFD5" stroke-width="1"/>`; }).join('');

  // 9 个因子：取 ALL_FACTORS 中与 order 对齐的显示名与位置
  let labels = order.map((k, i) => {
    const p = pt(i, R + 14);
    const short = DIM_BY_KEY[k].short;
    let anchor = 'middle';
    if (p[0] < cx - 20) anchor = 'end';
    else if (p[0] > cx + 20) anchor = 'start';
    return `<text x="${p[0]}" y="${p[1]}" text-anchor="${anchor}" font-size="10.5" fill="#7A766F">${short}</text>`;
  }).join('');

  const dataPts = data.map(p => p.join(',')).join(' ');
  let dots = data.map(p => `<circle cx="${p[0]}" cy="${p[1]}" r="3" fill="#7BA68C"/>`).join('');

  return `<svg class="radar-chart" viewBox="0 0 300 320" xmlns="http://www.w3.org/2000/svg">
    ${pol}${axes}
    <polygon points="${dataPts}" fill="#7BA68C" fill-opacity="0.25" stroke="#7BA68C" stroke-width="1.5" stroke-linejoin="round"/>
    ${dots}${labels}
  </svg>`;
}

function renderReport() {
  const root = document.getElementById('report-root');
  if (!root) return;
  const record = getRequestedRecord();
  const tabbar = document.getElementById('report-tabbar');

  if (!record) {
    root.innerHTML = `<div style="padding:60px 24px;text-align:center;color:var(--ink-3)">
      <p style="font-size:40px">📄</p><p style="margin-top:12px">还没有测评记录</p>
      <button class="btn-primary" style="margin-top:20px" onclick="location.href='quiz.html'">开始测评</button></div>`;
    return;
  }

  // 顶部日期
  const dateEl = document.getElementById('reportDate');
  if (dateEl) dateEl.textContent = fmtDate(record.created);

  // 初始页签：优先 URL 参数；无参数且为强制干预 → 自动进入高危提示（冷载入可靠）
  const queryTab = new URLSearchParams(location.search).get('tab');
  const startTab = queryTab || (record.crisisLevel === 'forced' ? 'severe' : 'overview');

  const show = (tab) => {
    root.classList.remove('pane-enter'); void root.offsetWidth;
    if (tab === 'overview') {
      const grade = gradeOf(record.totalAvg);
      const forList = record.factors.filter(f => f.key !== 'additional');
      root.innerHTML = `
        <section class="overall-card">
          <div class="overall-card__header">
            <span class="overall-card__label">总体评估</span>
            <span class="severity-tag severity-tag--${grade}">${record.severity}</span>
          </div>
          <div class="overall-card__score">${record.total}</div>
          <p class="overall-card__note">总分范围 90–450，参考界值 160/200</p>
          <div class="overall-card__metrics">
            <div class="metric"><div class="metric__value">${record.totalAvg}</div><div class="metric__label">总均分</div></div>
            <div class="metric"><div class="metric__value">${record.positiveCount}</div><div class="metric__label">阳性项目数</div></div>
            <div class="metric"><div class="metric__value">${record.positiveAvg}</div><div class="metric__label">阳性均分</div></div>
          </div>
        </section>
        <section class="card">
          <h2 class="card__title">九维轮廓图</h2>
          <div class="radar-wrap">
            ${radarSVG(ALL_FACTORS.map(f => ({
              key: f.key, avg: (record.factors.find(rf => rf.key === f.key) || { avg: 1 }).avg
            })))}
            <div class="radar-legend">
              <span><i style="background:var(--lv-normal)"></i>正常 &lt;2.0</span>
              <span><i style="background:var(--lv-mild)"></i>轻度 2.0–3.0</span>
              <span><i style="background:var(--lv-moderate)"></i>中度 3.0–4.0</span>
              <span><i style="background:var(--lv-severe)"></i>重度 ≥4.0</span>
            </div>
          </div>
        </section>
        <section class="card">
          <h2 class="card__title">各因子得分</h2>
          <div class="factor-list">
            ${forList.map(f => `
              <div class="factor-item">
                <span class="factor-item__name">${f.short}</span>
                <div class="factor-item__bar-wrap"><div class="factor-item__bar bar--${f.grade}" style="width:${Math.max(6, f.avg / 4 * 100)}%"></div></div>
                <div class="factor-item__right">
                  <span class="factor-item__score">${f.avg.toFixed(1)}</span>
                  <span class="factor-item__tag tag--${f.grade}">${GRADE_LABEL[f.grade]}</span>
                </div>
              </div>`).join('')}
          </div>
        </section>`;
    }

    if (tab === 'interpret') {
      const graded = record.factors.filter(f => f.key !== 'additional').sort((a, b) => b.avg - a.avg);
      root.innerHTML = `
        <div class="interpret-tip">以下基于 SCL-90 标准分级，点击卡片展开查看详情</div>
        ${graded.map(f => {
          const interp = INTERPRETATION[f.key];
          if (!interp) return '';
          const lv = f.grade === 'normal' ? { state: '该维度处于正常范围，请保持关注与自我关心。', act: ['保持规律作息与适度运动', '留意情绪与身体感受的变化','如有需要，2-4 周后可复测观察趋势'] } : interp.levels[f.grade];
          const collapsed = f.grade === 'normal';
          return `<article class="factor-card ${collapsed ? 'collapsed' : ''}" data-open="${f.key}">
            <div class="factor-card__header">
              <span class="factor-name">${f.cn}</span>
              <span class="level-tag level-tag--${f.grade}">${GRADE_LABEL[f.grade]}</span>
            </div>
            <div class="score-row">
              <span class="score-detail">${f.raw} 分 / ${f.count} 题</span>
              <span class="score-average">${f.avg.toFixed(1)}<span class="unit"> 分</span></span>
              <div class="bar"><div class="progress-fill bar--${f.grade}" style="width:${Math.max(6, f.avg / 4 * 100)}%"></div></div>
            </div>
            <div class="expand-content">
              <div class="expand-title">近期状态</div>
              <p class="expand-text">${lv.state}</p>
              <div class="expand-title">可以尝试</div>
              <ul class="suggestion-list">${lv.act.map(a => `<li>${a}</li>`).join('')}</ul>
              ${f.grade === 'moderate' || f.grade === 'severe' ? `<div class="expand-title" style="color:var(--lv-moderate)">建议关注</div>
                <p class="expand-text" style="color:var(--lv-severe)">${f.grade === 'severe' ? '该维度已达重度水平，请尽快寻求专业评估，必要时立即就医。' : '该维度已达中度水平，建议关注并寻求专业支持。'}</p>` : ''}
            </div>
          </article>`;
        }).join('')}`;
      root.querySelectorAll('.factor-card').forEach(card => {
        card.addEventListener('click', () => card.classList.toggle('collapsed'));
      });
    }

    if (tab === 'feed') {
      const top = record.topFactor;
      const recs = RECOMMENDATIONS[top.key] || RECOMMENDATIONS.additional;
      const icon = (name) => ({
        clock: '<svg viewBox="0 0 24 24" fill="none"><circle cx="12" cy="12" r="9" stroke="#A39E95" stroke-width="1.5"/><path d="M12 7v5l3 2" stroke="#A39E95" stroke-width="1.5" stroke-linecap="round"/></svg>',
        audio: '<svg viewBox="0 0 24 24" fill="none"><path d="M9 18V5l12-2v13" stroke="#A39E95" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/><circle cx="6" cy="18" r="3" stroke="#A39E95" stroke-width="1.5"/><circle cx="18" cy="16" r="3" stroke="#A39E95" stroke-width="1.5"/></svg>',
        book: '<svg viewBox="0 0 24 24" fill="none"><path d="M2 3h6a4 4 0 014 4v14a3 3 0 00-3-3H2V3z" stroke="#A39E95" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/><path d="M22 3h-6a4 4 0 00-4 4v14a3 3 0 013-3h7V3z" stroke="#A39E95" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>',
        check: '<svg viewBox="0 0 24 24" fill="none"><path d="M9 11l3 3L22 4" stroke="#A39E95" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/><path d="M21 12v7a2 2 0 01-2 2H5a2 2 0 01-2-2V5a2 2 0 012-2h11" stroke="#A39E95" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>'
      })[name];
      root.innerHTML = `
        <section class="rec-intro">
          <h2 class="rec-intro__title">
            <svg viewBox="0 0 24 24" fill="none"><path d="M12 2L15.09 8.26L22 9.27L17 14.14L18.18 21.02L12 17.77L5.82 21.02L7 14.14L2 9.27L8.91 8.26L12 2Z" fill="#7BA68C" fill-opacity="0.9"/></svg>
            针对你的情况，我们推荐
          </h2>
          <p class="rec-intro__desc">根据你得分最高的维度（<span class="rec-intro__highlight">${top.short} ${top.avg.toFixed(1)} 分</span>），以下内容可能对你有帮助</p>
        </section>
        <section class="rec-list">
          ${recs.map(r => `<article class="rec-card">
            <span class="rec-card__tag rec-card__tag--${r.tagCls}">${r.tag}</span>
            <h3 class="rec-card__title">${r.title}</h3>
            <p class="rec-card__desc">${r.desc}</p>
            <div class="rec-card__footer">
              <span class="rec-card__meta">${icon(r.metaIcon)}${r.meta}</span>
              <span class="rec-card__arrow">›</span>
            </div>
          </article>`).join('')}
        </section>
        <aside class="disclaimer"><p class="disclaimer__text">💡 以上内容为通用科普推荐，不构成医疗建议。如有明显困扰，请及时寻求专业帮助。</p></aside>`;
    }

    if (tab === 'severe') {
      renderHighRisk(root, record);
    }

    root.classList.add('pane-enter');
    window.scrollTo(0, 0);
  };

  initTabs(tabbar, 'report', show, startTab);
  show(startTab);
}

function renderHighRisk(root, record) {
  const forced = record.crisisLevel === 'forced';
  const strong = record.crisisLevel === 'strong';
  const triggerTags = record.triggers.length ? record.triggers.slice(0, 4) : ['请将紧张指标保持观察，暂无特别突出的阳性维度'];
  root.innerHTML = `
    ${forced ? `<div class="modal-mask" id="crisisMask" role="presentation">
      <div class="modal" role="alertdialog" aria-modal="true" aria-labelledby="crisisTitle" aria-describedby="crisisText">
        <div class="modal__icon"><svg viewBox="0 0 52 52" fill="none"><path d="M26 45C26 45 9 33 9 20C9 14.5 14 10 19.5 10C23 10 26 12 26 12C26 12 29 10 32.5 10C38 10 43 14.5 43 20C43 33 26 45 26 45Z" fill="#FFFFFF" fill-opacity="0.95"/><rect x="23" y="18" width="6" height="14" rx="2" fill="#A86B6B"/><rect x="19" y="22" width="14" height="6" rx="2" fill="#A86B6B"/></svg></div>
        <div class="modal__title" id="crisisTitle">需要特别关注</div>
        <p class="modal__text" id="crisisText">您的测评结果提示部分维度处于较高水平。这很重要，但也请先放松：现在最有用的一步，是找一个值得信任的人或拨打心理援助热线聊一聊。<br><br>请在确认了解以下求助方式后再继续查看报告。</p>
        <button class="btn-primary modal__btn" id="crisisOk">我已知晓，会好好照顾自己</button>
      </div>
    </div>` : ''}
    <section class="warning-banner" role="alert">
      <div class="warning-banner__icon"><svg viewBox="0 0 52 52" fill="none"><path d="M26 45C26 45 9 33 9 20C9 14.5 14 10 19.5 10C23 10 26 12 26 12C26 12 29 10 32.5 10C38 10 43 14.5 43 20C43 33 26 45 26 45Z" fill="#FFFFFF" fill-opacity="0.95"/><rect x="23" y="18" width="6" height="14" rx="2" fill="#A86B6B"/><rect x="19" y="22" width="14" height="6" rx="2" fill="#A86B6B"/></svg></div>
      <h2 class="warning-banner__title">${forced ? '需要特别关注' : '建议关注'}</h2>
      <p class="warning-banner__desc">${forced ? '你的测评结果显示部分维度处于较高水平，建议认真对待' : '你的测评结果中部分维度达到关注水平，建议进一步了解与自我关照'}</p>
      <p class="warning-banner__support">你不是一个人，有很多人可以帮助你</p>
    </section>
    <section class="card">
      <h2 class="card__title">触发原因</h2>
      <div class="trigger-list">${triggerTags.map(t => `<span class="trigger-tag">${t}</span>`).join('')}</div>
    </section>
    <section class="card card--emergency">
      <h2 class="card__title">24 小时心理援助热线</h2>
      <div class="emergency-list">
        ${HOTLINES.map(h => `<div class="emergency-item">
          <span class="emergency-item__label">${h.label}</span>
          <span class="emergency-item__number"><svg viewBox="0 0 18 18" fill="none"><path d="M13.5 11.25L10.5 10.125L8.625 12C6.375 10.875 4.625 9.125 3.5 6.875L5.375 5L4.25 2L1.625 2C1.25 2 1 2.25 1 2.625C1 11.5 6.5 17 15.375 17C15.75 17 16 16.75 16 16.375L16 13.75L13.5 11.25Z" fill="#A86B6B"/></svg>${h.number}</span>
        </div>`).join('')}
      </div>
      <p class="emergency-footer">以上热线均免费提供 24 小时心理支持</p>
    </section>
    <section class="card">
      <h2 class="card__title">如果你此刻感到不安全</h2>
      <div class="action-list">
        ${CRISIS_ACTIONS.map(a => `<div class="action-item">
          <div class="action-item__icon"><svg viewBox="0 0 16 16" fill="none"><path d="M13 10.5L10 9.5L8 11.5C5.5 10.5 4 9 3 6.5L4.5 4.5L3.5 2L1 2C0.5 2 0.5 2.5 0.5 3C0.5 11 5.5 15.5 13 15.5C13.5 15.5 14 15 14 14.5L14 12L13 10.5Z" fill="#A86B6B"/></svg></div>
          <p class="action-item__text">${a}</p>
        </div>`).join('')}
      </div>
    </section>
    ${forced ? '' : '<button class="confirm-btn" onclick="location.href=\'report.html?id=' + record.id + '&tab=overview\'">查看总览</button>'}
    <p class="bottom-support">每个人都值得被好好对待，包括你自己 <span class="heart">♥</span></p>`;

  const mask = document.getElementById('crisisMask');
  if (mask) {
    // 强制：必须先确认，横幅之外的其余内容不可交互（遮罩覆盖）
    const ok = document.getElementById('crisisOk');
    ok.focus();
    ok.onclick = () => { mask.remove(); };
    mask.addEventListener('keydown', e => { if (e.key === 'Escape' || e.key === 'Enter') { e.preventDefault(); ok.click(); } });
  }
}

/* ---------- 历史页 ---------- */
function renderHistory() {
  const root = document.getElementById('history-root');
  if (!root) return;
  const records = Store.records.get();

  if (!records.length) {
    root.innerHTML = `
      <nav class="navbar"><div class="navbar__back" onclick="history.back()">返回</div><h1 class="navbar__title">我的记录</h1></nav>
      <section class="empty-state">
        <svg class="empty-state__illustration" viewBox="0 0 120 120" fill="none">
          <rect x="30" y="18" width="52" height="72" rx="6" stroke="#7BA68C" stroke-width="2.5"/>
          <path d="M64 18V32H78" stroke="#7BA68C" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/>
          <path d="M64 18L78 32" stroke="#7BA68C" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/>
          <line x1="42" y1="46" x2="68" y2="46" stroke="#7BA68C" stroke-width="2" stroke-linecap="round" opacity="0.6"/>
          <line x1="42" y1="56" x2="68" y2="56" stroke="#7BA68C" stroke-width="2" stroke-linecap="round" opacity="0.6"/>
          <line x1="42" y1="66" x2="58" y2="66" stroke="#7BA68C" stroke-width="2" stroke-linecap="round" opacity="0.6"/>
          <circle cx="72" cy="72" r="16" stroke="#7BA68C" stroke-width="2.5"/>
          <line x1="83.5" y1="83.5" x2="94" y2="94" stroke="#7BA68C" stroke-width="2.5" stroke-linecap="round"/>
          <line x1="72" y1="64" x2="72" y2="80" stroke="#7BA68C" stroke-width="1.5" stroke-linecap="round" opacity="0.5"/>
          <line x1="64" y1="72" x2="80" y2="72" stroke="#7BA68C" stroke-width="1.5" stroke-linecap="round" opacity="0.5"/>
        </svg>
        <h2 class="empty-state__title">暂无测评记录</h2>
        <p class="empty-state__subtitle">完成一次测评后，你的记录会保存在这里</p>
      </section>
      <div style="padding:0 16px">
      <section class="card meaning-card" style="padding-top:4px">
        <h3 class="card__title">记录的意义</h3>
        <div class="meaning-list">
          <div class="meaning-item"><div class="meaning-item__icon">📈</div><div><div class="meaning-item__title">追踪变化</div><div class="meaning-item__desc">观察心理状态的波动</div></div></div>
          <div class="meaning-item"><div class="meaning-item__icon">🔍</div><div><div class="meaning-item__title">发现规律</div><div class="meaning-item__desc">了解影响状态的因素</div></div></div>
          <div class="meaning-item"><div class="meaning-item__icon">💪</div><div><div class="meaning-item__title">见证成长</div><div class="meaning-item__desc">每一步进步都算数</div></div></div>
        </div>
      </section>
      <button class="btn-primary" onclick="location.href='quiz.html'">开始第一次测评</button>
      <p class="cta-hint">约 15 分钟 · 90 题 · 匿名安全</p>
      </div>`;
    return;
  }

  const count = records.length;
  const latest = records[0];
  const prev = records[1];
  let trend = '—';
  if (prev) trend = latest.total - prev.total === 0 ? '→ 持平' : (latest.total - prev.total < 0 ? '↘ 下降' : '↗ 上升');
  const focus = (latest.factors.find(f => f.key === latest.topFactor.key) || {}).short || '—';

  const topDims = (rec) => {
    const dims = ['somatization', 'anxiety', 'depression'].map(key => rec.factors.find(f => f.key === key));
    return dims.filter(Boolean).map(d => {
      const colors = { somatization: 'var(--brand)', anxiety: 'var(--lv-moderate)', depression: 'var(--lv-severe)' };
      return `<div class="dim-row">
        <span class="dim-name">${d.short}</span>
        <div class="dim-bar-track"><div class="dim-bar-fill ${d.key==='anxiety'?'dim-bar-fill--anxiety':d.key==='depression'?'dim-bar-fill--depression':''}" style="width:${Math.max(4, d.avg / 4 * 100)}%"></div></div>
        <span class="dim-value">${d.avg.toFixed(1)}</span>
      </div>`; }).join('');
  };

  root.innerHTML = `
    <nav class="navbar"><div class="navbar__back" onclick="history.back()">返回</div><h1 class="navbar__title">我的记录</h1></nav>
    <main style="padding:16px 16px calc(120px + env(safe-area-inset-bottom))">
      <section class="stats-card">
        <div class="stats-item"><span class="stats-value stats-value--count">${count} 次</span><span class="stats-label">累计测评</span></div>
        <div class="stats-divider"></div>
        <div class="stats-item"><span class="stats-value stats-value--trend">${trend}</span><span class="stats-label">最近一次对比</span></div>
        <div class="stats-divider"></div>
        <div class="stats-item"><span class="stats-value stats-value--focus">${focus}</span><span class="stats-label">主要关注项</span></div>
      </section>
      <div class="section-header-row"><h2>测评记录</h2><span>按时间倒序</span></div>
      <div class="record-list">
        ${records.map(r => `<article class="record-card" data-id="${r.id}">
          <div class="record-top">
            <div class="record-date-wrap"><span class="record-date">${fmtDate(r.created)}</span><span class="record-weekday">${fmtWeekday(r.created)}</span></div>
            <span class="level-tag level-tag--${gradeOf(r.totalAvg)}">${r.severity}</span>
          </div>
          <div class="record-score-row"><span class="record-score">${r.total}</span><span class="record-score-label">总分</span></div>
          <div class="record-dims">${topDims(r)}</div>
          <div class="record-footer"><span class="view-report">查看报告</span></div>
        </article>`).join('')}
      </div>
    </main>
    <footer class="bottom-bar">
      <div class="action-area">
        <button class="btn btn--primary" onclick="location.href='quiz.html'">开始新测评</button>
        <button class="btn btn--secondary" id="clearRecords">清除记录</button>
      </div>
      <p class="bottom-note">所有记录仅保存在本设备，清除后不可恢复</p>
    </footer>`;

  root.querySelectorAll('.record-card').forEach(card => {
    card.addEventListener('click', () => location.href = 'report.html?id=' + card.dataset.id);
  });
  document.getElementById('clearRecords').onclick = () => {
    confirmDialog({
      title: '清除全部本地记录？', text: '清除后不可恢复，原有测评报告将一并删除。',
      confirmText: '确认清除', cancelText: '取消', danger: true
    }).then(ok => { if (ok) { Store.records.clear(); renderHistory(); showToast('已清除全部记录'); } });
  };
}

/* ---------- 高危 tab 由 report 内使用，无需额外初始化 ---------- */

/* ---------- 路由分发 ---------- */
document.addEventListener('DOMContentLoaded', function () {
  const page = document.body.dataset.page;
  if (page === 'activation') renderActivation();
  else if (page === 'home') renderHome();
  else if (page === 'quiz') renderQuiz();
  else if (page === 'submit') renderSubmitDone();
  else if (page === 'report') renderReport();
  else if (page === 'history') renderHistory();
});