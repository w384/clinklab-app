/* ClinkLab 付费报名 V0.1 —— 本地联调 harness（浏览器驱动真实 API，非生产客户端）。 */
'use strict';

// 空元素代理：当元素缺失（例如浏览器缓存了旧版页面）时返回它，
// 让任意 .onX / .style / .querySelector / .classList 链都安全 no-op，避免中断整个 init。
const _nullEl = new Proxy(function () {}, {
  get(_t, p) {
    if (p === 'then' || p === 'catch' || p === 'finally' || p === Symbol.iterator) return undefined;
    if (p === Symbol.toPrimitive) return () => '';
    return _nullEl;
  },
  set() { return true; },
  apply() { return _nullEl; },
  construct() { return _nullEl; },
});
const $ = (sel) => document.querySelector(sel) || _nullEl;
const $$ = (sel) => Array.from(document.querySelectorAll(sel));

// ── 版本守卫：index.html 与 app.js 必须同代 ──
// 浏览器/代理常按「路径」缓存 index.html（不带版本参数），而 app.js 带 ?v= 会更新；
// 若 index.html 是旧缓存而 app.js 已是新版，新旧结构混载会导致：子 tab 失效、
// 旧逻辑误注入多余的顶级 tab（如「评论」）、新管理区无内容。
// 办法：检测 v34 结构必需的容器，缺失即判定页面文档过期，用 fetch 从服务器
// 拉取最新页面并「就地启动」（fetch 已被实测能绕过页面缓存拦截），不再依赖导航。
(function versionGuard() {
  try {
    // ── 无条件从服务器启动 ──
    // 用户环境的缓存/拦截会把多个版本的 index.html 与 app.js 混载（页面 4 tab、脚本是旧版时
    // 旧 ensure 逻辑会误注入"评论"按钮变 5 tab）。检测式守卫会被各种混载状态绕过，
    // 所以这里不做任何"检测"，一律 fetch 服务器最新 index.html 替换 body 后统一 init。
    // fetch 带 no-store 已被实测能绕过拦截，拿到的一定是最新版。
    window.__unconditionalBoot = true; // 禁用所有旧页 ensure 注入（selfHealStalePage 也在其后，会读到）
    window.__stalePage = true; // 阻止底部自行 init，由 boot 统一执行
    let booted = false;
    try { booted = sessionStorage.getItem('cl_booted') === '1'; } catch (e) { /* 忽略 */ }
    if (!booted) {
      try { sessionStorage.setItem('cl_booted', '1'); } catch (e) { /* 忽略 */ }
      bootFromServer().then((ok) => {
        if (!ok) {
          try { sessionStorage.removeItem('cl_booted'); } catch (e) { /* 忽略 */ }
          // fetch 失败（如服务器未启动）：页面结构正确则直接 init，否则横幅
          const required = ['tab-forum', 'evCmtList', 'adminDash', 'tab-share'];
          const missing = required.filter((id) => !document.getElementById(id));
          if (!missing.length) {
            init().catch((err) => { console.error('INIT FAILED:', err); reportErr('init 失败: ' + (err && err.message || err)); });
          } else {
            guardBanner(missing);
          }
        }
      });
      return;
    }
    // 已 boot 过（递归保护）：按结构检测兜底
    const required = ['tab-forum', 'evCmtList', 'adminDash', 'tab-share'];
    const missing = required.filter((id) => !document.getElementById(id));
    if (!missing.length) {
      init().catch((err) => { console.error('INIT FAILED:', err); reportErr('init 失败: ' + (err && err.message || err)); });
    } else {
      guardBanner(missing);
    }
  } catch (e) { /* 守卫失败不影响主流程 */ }
})();

/** 从服务器强制启动：fetch 最新 index.html → 替换 body → 换新 CSS → 复用当前已加载的
 *  app.js（守卫就在其中运行，脚本必为最新）重新执行 init() 完成初始化。
 *  注意：绝不能在此再加载一份 app.js（顶层 const 会重复声明报错）。 */
async function bootFromServer() {
  try {
    const base = location.origin;
    // 动态唯一路径：/ui-latest/<时间戳> 每次不同，任何按 URL 缓存的代理都无法命中旧缓存
    const html = await fetch(base + '/ui-latest/' + Date.now(), { cache: 'no-store' }).then((r) => r.text());
    // 严格新鲜度校验：代理可能把 /ui-latest/* 缓存成「中间版本」（有论坛、但缺分享/归档）。
    // 必须同时含分享/归档/论坛/后台等新版容器才算最新，否则跳过替换——避免把当前更完整的 body 覆盖成旧版。
    const freshMarkers = ['id="tab-share"', 'id="shareList"', 'id="archivedList"', 'id="forumList"', 'id="adminDash"'];
    if (!freshMarkers.every((m) => html.includes(m))) {
      diag('bootFromServer: 拉取到旧版页面（缺新版容器），跳过替换，保留当前 body');
      return false;
    }
    const doc = new DOMParser().parseFromString(html, 'text/html');
    // 1) 替换 body 内容（保留 body 元素本身）
    document.body.innerHTML = doc.body.innerHTML;
    diag('bootFromServer: 已用最新页面替换 body');
    // 2) 替换样式：清掉旧 stylesheet，加载服务器最新版（绝对路径，兼容 / 与 /ui/ 前缀）
    Array.from(document.querySelectorAll('head link[rel="stylesheet"]')).forEach((l) => l.remove());
    const css = document.createElement('link');
    css.rel = 'stylesheet';
    css.href = base + '/ui/styles.css?v=' + Date.now();
    document.head.appendChild(css);
    // 3) 重新初始化（当前 app.js 已在运行，init 函数声明已提升，可直接调用）
    try { await init(); } catch (e) { reportErr('重新初始化失败: ' + (e && e.message || e)); }
    // 4) 终局清理：无论期间发生了什么注入，导航栏强制收敛为 4 个顶级 tab
    const nav = document.getElementById('tabs');
    if (nav) {
      const want = ['events', 'share', 'forum', 'admin'];
      Array.from(nav.querySelectorAll('button')).forEach((b) => {
        if (!want.includes(b.dataset.tab)) b.remove();
      });
      // 若缺少某一 tab（被误删/未渲染），按顺序补回
      const order = ['events', 'share', 'forum', 'admin'];
      const labels = { events: '活动', share: '分享', forum: '论坛', admin: '后台' };
      order.forEach((t) => {
        if (!nav.querySelector('button[data-tab="' + t + '"]')) {
          const nb = document.createElement('button');
          nb.dataset.tab = t;
          nb.textContent = labels[t];
          nav.appendChild(nb);
        }
      });
      // 重新绑定点击（若 init 绑定的是被清理前的按钮）
      Array.from(nav.querySelectorAll('button')).forEach((b) => (b.onclick = () => switchTab(b.dataset.tab)));
    }
    try { sessionStorage.removeItem('cl_booted'); } catch (e) { /* 忽略 */ }
    return true;
  } catch (e) {
    return false;
  }
}

/** 版本守卫诊断横幅：服务器自检 / 跳备用端口 / 注销 Service Worker。 */
function guardBanner(missing) {
  try {
    const b = document.createElement('div');
    b.style.cssText = 'position:fixed;left:0;right:0;top:0;z-index:100000;background:#b91c1c;color:#fff;padding:10px 14px;font:13px/1.6 system-ui,sans-serif;box-shadow:0 3px 10px rgba(0,0,0,.35)';
    b.innerHTML = '页面仍为旧缓存（缺少：' + missing.join('、') + '）——服务器本身正常，是<b>浏览器/代理缓存</b>拦截了页面。<br>'
      + '当前地址：<code>' + location.href + '</code><br>'
      + '<button id="__guardBoot" style="margin-top:8px;margin-right:8px;padding:6px 16px;border:0;border-radius:6px;background:#fff;color:#b91c1c;font-weight:700;cursor:pointer">🔁 从服务器强制启动</button>'
      + '<br><span style="display:inline-block;margin-top:8px;font-size:12px;opacity:.9">点「从服务器强制启动」即可绕过缓存加载最新界面（无需换浏览器/清缓存）。</span>';
    (document.body || document.documentElement).appendChild(b);
    const bb = document.getElementById('__guardBoot');
    if (bb) bb.onclick = async () => {
      bb.disabled = true; bb.textContent = '启动中…';
      const ok = await bootFromServer();
      if (!ok) { bb.disabled = false; bb.textContent = '🔁 从服务器强制启动'; alert('启动失败，请检查服务器是否运行'); }
    };
    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.getRegistrations().then((rs) => {
        if (rs && rs.length) {
          const p = document.createElement('div');
          p.style.marginTop = '8px';
          p.innerHTML = '检测到 Service Worker（' + rs.length + ' 个）——它可能拦截页面返回旧缓存。<button id="__guardSwBtn" style="margin-left:8px;padding:2px 10px;border:0;border-radius:6px;background:#fff;color:#b91c1c;cursor:pointer">注销并重载</button>';
          b.appendChild(p);
          const sb = document.getElementById('__guardSwBtn');
          if (sb) sb.onclick = () => Promise.all(rs.map((r) => r.unregister())).then(() => location.reload());
        }
      }).catch(() => {});
    }
  } catch (e) { /* 横幅失败不影响主流程 */ }
}

// 后台界面版本：显示在右上角徽章，便于确认已加载到最新页面（避免旧缓存页看不到"正文/图片"编辑区）。
// 每次改完界面代码都要改这个字符串，用户看到的新徽章 = 已刷新到最新页。
const UI_VERSION = 'v38';
// 页面级诊断横幅：不依赖任何业务元素，永远可见（用于定位缓存/元素缺失/执行中断）
function diag(msg) {
  try {
    let el = document.getElementById('__diag');
    if (!el) {
      el = document.createElement('div');
      el.id = '__diag';
      el.style.cssText = 'position:fixed;left:10px;bottom:10px;z-index:999999;max-width:70vw;background:#111;color:#7CFC00;font:12px/1.5 monospace;padding:8px 12px;border-radius:6px;box-shadow:0 4px 16px rgba(0,0,0,.5);white-space:pre-wrap';
      if (localStorage.getItem('cl_diag_hidden') === '1') el.style.display = 'none'; // 上次关闭过则保持隐藏
      (document.body || document.documentElement).appendChild(el);
    }
    const t = new Date().toTimeString().slice(0, 8);
    el.textContent = `[${t}] ${msg}\n` + el.textContent;
    if (el.textContent.length > 2000) el.textContent = el.textContent.slice(0, 2000);
  } catch (e) { /* 忽略 */ }
}

// ── 诊断横幅开关（右上角按钮，状态存 localStorage，刷新后保持）──
function applyDiagState() {
  const hidden = localStorage.getItem('cl_diag_hidden') === '1';
  const el = document.getElementById('__diag');
  if (el) el.style.display = hidden ? 'none' : '';
  const b = document.getElementById('diagToggle');
  if (b) b.textContent = hidden ? '诊断:关' : '诊断:开';
}

function ensureDiagToggle() {
  try {
    let b = document.getElementById('diagToggle');
    const wire = () => {
      const hidden = localStorage.getItem('cl_diag_hidden') === '1';
      localStorage.setItem('cl_diag_hidden', hidden ? '0' : '1');
      applyDiagState();
    };
    if (b) { b.onclick = wire; applyDiagState(); return; }
    b = document.createElement('button');
    b.id = 'diagToggle';
    b.type = 'button';
    b.title = '显示/隐藏左下角诊断面板';
    b.style.cssText = 'margin-left:8px;background:#fff;border:1px solid #d8dbe4;color:#6b7280;border-radius:999px;padding:2px 12px;font-size:12px;cursor:pointer;';
    b.onclick = wire;
    const holder = document.getElementById('uiVerBadge');
    if (holder && holder.parentNode) holder.parentNode.insertBefore(b, holder.nextSibling);
    else if (document.body) document.body.appendChild(b);
    applyDiagState();
  } catch (e) { /* 忽略 */ }
}

// ── 自愈：旧缓存页自动升级 ──
// 现象：浏览器按「路径」缓存了旧版 index.html（"活动详情"是 6 字段+报名的旧布局），
//   即使换新 URL（/?__fresh=…）仍返回旧页；但旧页引用的是无版本号的 app.js，
//   所以这份最新 app.js 一定会在旧页里跑。
// 办法：不再依赖浏览器重新拉取 index.html，而是直接由 app.js 把「正文详情 + 封面裁切
//   + 手机预览」编辑区注入到当前页面的 #tab-detail 里。注入发生在 init() 之前，
//   所以后面的接线（#deDesc / #deSave / #deCoverFile…）都能找到这些元素。
(function selfHealStalePage() {
  try { ensureDetailEditor(); } catch (e) { /* 忽略自愈自身异常，不影响 init */ }
  try { ensureArchivedSection(); } catch (e) { /* 忽略 */ }
  try { ensureShareSection(); } catch (e) { /* 忽略 */ }
  try { ensureCommentsSection(); } catch (e) { /* 忽略 */ }
})();

function ensureDetailEditor() {
  if (document.getElementById('deDesc')) return;               // 已是最新页，无需注入
  if (document.getElementById('__deInjStyle')) return;         // 已注入过，避免重复
  const CSS = [
    '.detail-editor{display:grid;grid-template-columns:minmax(0,1.12fr) minmax(0,0.88fr);gap:16px;align-items:start}',
    '@media(max-width:980px){.detail-editor{grid-template-columns:1fr}}',
    '.de-preview-label{font-size:12px;color:var(--muted);margin-bottom:10px;text-align:center}',
    '.de-phone{margin:0 auto;width:330px;max-width:100%;background:#111;border-radius:40px;padding:9px;box-shadow:0 18px 48px rgba(0,0,0,.30);position:relative}',
    '.de-notch{position:absolute;top:13px;left:50%;transform:translateX(-50%);width:110px;height:20px;background:#111;border-radius:0 0 13px 13px;z-index:4}',
    '.de-screen{background:#fff;border-radius:31px;height:712px;overflow-y:auto;overflow-x:hidden;position:relative;padding-top:30px;font-size:13px;line-height:1.5;color:#1c1f24}',
    '.de-empty{text-align:center;color:var(--muted);padding:60px 22px}',
    '.pv-cover{width:100%;display:block;background:#eef1f8}',
    '.pv-head{padding:12px 12px 0}',
    '.pv-cat{display:inline-block;padding:2px 11px;border-radius:8px;background:#e7edff;color:#1d39c4;font-size:11px;font-weight:500}',
    '.pv-title{font-size:18px;font-weight:700;line-height:1.35;margin-top:8px}',
    '.pv-stats{display:flex;gap:14px;margin-top:9px;font-size:12px;color:#6b7280}',
    '.pv-pricerow{display:flex;align-items:center;justify-content:space-between;margin-top:13px}',
    '.pv-price{font-size:22px;font-weight:700;color:#b35c00}',
    '.pv-price small{font-size:12px;font-weight:500;margin-left:2px}',
    '.pv-cta{background:#faad14;color:#fff;border:none;border-radius:999px;padding:9px 24px;font-size:14px;font-weight:600}',
    '.pv-cta:disabled{opacity:.5}',
    '.pv-info{margin:12px 12px 0}',
    '.pv-info-row{display:flex;gap:8px;padding:7px 0;border-bottom:1px solid #eef1f5;font-size:12.5px}',
    '.pv-info-row .k{flex:none;width:54px;color:#6b7280}',
    '.pv-info-row .v{flex:1}',
    '.pv-reminder{margin:12px 12px 0;display:flex;gap:8px;background:#fff8ec;border-radius:10px;padding:10px 12px;font-size:12.5px;color:#92400e}',
    '.pv-consent{margin:10px 12px 0;font-size:12px;color:#b91c1c}',
    '.pv-detail{margin:15px 12px 0}',
    '.pv-detail-title{font-size:14px;font-weight:600;margin-bottom:9px}',
    '.pv-desc{font-size:12.5px;color:#475069;line-height:1.75;white-space:pre-wrap}',
    '.pv-opts{margin:15px 12px 0}',
    '.pv-opt{display:flex;align-items:center;justify-content:space-between;padding:9px 0;border-bottom:1px solid #eef1f5;font-size:12.5px}',
    '.pv-opt .pn{font-weight:600}',
    '.pv-opt .pp{color:#b35c00;font-weight:700}',
    '.pv-cta2{padding:14px 12px 20px}.pv-cta2 .btn{width:100%;text-align:center}',
    '.filebtn{font-size:12px}',
    '.de-cf-row{display:flex;gap:6px;align-items:center;margin-bottom:6px;flex-wrap:wrap}',
    '.de-cf-row input.de-cf-label{flex:2;min-width:120px}',
    '.de-cf-row input.de-cf-key{flex:1;min-width:90px;font-family:ui-monospace,Consolas,monospace}',
    '.de-cf-row .de-cf-req{display:inline-flex;align-items:center;gap:4px;font-size:12px;color:#6b7280;white-space:nowrap}',
    '.de-cf-row .de-cf-type{flex:none;min-width:0;width:108px;height:30px;padding:0 6px;border:1px solid var(--line);border-radius:6px;background:#fff;color:#374151}',
    '.de-cf-row .de-cf-del{width:26px;height:26px;border:none;border-radius:6px;background:#fee2e2;color:#b91c1c;cursor:pointer;font-size:15px;line-height:1}',
    '.de-cf-row .de-cf-options{flex:1 1 100%;width:100%;font-size:12.5px;line-height:1.6;border:1px solid var(--line);border-radius:6px;padding:6px 8px;box-sizing:border-box;font-family:inherit}',
    '.de-cf-add{margin-top:4px;font-size:12px}',
    '.form .field{display:flex;flex-direction:column;gap:4px;font-size:13px;color:#374151}',
    '.form .f-label{font-size:13px;color:#374151}',
    '.de-rt-toolbar{display:flex;gap:4px;flex-wrap:wrap;margin-bottom:6px}',
    '.de-rt-toolbar button{min-width:34px;height:28px;padding:0 9px;border:1px solid var(--line);border-radius:6px;background:#fff;color:#374151;font-size:13px;cursor:pointer;line-height:1}',
    '.de-rt-toolbar button:hover{background:#f3f4f6}',
    '.de-rt-body{min-height:120px;max-height:320px;border:1px solid var(--line);border-radius:8px;padding:10px 12px;font-size:13.5px;line-height:1.7;color:#1f2937;background:#fff;outline:none;overflow-y:auto}',
    '.de-rt-body:focus{border-color:var(--brand)}',
    '.de-rt-body:empty:before{content:attr(data-placeholder);color:#9ca3af}',
    '.de-rt-body h3{font-size:16px;font-weight:700;margin:10px 0 4px}',
    '.de-rt-body ul,.de-rt-body ol{margin:6px 0;padding-left:20px}',
    '.de-rt-body li{margin:3px 0}',
    '.pv-desc h3{font-size:15px;font-weight:700;margin:10px 0 4px}',
    '.pv-desc p{margin:6px 0}',
    '.pv-desc ul,.pv-desc ol{margin:6px 0;padding-left:18px}',
    '.pv-desc li{margin:3px 0}',
    '.pv-desc img{max-width:100%;height:auto;display:block;border-radius:8px;margin:8px 0}',
    '.de-covers{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr);gap:10px;margin:6px 0}',
    '.de-coverbox{min-width:0;border:1px solid var(--line);border-radius:10px;padding:10px;background:#fff}',
    '.de-cover-title{font-size:13px;font-weight:600;color:#374151;margin-bottom:8px}',
    '.de-cover-title .muted{font-weight:400}',
    '.de-coverprev{display:block;width:100%;max-width:100%;height:auto;aspect-ratio:3/2;object-fit:cover;border-radius:8px;background:#f3f4f6;margin-bottom:8px}',
    '.de-coverbox:nth-child(2) .de-coverprev{aspect-ratio:16/9}',
    '.de-cover-frame{position:relative;overflow:hidden;width:100%;padding-top:66.6667%;border-radius:8px;background:#f3f4f6;margin-bottom:8px}',
    '.de-coverbox:nth-child(2) .de-cover-frame{padding-top:56.25%}',
    '.de-cover-frame .de-coverprev{position:absolute;left:0;top:0;width:auto;height:auto;max-width:none;aspect-ratio:auto;margin:0;border-radius:0}',
    '.de-cover-actions{display:flex;gap:8px;align-items:center;flex-wrap:wrap}',
    '.de-cover-actions .filebtn{flex:none;width:120px;min-width:0}',
    '.de-cover-actions .ghost{flex:none;white-space:nowrap}',
    '.crop-modal{position:fixed;inset:0;background:rgba(15,23,42,.55);display:flex;align-items:center;justify-content:center;z-index:999}',
    '.crop-box{background:#fff;border-radius:14px;padding:16px;width:min(520px,92vw);box-shadow:0 20px 50px rgba(0,0,0,.25)}',
    '.crop-head{font-size:14px;font-weight:600;margin-bottom:10px;display:flex;align-items:baseline;gap:8px}',
    '.crop-stage{position:relative;overflow:hidden;background:#0f172a;border-radius:10px;width:100%;touch-action:none;cursor:grab}',
    '.crop-stage img{position:absolute;left:0;top:0;max-width:none;user-select:none;-webkit-user-select:none;cursor:grab}',
    '.crop-ops{display:flex;gap:8px;align-items:center;margin-top:12px}',
    '.crop-ops .spacer{flex:1}',
    '.crop-ops button{flex:none;white-space:nowrap}',
    '.crop-ratio{font-size:12px}',
    '@supports not (object-fit: cover){.de-coverprev{height:auto!important}}',
  ].join('\n');
  const HTML = ''
    + '<div class="detail-editor">'
    + '  <div class="card de-form">'
    + '    <h2>活动详情编辑 <span class="hint">（左侧改内容，右侧为小程序页面实时预览）</span></h2>'
    + '    <div class="form">'
    + '      <label>活动<select id="deEventSel"></select></label>'
    + '      <label>标题<input id="deTitle" type="text" placeholder="活动标题" /></label>'
    + '      <div class="row2">'
    + '        <label>城市<input id="deCity" type="text" placeholder="城市（如：深圳市）" /></label>'
    + '        <label>短地点名<input id="deLocName" type="text" placeholder="短地点名（如：前海5号楼）" /></label>'
    + '      </div>'
    + '      <label>详细地址<textarea id="deAddr" rows="3" placeholder="详细地址（含门牌/楼层/入口提示）"></textarea></label>'
    + '      <div class="row2">'
    + '        <label>纬度<input id="deLat" placeholder="选填：22.5285（地图 App 长按取坐标）" /></label>'
    + '        <label>经度<input id="deLng" placeholder="选填：113.9030" /></label>'
    + '      </div>'
    + '      <div class="row2"><label>开始<input type="datetime-local" id="deStart" /></label><label>结束<input type="datetime-local" id="deEnd" /></label></div>'
    + '      <div class="row2"><label>报名开始<input type="datetime-local" id="deRegStart" /></label><label>报名截止<input type="datetime-local" id="deRegEnd" /></label></div>'
    + '      <div class="row2"><label>退款规则<select id="deRefundRule"><option value="NO_SELF_REFUND">不可自行退</option><option value="BEFORE_24H">开始前 24h</option><option value="BEFORE_48H">开始前 48h</option><option value="ALLOW_ANY">活动结束前可退</option></select></label></div>'
    + '      <label>活动状态<select id="deStatus"><option value="PUBLISHED">已发布</option><option value="DRAFT">草稿</option><option value="ENDED">已结束</option><option value="OFFLINE">已下架</option><option value="CANCELLED">已取消</option></select></label>'
    + '      <label>提醒<textarea id="deReminder" rows="2" placeholder="活动前提醒（如：提前 15 分钟到场）"></textarea></label>'
    + '      <div class="field">'
    + '        <div class="f-label">自定义报名字段（报名时收集，如：行业/公司/想听的话题）</div>'
    + '        <div id="deCustomFields"></div>'
    + '        <button type="button" class="ghost de-cf-add" id="deCfAdd">＋ 添加字段</button>'
    + '      </div>'
    + '      <div class="field">'
    + '        <div class="f-label">正文详情</div>'
    + '        <div class="de-rt-toolbar">'
    + '          <button type="button" data-cmd="bold" title="加粗"><b>B</b></button>'
    + '          <button type="button" data-cmd="italic" title="斜体"><i>I</i></button>'
    + '          <button type="button" data-cmd="underline" title="下划线"><u>U</u></button>'
    + '          <button type="button" data-cmd="formatBlock" data-val="H3" title="小标题">标题</button>'
    + '          <button type="button" data-cmd="formatBlock" data-val="P" title="正文段落">正文</button>'
    + '          <button type="button" data-cmd="insertUnorderedList" title="无序列表">• 列表</button>'
    + '          <button type="button" id="deRtImg" title="插入图片（上传后插入到光标处，与正文混排）">🖼️ 插图</button>'
    + '          <input type="file" id="deRtImgFile" accept="image/*" style="display:none" />'
    + '        </div>'
    + '        <div id="deDesc" class="de-rt-body" contenteditable="true" data-placeholder="活动详细介绍（支持加粗 / 标题 / 列表 / 插图；小程序详情页展示）"></div>'
    + '      </div>'
    + '      <div class="field">'
    + '        <div class="f-label">封面图（首页卡片与详情大图可分别上传，各自拖拽裁切）</div>'
    + '        <div class="de-covers">'
    + '          <div class="de-coverbox">'
    + '            <div class="de-cover-title">列表封面 <span class="muted">3:2 · 首页卡片</span></div>'
    + '            <div class="de-cover-frame"><img id="deCoverPrev" class="de-coverprev" alt="" /></div>'
    + '            <div class="de-cover-actions">'
    + '              <input type="file" id="deCoverFile" accept="image/*" class="filebtn" />'
    + '              <button type="button" id="deCoverCrop" class="ghost">裁切</button>'
    + '            </div>'
    + '          </div>'
    + '          <div class="de-coverbox">'
    + '            <div class="de-cover-title">详情大图 <span class="muted">16:9 · 详情页顶部</span></div>'
    + '            <div class="de-cover-frame"><img id="deCoverDetailPrev" class="de-coverprev" alt="" /></div>'
    + '            <div class="de-cover-actions">'
    + '              <input type="file" id="deCoverDetailFile" accept="image/*" class="filebtn" />'
    + '              <button type="button" id="deCoverDetailCrop" class="ghost">裁切</button>'
    + '            </div>'
    + '          </div>'
    + '        </div>'
    + '        <span class="muted">选本地图片 → 点「裁切」→ 拖动位置 / 滚轮缩放 → 确认</span>'
    + '      </div>'
    + '      <div class="btns"><button id="deSave" class="primary">保存并发布</button><button id="deReset" class="ghost">重新载入已保存</button></div>'
    + '      <div class="btns" style="margin-top:10px"><button type="button" id="deArchive" class="ghost">归档活动（已结束）</button><button type="button" id="deDelete" class="ghost danger">删除活动</button></div>'
    + '      <p class="muted" style="margin:4px 0 0">归档可恢复；删除会一并移除该活动的票种、报名、支付与签到记录，不可恢复。</p>'
    + '    </div>'
    + '  </div>'
    + '  <div class="de-preview"><div class="de-preview-label">小程序 · 活动详情页预览（等比例）</div>'
    + '    <div class="de-phone"><div class="de-notch"></div><div class="de-screen" id="deScreen"><div class="de-empty">选择左侧活动后开始编辑</div></div></div>'
    + '  </div>'
    + '</div>';
  const style = document.createElement('style');
  style.id = '__deInjStyle';
  style.textContent = CSS;
  (document.head || document.documentElement).appendChild(style);
  const sec = document.getElementById('tab-detail');
  if (sec) {
    sec.innerHTML = HTML;
  } else {
    const d = document.createElement('section');
    d.id = 'tab-detail'; d.className = 'tab';
    d.innerHTML = HTML;
    const tabs = document.querySelector('#tabs');
    if (tabs && tabs.parentNode && tabs.parentNode.insertBefore) {
      tabs.parentNode.insertBefore(d, tabs.nextSibling);
    } else {
      (document.body || document.documentElement).appendChild(d);
    }
  }
}

// ── 全局错误可视化（诊断）：任何 JS 错误都显示为页面顶部红条，便于定位 ──
window.__errs = [];
function reportErr(msg) {
  try {
    window.__errs.push(String(msg));
    let b = document.getElementById('__errBanner');
    if (!b) {
      b = document.createElement('div');
      b.id = '__errBanner';
      b.style.cssText = 'position:fixed;left:0;right:0;top:0;z-index:99999;background:#b91c1c;color:#fff;padding:6px 12px;font:13px/1.5 system-ui,sans-serif;box-shadow:0 2px 8px rgba(0,0,0,.35);white-space:pre-wrap';
      (document.body || document.documentElement).appendChild(b);
    }
    b.textContent = '⚠ JS 错误: ' + String(msg) + '（最近共 ' + window.__errs.length + ' 个）';
  } catch { /* 忽略诊断自身的异常 */ }
}
window.addEventListener('error', (ev) => reportErr((ev.message || 'error') + (ev.lineno ? ' @line ' + ev.lineno : '')));
window.addEventListener('unhandledrejection', (ev) => reportErr((ev.reason && (ev.reason.message || ev.reason)) || 'unhandled rejection'));

const state = {
  userToken: localStorage.getItem('cl_token') || null,
  adminToken: sessionStorage.getItem('cl_admin') || null,
  user: null,
  events: [],
  mockPay: false,
  regPage: 1, // 报名名单当前页
  regPageSize: 15, // 后台每页 15 条
  _deEventId: null, // 活动详情编辑器：当前编辑的活动 id
  _deCover: null, // 封面图（URL 或 base64 dataURL）
  _shares: [], // 分享列表缓存（后台「分享」tab）
  _comments: [], // 评论管理缓存（树形：根评论 + replies）
  _cmtExpanded: {}, // 评论管理：根评论展开状态 { rootId: bool }
};

// ───────────── 通用 ─────────────
function toast(msg, type = 'info') {
  const el = $('#toast');
  el.textContent = msg;
  el.className = `toast show ${type}`;
  clearTimeout(toast._t);
  toast._t = setTimeout(() => { el.className = 'toast'; }, 3200);
}

async function api(method, url, { body, kind = 'user' } = {}) {
  // 防御：URL 去掉尾斜杠（如 /events/ → /events），避免空 id 拼接产生的 404
  url = url.replace(/\/+$/, '') || '/';
  const headers = {};
  if (body) headers['Content-Type'] = 'application/json';
  const token = kind === 'admin' ? state.adminToken : kind === 'staff' ? (state.adminToken || state.userToken) : state.userToken;
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(url, { method, headers, body: body ? JSON.stringify(body) : undefined });
  let json = null;
  try { json = await res.json(); } catch { /* 非 JSON（CSV 等） */ }
  if (!res.ok) {
    const msg = (json && (json.error || json.message)) || `HTTP ${res.status}`;
    const err = new Error(msg);
    err.status = res.status;
    err.json = json;
    throw err;
  }
  return json;
}

const fmtTime = (iso) => (iso ? new Date(iso).toLocaleString('zh-CN', { hour12: false }) : '—');
const statusZh = {
  PENDING: '待支付', PAID: '已支付', CANCELLED: '已取消', REFUNDING: '退款中', REFUNDED: '已退款',
};

// ───────────── 登录 ─────────────
async function ensureUser() {
  if (state.userToken) {
    try {
      const me = await api('GET', '/me', { kind: 'user' });
      state.user = me;
      return;
    } catch { localStorage.removeItem('cl_token'); state.userToken = null; }
  }
  const r = await api('POST', '/auth/wechat-login', { body: { code: 'harness_user_1' } });
  state.userToken = r.token;
  state.user = r.user;
  localStorage.setItem('cl_token', r.token);
}

function refreshUserBadge() {
  $('#userBadge').textContent = state.user ? `${state.user.nickname || '用户'}（#${state.user.userId}）` : '未登录';
}

// ───────────── 活动 ─────────────
async function loadEvents() {
  state.events = await api('GET', '/events');
  renderEventList();
  fillEventSelects();
  dePopulate();
}

function renderEventList() {
  const wrap = $('#eventList');
  if (!state.events.length) { wrap.innerHTML = '<p class="muted">暂无已发布活动</p>'; return; }
  wrap.innerHTML = state.events.map((e) => {
    // 名额 = Σ(正票种购票上限×权重)，任一票种不限量 → 不显示
    const capBadge = e.full
      ? '<span class="badge full">名额已满</span>'
      : (e.total_capacity != null ? `<span class="badge open">余 ${e.remaining_capacity}/${e.total_capacity}</span>` : '');
    return `
    <div class="eventcard">
      <div class="evtitle">${esc(e.title)} ${capBadge}</div>
      <div class="evmeta">
        <div>${esc(e.subtitle || '')}</div>
        <div class="muted">📍 ${esc(e.location_name || '—')} · ${fmtTime(e.start_time)}</div>
        <div class="muted">报名 ${fmtTime(e.registration_start_time)} ~ ${fmtTime(e.registration_end_time)} · 退款：${refundZh(e.refund_rule)}</div>
      </div>
      <div class="evopts">${(e.registrationOptions || []).map((o) => { const t = o.option_type || 'SINGLE'; const tl = { SINGLE: '单人', DOUBLE: '双人', INVITE: '邀请', WAITLIST: '候补' }[t] || t; return `<span class="opt"><span class="opttype ${t}">${tl}</span> ${esc(o.name)} · ${esc(o.price_display)} <button type="button" class="optedit" data-event="${e.id}" data-opt="${o.id}">编辑</button></span>`; }).join('')}</div>
      <div class="evactions"><button type="button" class="link" data-view="${e.id}">查看</button><button type="button" class="link" data-edit="${e.id}">编辑活动</button></div>
    </div>`;
  }).join('');
}

/** 「查看 / 编辑活动」：把活动载入详情编辑区（正文/图片预览/活动设置）并切到「活动详情」标签。 */
function viewEvent(id) {
  const deSel = $('#deEventSel');
  if (deSel && Array.from(deSel.options).some((o) => Number(o.value) === id)) deSel.value = String(id);
  deLoadEvent(id);
  // 「活动详情」现在是「活动」顶级 tab 下的子 tab
  switchTab('events');
  switchSubTab('events', 'detail');
}

/** 删除某活动下的票种（§ ②）：已有报名会 409，给出提示。 */
async function deleteOption(optId, evId) {
  if (!confirm(`删除该票种？\n若该票种已有报名将无法删除（系统会提示）。`)) return;
  try {
    await api('DELETE', `/admin/events/${evId}/options/${optId}`, { kind: 'admin' });
    toast('票种已删除', 'ok');
    await loadEvents();
  } catch (err) { toast(err.message, 'err'); }
}

/** 详情编辑器：归档活动（状态置为 ENDED），可恢复。 */
async function deArchive() {
  const id = state._deEventId;
  if (!id) { toast('请先选择活动', 'info'); return; }
  if (!confirm('将该活动归档（状态置为「已结束」）？用户将无法再报名。')) return;
  try {
    await api('POST', `/admin/events/${id}/status`, { body: { status: 'ENDED' }, kind: 'admin' });
    toast(`活动 #${id} 已归档（已结束）`, 'ok');
    await loadEvents(); if (state._deEventId) deLoadEvent(state._deEventId);
  } catch (err) { toast(err.message, 'err'); }
}

/** 详情编辑器：删除活动（不可逆）：级联删除票种/报名/支付/退款/签到。 */
async function deDelete() {
  const id = state._deEventId;
  if (!id) { toast('请先选择活动', 'info'); return; }
  if (!confirm(`确认删除活动 #${id}？\n将一并删除该活动的票种、报名、支付与签到记录，且不可恢复！`)) return;
  try {
    await api('DELETE', `/admin/events/${id}`, { kind: 'admin' });
    toast(`活动 #${id} 已删除`, 'ok');
    state._deEventId = null;
    const sel = $('#deEventSel'); if (sel) sel.value = '';
    await loadEvents();
  } catch (err) { toast(err.message, 'err'); }
}

/** 删除归档活动（不可逆）：级联删除票种/报名/支付/退款/签到，删除后刷新归档列表。 */
async function deleteArchivedEvent(id, title) {
  const label = title || ('#' + id);
  if (!confirm(`确认永久删除「${label}」？\n将一并删除该活动的票种、报名、支付与签到记录，且不可恢复！`)) return;
  try {
    await api('DELETE', `/admin/events/${id}`, { kind: 'admin' });
    toast(`「${label}」已永久删除`, 'ok');
    diag('删除归档活动 ' + label + ' 成功，刷新列表');
    await loadArchived();
  } catch (err) { diag('删除归档活动失败: ' + err.message); toast(err.message, 'err'); }
}

// ───────────── 分享管理（「分享」tab：现场视频 / 网课 / 知识文字） ─────────────
let _shEditId = null;
let _shCover = null;
const SHARE_TYPE_ZH = { VIDEO: '现场视频', COURSE: '网课', TEXT: '知识文字' };
const SHARE_STATUS_ZH = { PUBLISHED: '已发布', DRAFT: '草稿', OFFLINE: '已下架' };

async function loadShares() {
  const wrap = $('#shareList');
  diag('loadShares 开始 | #shareList=' + (document.getElementById('shareList') ? '存在' : '缺失')
    + ' | #formShare=' + (document.getElementById('formShare') ? '存在' : '缺失')
    + ' | #tab-share=' + (document.getElementById('tab-share') ? '存在' : '缺失')
    + ' | #shTitle=' + (document.getElementById('shTitle') ? '存在' : '缺失')
    + ' | adminToken=' + (state.adminToken ? '有(' + state.adminToken.length + ')' : '无'));
  if (!wrap) { diag('loadShares: #shareList 缺失，终止'); return; }
  try {
    const list = await api('GET', '/admin/shares', { kind: 'admin' });
    diag('loadShares 成功 | 条数=' + (Array.isArray(list) ? list.length : '非数组'));
    if (!Array.isArray(list)) throw new Error('返回数据异常');
    state._shares = list;
    wrap.innerHTML = list.length
      ? list.map((s) => `
        <div class="shareitem">
          <div class="sh-top">
            <span class="badge">${SHARE_TYPE_ZH[s.type] || s.type} · ${SHARE_STATUS_ZH[s.status] || s.status}</span>
            <span class="muted">排序 ${s.sort_order ?? 0}</span>
          </div>
          <div class="sh-title">${esc(s.title)}</div>
          ${s.summary ? `<div class="muted">${esc(s.summary)}</div>` : ''}
          ${s.video_url ? `<div class="muted">🎬 ${esc(s.video_url)}</div>` : ''}
          <div class="sh-actions">
            <button type="button" class="ghost" data-edit="${s.id}">编辑</button>
            <button type="button" class="ghost ${s.status === 'PUBLISHED' ? 'danger' : ''}" data-status="${s.id}" data-next="${s.status === 'PUBLISHED' ? 'OFFLINE' : 'PUBLISHED'}">${s.status === 'PUBLISHED' ? '下架' : '发布'}</button>
            <button type="button" class="ghost danger" data-del="${s.id}">删除</button>
          </div>
        </div>`).join('')
      : '<span class="muted">暂无分享内容，在右侧新增</span>';
  } catch (e) { wrap.innerHTML = `<span class="muted">加载失败：${esc(e.message)}</span>`; diag('loadShares 失败: ' + e.message); }
}

// ───────────── 分享归档（已下架的分享） ─────────────
async function loadShareArchived() {
  const wrap = $('#shareArchivedList');
  if (!wrap) return;
  try {
    const list = await api('GET', '/admin/shares', { kind: 'admin' });
    const arch = (Array.isArray(list) ? list : []).filter((s) => s.status === 'OFFLINE');
    wrap.innerHTML = arch.length
      ? arch.map((s) => `
        <div class="shareitem">
          <div class="sh-top">
            <span class="badge ghost">已下架</span>
            <span class="muted">排序 ${s.sort_order ?? 0}</span>
          </div>
          <div class="sh-title">${esc(s.title)}</div>
          ${s.summary ? `<div class="muted">${esc(s.summary)}</div>` : ''}
          <div class="sh-actions">
            <button type="button" class="ghost" data-shrestore="${s.id}">恢复发布</button>
            <button type="button" class="ghost danger" data-del="${s.id}">删除</button>
          </div>
        </div>`).join('')
      : '<span class="muted">暂无下架的分享</span>';
  } catch (e) { wrap.innerHTML = `<span class="muted">加载失败：${esc(e.message)}</span>`; }
}

/** 恢复发布（归档分享 → 已发布）。 */
async function shRestore(id) {
  await shSetStatus(Number(id), 'PUBLISHED');
  loadShareArchived();
}

// ───────────── 论坛帖子管理（后台） ─────────────
/** 加载论坛帖子列表（ACTIVE=已发布 / ARCHIVED=归档）。 */
async function loadForumPosts(status = 'ACTIVE') {
  const isArch = status === 'ARCHIVED';
  const wrap = document.getElementById(isArch ? 'forumArchivedList' : 'forumList');
  if (!wrap) return;
  try {
    const list = await api('GET', `/admin/posts?status=${status}`, { kind: 'admin' });
    wrap.innerHTML = (Array.isArray(list) && list.length)
      ? list.map((p) => `
        <div class="forumitem">
          <div class="fo-top">
            <span class="badge ${isArch ? 'ghost' : ''}">${isArch ? '已归档' : '已发布'}</span>
            <span class="fo-author">${esc(p.author.nickname)}</span>
            <span class="muted fo-time">${esc(p.created_at || '')}</span>
          </div>
          <div class="fo-title">${esc(p.title)}</div>
          <div class="fo-stats">👁 ${p.view_count} · 👍 ${p.like_count} · 💬 ${p.comment_count}</div>
          <div class="sh-actions">
            ${isArch
              ? `<button type="button" class="ghost" data-prestore="${p.id}">恢复</button>`
              : `<button type="button" class="ghost danger" data-parchive="${p.id}">归档</button>`}
            <button type="button" class="ghost danger" data-pdel="${p.id}">删除</button>
          </div>
        </div>`).join('')
      : '<span class="muted">暂无' + (isArch ? '归档' : '') + '帖子</span>';
  } catch (e) { wrap.innerHTML = `<span class="muted">加载失败：${esc(e.message)}</span>`; }
}

async function forumArchive(id) {
  await api('POST', `/admin/posts/${id}/archive`, { kind: 'admin' });
  toast('已归档', 'ok');
  loadForumPosts('ACTIVE');
  loadForumPosts('ARCHIVED');
}

async function forumRestore(id) {
  await api('POST', `/admin/posts/${id}/restore`, { kind: 'admin' });
  toast('已恢复', 'ok');
  loadForumPosts('ACTIVE');
  loadForumPosts('ARCHIVED');
}

async function forumDel(id) {
  if (!confirm(`删除帖子 #${id}？\n其下评论与点赞会一并删除，不可恢复。`)) return;
  try {
    await api('DELETE', `/admin/posts/${id}`, { kind: 'admin' });
    toast('已删除', 'ok');
    loadForumPosts('ACTIVE');
    loadForumPosts('ARCHIVED');
  } catch (e) { toast('删除失败：' + e.message, 'err'); }
}

// ───────────── 评论管理（后台看板：按类型分 tab 展示） ─────────────
/** 加载评论并渲染到指定容器（filter: ALL/SHARE/EVENT/POST；wrapId 为目标 cmtlist 容器 id）。 */
async function loadComments(filter = 'ALL', wrapId = 'cmtList') {
  state._lastCmt = { filter, wrapId }; // 记录当前上下文，供删除/展开后重绘用
  ensureCommentsSection(); // 兜底：缓存旧页缺容器时现场注入
  const wrap = document.getElementById(wrapId);
  diag('loadComments 开始 | filter=' + filter + ' | #' + wrapId + '=' + (wrap ? '存在' : '缺失')
    + ' | adminToken=' + (state.adminToken ? '有(' + state.adminToken.length + ')' : '无'));
  if (!wrap) { diag('loadComments: #' + wrapId + ' 缺失，终止'); return; }
  try {
    const list = await api('GET', '/admin/comments', { kind: 'admin' });
    diag('loadComments 成功 | 条数=' + (Array.isArray(list) ? list.length : '非数组'));
    state._comments = Array.isArray(list) ? list : [];
    renderComments();
  } catch (e) {
    wrap.innerHTML = `<span class="muted">加载失败：${esc(e.message)}</span>`;
    diag('loadComments 失败: ' + e.message);
  }
}

function renderComments() {
  const cur = state._lastCmt || { filter: 'ALL', wrapId: 'cmtList' };
  const wrap = document.getElementById(cur.wrapId);
  if (!wrap) return;
  const list = (state._comments || []).filter((c) => cur.filter === 'ALL' || c.target_type === cur.filter);
  wrap.innerHTML = list.length
    ? list.map((c) => {
        const typeZh = c.target_type === 'SHARE' ? '分享' : c.target_type === 'POST' ? '帖子' : '活动';
        const reps = c.replies || [];
        const n = reps.length;
        const expanded = !!state._cmtExpanded[c.id];
        // 折叠时只显示最新 1 条回复（replies 时间正序，最后一条最新），其余展开后可见
        const visible = expanded ? reps : reps.slice(-1);
        const repliesHtml = n
          ? `<div class="cmt-replies">${visible
              .map(
                (r) => `<div class="cmt-r">
                  <span class="cmt-r-name">${esc(r.nickname)}</span>
                  ${r.reply_to_nickname ? `<span class="cmt-r-at">回复 @${esc(r.reply_to_nickname)}：</span>` : ''}
                  <span class="cmt-r-content">${esc(r.content)}</span>
                  <span class="cmt-r-like">👍 ${r.like_count || 0}</span>
                  <button type="button" class="ghost danger cmt-r-del" data-cmtdel="${r.id}" title="删除这条回复">删除</button>
                </div>`
              )
              .join('')}${n > 1 ? `<div class="cmt-expand"><button type="button" class="ghost" data-cmtexpand="${c.id}">${expanded ? '收起回复' : `展开全部 ${n} 条回复`}</button></div>` : ''}</div>`
          : '';
        return `<div class="cmtitem">
          <div class="cmt-top">
            <span class="badge">${typeZh}</span>
            <span class="cmt-target" title="目标 #${c.target_id}">${esc(c.target_title)}</span>
            <span class="badge ghost">${n} 条回复</span>
            <span class="cmt-like">👍 ${c.like_count || 0}</span>
          </div>
          <div class="cmt-body">${esc(c.content)}</div>
          <div class="cmt-meta">${esc(c.nickname)} · ${esc(c.created_at)}</div>
          <div class="sh-actions">
            <button type="button" class="ghost danger" data-cmtdel="${c.id}">删除评论</button>
          </div>
          ${repliesHtml}
        </div>`;
      }).join('')
    : '<span class="muted">暂无评论</span>';
}

function toggleCmtReplies(id) {
  state._cmtExpanded[Number(id)] = !state._cmtExpanded[Number(id)];
  renderComments();
}

async function delComment(id) {
  // 树形数据：在根评论或某条回复里找目标
  let tip = '';
  let found = (state._comments || []).find((x) => x.id === Number(id));
  if (found) tip = '\n（根评论，会连同其下回复一起删除）';
  else {
    for (const c of state._comments || []) {
      const r = (c.replies || []).find((x) => x.id === Number(id));
      if (r) { found = r; break; }
    }
  }
  if (!confirm(`确定删除这条${found && (found.content ? '评论' : '回复')}？${tip}\n删除后不可恢复。`)) return;
  try {
    await api('DELETE', `/admin/comments/${id}`, { kind: 'admin' });
    toast('已删除', 'ok');
    await loadComments();
  } catch (e) { toast('删除失败：' + e.message, 'err'); }
}

function shFillForm(s) {
  _shEditId = s.id;
  $('#shType').value = s.type || 'TEXT';
  $('#shStatus').value = s.status || 'PUBLISHED';
  $('#shTitle').value = s.title || '';
  $('#shSummary').value = s.summary || '';
  $('#shVideoUrl').value = s.video_url || '';
  // 正文：富文本 HTML 直接回显；旧纯文本转 <br> 保持换行
  const raw = s.content || '';
  const rt = $('#shContent'); if (rt) rt.innerHTML = raw.indexOf('<') >= 0 ? raw : raw.replace(/\n/g, '<br/>');
  $('#shSort').value = s.sort_order ?? 0;
  _shCover = s.cover_image || null;
  shRenderCover();
  const h = $('#shEditHint'); if (h) { h.style.display = ''; $('#shEditId').textContent = s.id; $('#shEditLabel').textContent = s.title || ''; }
}

function shRenderCover() {
  const f = $('#shCoverFrame'); const img = $('#shCoverPrev');
  if (!f || !img) return;
  if (_shCover) {
    f.style.display = 'block';
    img.src = _shCover;
    const run = () => fitCover(img, f.clientWidth || 300, f.clientHeight || Math.round((f.clientWidth || 300) * 2 / 3));
    if (img.complete && img.naturalWidth) run(); else { img.onload = run; img.onerror = null; }
  } else { f.style.display = 'none'; img.removeAttribute('src'); }
}

async function shSave() {
  const body = {
    type: $('#shType').value, status: $('#shStatus').value,
    title: ($('#shTitle').value || '').trim(),
    summary: ($('#shSummary').value || '').trim(),
    coverImage: _shCover,
    videoUrl: ($('#shVideoUrl').value || '').trim(),
    content: ($('#shContent').innerHTML || '').trim(),
    sortOrder: Number($('#shSort').value) || 0,
  };
  // 纯文本（无 HTML）时保持换行语义；有 HTML（富文本/插图）时原样保存
  if (body.content && !/<[a-z][\s\S]*>/i.test(body.content) && body.content.indexOf('<br') < 0) {
    body.content = body.content.replace(/\n/g, '<br/>');
  }
  if (!body.title) { toast('请填写分享标题', 'err'); return; }
  if ((body.type === 'VIDEO' || body.type === 'COURSE') && !body.videoUrl) { toast('现场视频 / 网课请填写视频链接（mp4 直链）', 'err'); return; }
  if (body.type === 'TEXT' && !body.content) { toast('知识文字请填写正文内容', 'err'); return; }
  if (_shEditId) { await api('PUT', `/admin/shares/${_shEditId}`, { body, kind: 'admin' }); toast('分享已更新', 'ok'); }
  else { await api('POST', '/admin/shares', { body, kind: 'admin' }); toast('分享已创建', 'ok'); }
  shResetForm();
  await loadShares();
}

function shResetForm() {
  _shEditId = null; _shCover = null;
  const f = $('#formShare'); if (f) f.reset();
  const sort = $('#shSort'); if (sort) sort.value = 0;
  const rt = $('#shContent'); if (rt) rt.innerHTML = '';
  shRenderCover();
  const h = $('#shEditHint'); if (h) h.style.display = 'none';
}

/** 发布 / 下架切换（保留其余字段）。 */
async function shSetStatus(id, next) {
  const s = (state._shares || []).find((x) => x.id === id);
  if (!s) return;
  const body = {
    type: s.type, status: next, title: s.title,
    summary: s.summary || '', coverImage: s.cover_image || null,
    videoUrl: s.video_url || '', content: s.content || '', sortOrder: s.sort_order ?? 0,
  };
  await api('PUT', `/admin/shares/${id}`, { body, kind: 'admin' });
  toast(next === 'PUBLISHED' ? '已发布' : '已下架', 'ok');
  await loadShares();
}

/** 恢复上架（ENDED/OFFLINE/CANCELLED → PUBLISHED）：活动回到「活动」列表。 */
async function restoreArchivedEvent(id, title) {
  const label = title || ('#' + id);
  if (!confirm(`恢复上架「${label}」？\n状态将改为「已发布」，活动回到「活动」列表。`)) return;
  try {
    await api('POST', `/admin/events/${id}/status`, { body: { status: 'PUBLISHED' }, kind: 'admin' });
    toast(`「${label}」已恢复上架`, 'ok');
    diag('恢复上架 ' + label + ' 成功');
    await loadArchived();
    await loadEvents();
  } catch (err) { diag('恢复上架失败: ' + err.message); toast(err.message, 'err'); }
}

const refundZh = (r) => ({ NO_SELF_REFUND: '不可自行退', BEFORE_24H: '开始前 24h', BEFORE_48H: '开始前 48h', ALLOW_ANY: '结束前可退' }[r] || r);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function fillEventSelects() {
  for (const sel of [$('#regEventSel'), $('#optEventSel'), $('#phoneEventSel'), $('#f_event')]) {
    if (!sel) continue;
    const first = sel.querySelector('option')?.value;
    sel.innerHTML = state.events.map((e) => `<option value="${e.id}">${esc(e.title)}</option>`).join('');
    if (first && sel.querySelector(`option[value="${first}"]`)) sel.value = first;
  }
  const regSel = $('#regEventSel');
  if (regSel) refreshOptionSelect();
}

async function refreshOptionSelect() {
  const evId = String($('#regEventSel')?.value || '');
  const optSel = $('#regOptionSel');
  if (!/^\d+$/.test(evId) || !optSel) return; // 必须是纯数字活动 id
  try {
    const ev = await api('GET', `/events/${evId}`);
    optSel.innerHTML = (ev.registrationOptions || []).map((o) => `<option value="${o.id}">${esc(o.name)} · ${esc(o.price_display)}</option>`).join('');
  } catch { optSel.innerHTML = '<option value="">无可用报名类型</option>'; }
}

// ───────────── 后台登录 ─────────────
async function ensureAdmin() {
  if (state.adminToken) return true;
  return false;
}

async function adminLogin(username, password) {
  const r = await api('POST', '/admin/auth/login', { body: { username, password }, kind: 'admin' });
  state.adminToken = r.token;
  sessionStorage.setItem('cl_admin', r.token);
  return r;
}

async function loadAdminDash() {
  await loadAdminRegsSub();
}

/** 后台子 tab：报名管理（统计 + 报名名单）。 */
async function loadAdminRegsSub() {
  state.regPage = 1;
  const p = new URLSearchParams(); p.set('page', 1); p.set('pageSize', state.regPageSize);
  const [stats, regs] = await Promise.all([
    api('GET', '/admin/stats', { kind: 'admin' }),
    api(`GET`, `/admin/registrations?${p}`, { kind: 'admin' }),
  ]);
  renderStats(stats);
  renderAdminRegs(regs);
}

/** 后台子 tab：签到记录。 */
async function loadAdminCheckinsSub() {
  const checkins = await api('GET', '/admin/checkins', { kind: 'admin' });
  renderAdminCheckins(checkins);
}

/** 后台子 tab：统计（参加次数）。 */
async function loadAdminStatsSub() {
  queryAttendance().catch(() => {});
}

/** 参加次数统计：按「参加次数 ≥ N」筛选回头客（§ ②）。 */
async function queryAttendance() {
  const el = $('#f_attend_stat');
  const attend = el ? el.value.trim() : '';
  const url = attend ? `/admin/attendance?minAttend=${encodeURIComponent(attend)}` : '/admin/attendance';
  const a = await api('GET', url, { kind: 'admin' });
  renderAttendance(a);
}

function renderStats(s) {
  const yuan = (c) => `¥${(c / 100).toFixed(2)}`;
  $('#adminStats').innerHTML = `
    <div class="stat"><div class="n">${s.paid}</div><div class="l">已支付</div></div>
    <div class="stat"><div class="n">${s.pending}</div><div class="l">待支付</div></div>
    <div class="stat"><div class="n">${s.checked_in}</div><div class="l">已签到</div></div>
    <div class="stat"><div class="n">${s.refunded}</div><div class="l">已退款</div></div>
    <div class="stat waitlist"><div class="n">${s.waitlist ?? 0}</div><div class="l">候补人数</div></div>
    <div class="stat"><div class="n">${yuan(s.revenue_cents)}</div><div class="l">已收款</div></div>`;
}

function renderAdminRegs(r) {
  const optTypeZh = { SINGLE: '单人', DOUBLE: '双人', INVITE: '邀请', WAITLIST: '候补' };
  const rows = (r.items || []).map((i) => {
    const t = i.option_type || 'SINGLE';
    const isWait = t === 'WAITLIST';
    const isDouble = t === 'DOUBLE';
    const progress = isWait
      ? '<span class="badge waitlist">候补中</span>'
      : isDouble ? `<b>${(i.checked_count ?? 0)}/2</b>${i.all_checked_in ? ' ✓ 全核销' : ''}`
      : (i.checked_in ? `✅ ${fmtTime(i.checked_in_at)}` : '—');
    const fdBits = [];
    try {
      const fd = JSON.parse(i.form_data || '{}');
      if (fd && typeof fd === 'object') {
        if (fd.custom && typeof fd.custom === 'object') {
          Object.keys(fd.custom).forEach((k) => { const v = fd.custom[k]; if (v) fdBits.push(`${k}：${String(v)}`); });
        }
        if (fd.remark) fdBits.push(`备注：${String(fd.remark)}`);
      }
    } catch { /* 容错坏数据 */ }
    const fdCell = fdBits.length ? `<span class="reg-fd muted">${esc(fdBits.join('<br>'))}</span>` : '—';
    return `
    <tr class="${isWait ? 'row-waitlist' : ''}">
      <td>${esc(i.registration_no)}</td>
      <td>${esc(i.name)}</td>
      <td>${i.attend_event_count > 0 ? `<b>${i.attend_event_count}</b> 场` : '—'}</td>
      <td>${esc(i.phone)}</td>
      <td>${esc(i.event_title)}</td>
      <td>${esc(i.option_name)} <span class="opttype ${t}">${optTypeZh[t] || t}</span></td>
      <td class="fd-cell">${fdCell}</td>
      <td>${esc(statusZh[i.status] || i.status)}</td>
      <td>${progress}</td>
      <td>${isWait ? '—' : fmtTime(i.paid_at)}</td>
    </tr>`;
  }).join('');
  $('#adminRegs').innerHTML = `<table><thead><tr><th>报名编号</th><th>姓名</th><th>参加次数</th><th>手机号</th><th>活动</th><th>票种</th><th>报名信息</th><th>支付状态</th><th>核销进度</th><th>支付时间</th></tr></thead><tbody>${rows || '<tr><td colspan=10 class=muted>无数据</td></tr>'}</tbody></table>`;
  renderRegPager(r);
}

function renderAdminCheckins(c) {
  const rows = (c.items || []).map((i) => `
    <tr><td>${esc(i.registration_no)}</td><td>${esc(i.name)}</td><td>${esc(i.event_title)}</td><td>${i.method === 'QR' ? '二维码' : '手机号后四位'}</td><td>${esc(i.operator_name || '—')}</td><td>${fmtTime(i.checked_in_at)}</td></tr>`).join('');
  $('#adminCheckins').innerHTML = `<table><thead><tr><th>编号</th><th>姓名</th><th>活动</th><th>方式</th><th>操作人</th><th>时间</th></tr></thead><tbody>${rows || '<tr><td colspan=6 class=muted>无签到记录</td></tr>'}</tbody></table>`;
}

function renderAttendance(a) {
  const rows = (a.users || []).map((u) => `
    <tr>
      <td>${esc(u.nickname || '—')}</td>
      <td>${esc(u.maskedPhone || '—')}</td>
      <td><b>${u.attend_event_count}</b> 场</td>
      <td>${u.attend_reg_count} 条</td>
      <td>${esc(u.last_attended_at_display || '—')}</td>
      <td>${u.attend_event_count >= 2 ? '🎟️ 回头客' : '首访'}</td>
    </tr>`).join('');
  const filterNote = a.min_attend ? `（已筛选：参加次数 ≥ ${a.min_attend}）` : '';
  $('#adminAttendance').innerHTML = `
    <div class="muted" style="margin-bottom:8px">共 <b>${a.total}</b> 位已核验用户${filterNote}，其中回头客（≥2 场活动）<b>${a.repeat}</b> 位。</div>
    <table><thead><tr><th>用户</th><th>手机号</th><th>参加次数（活动）</th><th>签到记录</th><th>最近签到</th><th>档位</th></tr></thead><tbody>${rows || '<tr><td colspan=6 class=muted>暂无已核验用户</td></tr>'}</tbody></table>`;
}

async function queryAdminRegs(page) {
  if (page) state.regPage = page;
  const p = new URLSearchParams();
  const regNo = $('#f_regNo')?.value.trim(); if (regNo) p.set('registrationNo', regNo);
  const name = $('#f_name')?.value.trim(); if (name) p.set('name', name);
  const attend = $('#f_attend')?.value.trim(); if (attend) p.set('minAttend', attend);
  const phone = $('#f_phone')?.value.trim(); if (phone) p.set('phone', phone);
  const ev = $('#f_event')?.value; if (ev) p.set('eventId', ev);
  const optType = $('#f_optType')?.value; if (optType) p.set('optionType', optType);
  const pay = $('#f_pay')?.value; if (pay) p.set('paymentStatus', pay);
  const ci = $('#f_ci')?.value; if (ci) p.set('checkinStatus', ci);
  const paidFrom = $('#f_paidFrom')?.value; if (paidFrom) p.set('paidFrom', paidFrom);
  p.set('page', state.regPage);
  p.set('pageSize', state.regPageSize);
  const r = await api('GET', `/admin/registrations?${p}`, { kind: 'admin' });
  renderAdminRegs(r);
}

/** 报名名单分页条（§ ⑤：每页 15 条，上一页 / 下一页）。 */
function renderRegPager(r) {
  const el = $('#regPager');
  if (!el) return;
  const total = r.total || 0;
  const pageSize = r.pageSize || state.regPageSize;
  const page = r.page || 1;
  const pages = Math.max(1, Math.ceil(total / pageSize));
  el.innerHTML = `
    <button id="regPrev" class="primary" ${page <= 1 ? 'disabled' : ''}>‹ 上一页</button>
    <span class="muted">第 ${page} / ${pages} 页 · 共 ${total} 条</span>
    <button id="regNext" class="primary" ${page >= pages ? 'disabled' : ''}>下一页 ›</button>`;
  const prev = $('#regPrev'); if (prev) prev.onclick = () => queryAdminRegs(page - 1).catch((e) => toast(e.message, 'err'));
  const next = $('#regNext'); if (next) next.onclick = () => queryAdminRegs(page + 1).catch((e) => toast(e.message, 'err'));
}

/** 导出 CSV：普通 <a href> 带不上 Authorization token，改用 fetch + blob 触发下载。 */
async function downloadCsv() {
  if (!state.adminToken) throw new Error('请先登录后台再导出');
  const fEvent = $('#f_event') ? $('#f_event').value : '';
  const url = `/admin/export${fEvent ? `?eventId=${encodeURIComponent(fEvent)}` : ''}`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${state.adminToken}` } });
  if (!res.ok) {
    let msg = `HTTP ${res.status}`;
    try { const j = await res.json(); if (j && (j.error || j.message)) msg = j.error || j.message; } catch { /* 非 JSON */ }
    throw new Error(msg);
  }
  const blob = await res.blob();
  const cd = res.headers.get('Content-Disposition') || '';
  const m = cd.match(/filename="?([^";]+)"?/i);
  const fname = (m && m[1]) ? m[1] : `registrations_${new Date().toISOString().slice(0, 10)}.csv`;
  const objUrl = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = objUrl; a.download = fname;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(objUrl), 4000);
  toast('已开始下载', 'ok');
}

// ───────────── 报名（用户） ─────────────
async function createRegistration(e) {
  e.preventDefault();
  const f = new FormData(e.target);
  const body = {
    registrationOptionId: Number(f.get('optionId')),
    name: f.get('name').trim(),
    phone: f.get('phone').trim(),
    remark: f.get('remark')?.toString().trim() || undefined,
  };
  const reg = await api('POST', `/events/${f.get('eventId')}/registrations`, { body, kind: 'user' });
  showRegistration(reg, '已创建报名，状态：' + (statusZh[reg.status] || reg.status));
  refreshMy();
}

async function mockPay(regId) {
  const reg = await api('POST', `/dev/registrations/${regId}/mock-pay`, { kind: 'user' });
  showRegistration(reg, '✅ 支付成功，已生成报名凭证');
  refreshMy();
}

async function showRegistration(reg, note) {
  $('#regBox').innerHTML = `
    <div class="reghead"><b>${esc(reg.name)}</b> <span class="badge ${reg.status === 'PAID' ? 'paid' : 'pend'}">${statusZh[reg.status] || reg.status}</span></div>
    <div class="muted">${esc(reg.registration_no)} · ${esc(reg.option?.name || '')} · ${esc(reg.amount_display || '')}</div>
    <div class="muted">${esc(reg.event?.title || '')} · ${fmtTime(reg.event?.start_time)}</div>`;
  if (reg.status === 'PAID') {
    const detail = reg.qr_token ? reg : await api('GET', `/registrations/${reg.id}`, { kind: 'user' });
    $('#credBox').innerHTML = detail.qr_data_url
      ? `<div class="cred"><img src="${detail.qr_data_url}" alt="报名凭证二维码" /><div class="credtoken">qr_token: <code>${esc(detail.qr_token)}</code></div><div class="muted small">此二维码内容为随机不可预测的 qr_token（§12），非自增 id。</div></div>`
      : '<p class="muted">已支付，但缺少凭证二维码。</p>';
  } else if (reg.status === 'PENDING') {
    $('#credBox').innerHTML = `<div class="btns"><button class="primary" id="payBtn">模拟支付（development-only）</button></div>`;
    $('#payBtn').onclick = () => mockPay(reg.id);
  } else {
    $('#credBox').innerHTML = '';
  }
}

// ───────────── 我的报名 ─────────────
async function refreshMy() {
  const regs = await api('GET', '/me/registrations', { kind: 'user' });
  const wrap = $('#myRegs');
  if (!regs.length) { wrap.innerHTML = '<p class="muted">还没有报名记录</p>'; return; }
  wrap.innerHTML = regs.map((r) => `
    <div class="regcard">
      <div class="rc-top">
        <b>${esc(r.event?.title || '')}</b>
        <span class="badge ${r.status === 'PAID' ? 'paid' : r.status === 'PENDING' ? 'pend' : 'dim'}">${statusZh[r.status] || r.status}</span>
        ${r.checked_in ? '<span class="badge ok">已签到</span>' : ''}
      </div>
      <div class="muted">${esc(r.name)} · ${esc(r.option?.name || '')} · ${esc(r.amount_display || '')} · ${fmtTime(r.paid_at || r.created_at)}</div>
      <div class="btns">
        ${r.status === 'PENDING' ? `<button class="ghost" data-act="pay" data-id="${r.id}">模拟支付</button>` : ''}
        ${r.status === 'PENDING' ? `<button class="ghost danger" data-act="cancel" data-id="${r.id}">取消</button>` : ''}
        ${r.status === 'PAID' ? `<button class="ghost" data-act="detail" data-id="${r.id}">查看凭证</button>` : ''}
        ${r.status === 'PAID' ? `<button class="ghost danger" data-act="refund" data-id="${r.id}">退款</button>` : ''}
      </div>
    </div>`).join('');
  $$('#myRegs [data-act]').forEach((b) => {
    b.onclick = async () => {
      const id = b.dataset.id;
      try {
        if (b.dataset.act === 'pay') { const r = await api('POST', `/dev/registrations/${id}/mock-pay`, { kind: 'user' }); toast('支付成功'); showRegistration(r); refreshMy(); }
        if (b.dataset.act === 'cancel') { const r = await api('POST', `/registrations/${id}/cancel`, { kind: 'user' }); toast('已取消'); showRegistration(r); refreshMy(); }
        if (b.dataset.act === 'detail') { const r = await api('GET', `/registrations/${id}`, { kind: 'user' }); showRegistration(r); switchTab('register'); }
        if (b.dataset.act === 'refund') { if (confirm('确认申请退款？')) { const r = await api('POST', `/registrations/${id}/refund`, { kind: 'user', body: { reason: 'harness 退款' } }); toast('退款成功', 'ok'); showRegistration(r); refreshMy(); } }
      } catch (err) { toast(err.message, 'err'); }
    };
  });
}

// ───────────── 签到（工作人员） ─────────────
async function qrResolve() {
  const token = $('#formQrCheckin textarea[name=qrToken]').value.trim();
  if (!token) return toast('请先粘贴 qr_token', 'err');
  const r = await api('GET', `/checkin/resolve?qrToken=${encodeURIComponent(token)}`, { kind: 'staff' });
  const reg = r.registration;
  window._lastRegId = reg.registration_id;
  $('#qrResult').innerHTML = `
    <div class="confirmbox">
      <div><b>${esc(reg.name)}</b>（${esc(reg.masked_phone)}）</div>
      <div class="muted">${esc(reg.event?.title || '')} · ${esc(reg.registration_option || '')}</div>
      <div class="muted">报名状态：${statusZh[reg.registration_status] || reg.registration_status} · ${reg.checkin_status === 'CHECKED_IN' ? '已签到 ' + fmtTime(reg.checked_in_at) : '未签到'}</div>
      <div class="btns"><button class="primary" id="qrConfirm">确认签到（QR）</button></div>
    </div>`;
  $('#qrConfirm').onclick = () => doCheckin(reg.registration_id, 'QR').catch((err) => toast(err.message, 'err'));
}

async function doCheckin(regId, method) {
  const op = ($('#formQrCheckin input[name=operator]') || $('#formPhoneCheckin input[name=operator]'))?.value.trim() || '现场工作人员';
  const r = await api('POST', `/registrations/${regId}/checkin`, { body: { method, operator: op }, kind: 'staff' });
  const cls = r.already ? 'warn' : 'ok';
  $('#qrResult').innerHTML = `<div class="resultbox ${cls}">${esc(r.message)}</div><div class="muted">${esc(r.registration?.name)} · ${esc(r.registration?.event?.title || '')}</div>`;
  refreshMy();
}

async function phoneSearch(e) {
  e.preventDefault();
  const f = new FormData(e.target);
  const r = await api('GET', `/events/${f.get('eventId')}/checkin/search?phoneLast4=${f.get('last4')}`, { kind: 'staff' });
  const wrap = $('#phoneCandidates');
  if (!r.count) { wrap.innerHTML = '<p class="muted">没有匹配的已支付报名（仅限该活动 · PAID · 手机号后四位）</p>'; return; }
  wrap.innerHTML = `<div class="candhead">${r.count} 位候选（${esc(r.event_title)}）· 手机号已脱敏，需人工确认后签到</div>` +
    r.candidates.map((c) => `
      <div class="cand">
        <div><b>${esc(c.name)}</b> · ${esc(c.masked_phone)} <span class="muted">${esc(c.registration_option || '')}</span></div>
        <div class="muted">${statusZh[c.registration_status] || c.registration_status} · ${c.checkin_status === 'CHECKED_IN' ? '已签到 ' + fmtTime(c.checked_in_at) : '未签到'}</div>
        <div class="btns"><button class="primary" data-cid="${c.registration_id}">确认签到（手机号后四位）</button></div>
      </div>`).join('');
  $$('#phoneCandidates [data-cid]').forEach((b) => (b.onclick = () => {
    const op = $('#formPhoneCheckin input[name=operator]').value.trim() || '现场工作人员';
    api('POST', `/registrations/${b.dataset.cid}/checkin`, { body: { method: 'PHONE_LAST4', operator: op }, kind: 'staff' })
      .then((r) => { $('#phoneResult').innerHTML = `<div class="resultbox ${r.already ? 'warn' : 'ok'}">${esc(r.message)}</div>`; refreshMy(); })
      .catch((err) => toast(err.message, 'err'));
  }));
}

function fillQrQuick() {
  api('GET', '/me/registrations', { kind: 'user' }).then((regs) => {
    const paid = regs.filter((r) => r.status === 'PAID');
    $('#qrQuick').innerHTML = paid.length
      ? paid.map((r) => `<div class="quick"><span>${esc(r.name)} · ${esc(r.event?.title || '')}</span><button class="ghost" data-token="${esc(r.qr_token)}">复制 token</button></div>`).join('')
      : '<p class="muted">暂无已支付报名</p>';
    $$('#qrQuick [data-token]').forEach((b) => (b.onclick = () => {
      $('#formQrCheckin textarea[name=qrToken]').value = b.dataset.token;
      toast('已填入，点“解析凭证”');
    }));
  }).catch(() => {});
}

// ───────────── Tab 切换（顶级 tab + 各自子 tab） ─────────────
function switchTab(name) {
  // 把当前标签写进 URL hash（不产生历史栈、不滚动）+ localStorage（跨会话记忆），刷新后 init() 读回 → 停留在当前标签
  try { history.replaceState(null, '', '#' + name); } catch (e) { /* 某些环境不支持则忽略 */ }
  try { localStorage.setItem('cl_last_tab', name); } catch (e) { /* 忽略 */ }
  $$('#tabs button').forEach((b) => b.classList.toggle('on', b.dataset.tab === name));
  $$('.tab').forEach((s) => {
    const active = s.id === `tab-${name}`;
    s.classList.toggle('on', active);
    s.style.display = active ? '' : 'none'; // 兜底：即使样式未生效也保证标签互斥
  });
  // 用户端 harness tab（无子 tab）
  if (name === 'my') refreshMy();
  if (name === 'checkin') fillQrQuick();
  // 顶级 tab：激活其第一个子 tab 并触发加载
  const sec = document.getElementById('tab-' + name);
  if (sec && sec.querySelector('.subtab')) {
    const first = sec.querySelector('.subtab');
    switchSubTab(name, first.dataset.subview);
  }
}

/** 顶级 tab 内切换子 tab。 */
function switchSubTab(top, sub) {
  const sec = document.getElementById('tab-' + top);
  if (!sec) return;
  sec.querySelectorAll('.subtab').forEach((v) => {
    const active = v.dataset.subview === sub;
    v.classList.toggle('on', active);
    v.style.display = active ? '' : 'none';
  });
  sec.querySelectorAll('.subtabs button').forEach((b) => b.classList.toggle('on', b.dataset.sub === sub));
  onSubTabEnter(top, sub);
}

/** 确保已登录沙箱管理员（admin/admin123）；未登录则自动登录（本地联调环境）。 */
async function ensureAdminAuto() {
  if (state.adminToken) return true;
  try {
    await adminLogin('admin', 'admin123');
    showAdminDash(true);
    return true;
  } catch (e) {
    toast('未登录后台，请到「后台」tab 用 admin 登录', 'err');
    return false;
  }
}

/** 子 tab 进入时的按需加载。 */
function onSubTabEnter(top, sub) {
  if (top === 'events') {
    if (sub === 'list') loadEvents();
    if (sub === 'detail') dePopulate();
    if (sub === 'comments') ensureAdminAuto().then((ok) => ok && loadComments('EVENT', 'evCmtList'));
    if (sub === 'archived') loadArchived(); // loadArchived 自带自动登录
  } else if (top === 'share') {
    if (sub === 'list') loadShares();
    if (sub === 'comments') ensureAdminAuto().then((ok) => ok && loadComments('SHARE', 'shCmtList'));
    if (sub === 'archived') ensureAdminAuto().then((ok) => ok && loadShareArchived());
  } else if (top === 'forum') {
    if (sub === 'posts') ensureAdminAuto().then((ok) => ok && loadForumPosts('ACTIVE'));
    if (sub === 'comments') ensureAdminAuto().then((ok) => ok && loadComments('POST', 'poCmtList'));
    if (sub === 'archived') ensureAdminAuto().then((ok) => ok && loadForumPosts('ARCHIVED'));
  } else if (top === 'admin') {
    if (sub === 'regs') ensureAdminAuto().then((ok) => ok && loadAdminRegsSub().catch((e) => toast(e.message, 'err')));
    if (sub === 'checkins') ensureAdminAuto().then((ok) => ok && loadAdminCheckinsSub().catch((e) => toast(e.message, 'err')));
    if (sub === 'stats') ensureAdminAuto().then((ok) => ok && loadAdminStatsSub().catch((e) => toast(e.message, 'err')));
  }
}

/** 旧版顶级 tab 名 → 新版「顶级 tab + 子 tab」映射（兼容历史 hash / localStorage）。 */
function legacyTabMap(name) {
  if (name === 'archived') return ['events', 'archived'];
  if (name === 'detail') return ['events', 'detail'];
  if (name === 'comments') return ['events', 'comments'];
  if (name === 'share') return ['share', 'list'];
  return null;
}

// ───────────── 活动详情编辑（WYSIWYG）+ 归档活动 ─────────────
const evStatusZh = { PUBLISHED: '已发布', DRAFT: '草稿', ENDED: '已结束', OFFLINE: '已下架', CANCELLED: '已取消' };

function deReadFileAsDataURL(file) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result));
    r.onerror = () => reject(new Error('读取图片失败'));
    r.readAsDataURL(file);
  });
}

/** 图片上传到服务器（POST /admin/upload-image → /uploads/…），不再以 base64 存数据库。 */
async function deUploadImage(file) {
  const dataUrl = await deReadFileAsDataURL(file);
  if (dataUrl.length > 7_500_000) throw new Error('图片较大（>5MB），请压缩后重试');
  if (!state.adminToken) {
    try { await adminLogin('admin', 'admin123'); showAdminDash(true); }
    catch { throw new Error('请先在「后台」登录管理员再上传图片'); }
  }
  const res = await api('POST', '/admin/upload-image', { body: { dataUrl }, kind: 'admin' });
  if (!res || !res.url) throw new Error('上传失败');
  return res.url;
}

function deTimeDisplay(startIso, endIso) {
  if (!startIso) return '';
  const s = new Date(startIso);
  if (isNaN(s.getTime())) return '';
  const p = (n) => (n < 10 ? `0${n}` : `${n}`);
  const wd = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'][s.getDay()];
  const t1 = `${p(s.getHours())}:${p(s.getMinutes())}`;
  let t2 = '';
  if (endIso) { const e = new Date(endIso); if (!isNaN(e.getTime())) t2 = `-${p(e.getHours())}:${p(e.getMinutes())}`; }
  return `${s.getFullYear()}年${p(s.getMonth() + 1)}月${p(s.getDate())}日 ${wd} ${t1}${t2}`;
}

function deReadForm() {
  // 防御：任何非法/空时间都返回 null，绝不抛 Invalid time value（混载页面里表单值可能被旧结构污染）
  const isoOf = (v) => {
    if (!v) return null;
    try { const d = new Date(v); return Number.isNaN(d.getTime()) ? null : d.toISOString(); } catch (e) { return null; }
  };
  return {
    title: ($('#deTitle').value || '').trim(),
    locationCity: ($('#deCity').value || '').trim(),
    locationName: ($('#deLocName').value || '').trim(),
    locationAddress: ($('#deAddr').value || '').trim(),
    latitude: $('#deLat').value === '' ? null : Number($('#deLat').value),
    longitude: $('#deLng').value === '' ? null : Number($('#deLng').value),
    startTime: isoOf($('#deStart').value),
    endTime: isoOf($('#deEnd').value),
    registrationStartTime: isoOf($('#deRegStart').value),
    registrationEndTime: isoOf($('#deRegEnd').value),
    refundRule: $('#deRefundRule').value || 'BEFORE_24H',
    status: $('#deStatus').value || 'PUBLISHED',
    reminder: ($('#deReminder').value || '').trim(),
    description: ($('#deDesc').innerHTML || '').replace(/^(<br\s*\/?>)+$/, '').trim(), // 富文本 HTML
    coverImage: state._deCover || null,
    coverDetailImage: state._deCoverDetail || null,
    customFields: (state._deCustomFields || [])
      .filter((f) => f.label && f.key)
      .map((f) => {
        const type = f.type === 'textarea' ? 'textarea' : f.type === 'choice' ? 'choice' : 'text';
        const out = { key: String(f.key).trim(), label: String(f.label).trim(), required: !!f.required, type };
        if (type === 'choice') out.options = (f.options || []).map((o) => String(o).trim()).filter((o) => o.length > 0);
        return out;
      }),
  };
}

function deWriteForm(ev) {
  $('#deTitle').value = ev.title || '';
  $('#deCity').value = ev.location_city || '';
  $('#deLocName').value = ev.location_name || '';
  $('#deAddr').value = ev.location_address || '';
  $('#deLat').value = ev.latitude != null ? String(ev.latitude) : '';
  $('#deLng').value = ev.longitude != null ? String(ev.longitude) : '';
  $('#deStart').value = ev.start_time ? toLocalInput(new Date(ev.start_time).getTime()) : '';
  $('#deEnd').value = ev.end_time ? toLocalInput(new Date(ev.end_time).getTime()) : '';
  $('#deRegStart').value = ev.registration_start_time ? toLocalInput(new Date(ev.registration_start_time).getTime()) : '';
  $('#deRegEnd').value = ev.registration_end_time ? toLocalInput(new Date(ev.registration_end_time).getTime()) : '';
  $('#deRefundRule').value = ev.refund_rule || 'BEFORE_24H';
  $('#deStatus').value = ev.status || 'PUBLISHED';
  $('#deReminder').value = ev.reminder || '';
  const deEl = $('#deDesc');
  if (deEl) {
    // 旧数据是纯文本：转 <br> 保持换行；新数据已是 HTML 直接填入
    const raw = ev.description || '';
    deEl.innerHTML = raw.indexOf('<') >= 0 ? raw : raw.replace(/\n/g, '<br>');
  }
  state._deCover = ev.cover_image || null;
  state._deCoverDetail = ev.cover_detail_image || null;
  state._deCustomFields = (ev.custom_fields || []).map((f) => ({
    label: f.label || '',
    key: f.key || '',
    required: !!f.required,
    type: f.type === 'textarea' ? 'textarea' : f.type === 'choice' ? 'choice' : 'text',
    options: Array.isArray(f.options) ? f.options.map((o) => String(o)) : [],
  }));
  deRenderCovers();
  deRenderCustomFields();
  deRenderPreview();
}

function deLoadEvent(id) {
  const ev = state.events.find((x) => x.id === id) || null;
  state._deEventId = id;
  if (!ev) { $('#deScreen').innerHTML = '<div class="de-empty">未找到该活动</div>'; return; }
  deWriteForm(ev);
  // 记住选中的活动：localStorage（刷新恢复）+ URL hash（可分享 #detail-<id>）
  try { localStorage.setItem('cl_detail_event', String(id)); } catch (e) { /* 忽略 */ }
  try { history.replaceState(null, '', '#detail-' + id); } catch (e) { /* 忽略 */ }
}

function dePopulate() {
  const deSel = $('#deEventSel');
  if (!deSel) return;
  deSel.innerHTML = state.events.map((e) => `<option value="${e.id}">${esc(e.title)}</option>`).join('');
  if (state.events.length) {
    if (!state._deEventId || !state.events.find((x) => x.id === state._deEventId)) {
      const first = state.events[0].id;
      deSel.value = String(first);
      deLoadEvent(first);
    }
  }
}

/** 手动 cover：按图片真实像素等比缩放填满容器并居中（任何内核都不拉伸，不依赖 object-fit）。 */
function fitCover(img, fw, fh) {
  const nw = img.naturalWidth, nh = img.naturalHeight;
  if (!nw || !nh || !fw || !fh) return;
  const s = Math.max(fw / nw, fh / nh);
  img.style.width = Math.round(nw * s) + 'px';
  img.style.height = Math.round(nh * s) + 'px';
  img.style.left = Math.round((fw - nw * s) / 2) + 'px';
  img.style.top = Math.round((fh - nh * s) / 2) + 'px';
}
function fitCoverAll() {
  const fit = (img, ratio) => {
    if (!img) return;
    const f = img.parentElement;
    if (!f || f.style.display === 'none') return;
    const fw = f.clientWidth || 300;
    const fh = f.clientHeight || Math.round(fw * ratio);
    const run = () => fitCover(img, fw, fh);
    if (img.complete && img.naturalWidth) run();
    else { img.onload = run; img.onerror = null; }
  };
  fit($('#deCoverPrev'), 2 / 3);
  fit($('#deCoverDetailPrev'), 9 / 16);
}

function deRenderCovers() {
  const show = (el, v) => {
    if (!el) return;
    const f = el.parentElement; if (f) f.style.display = v ? 'block' : 'none';
    if (v) el.src = v; else el.removeAttribute('src');
  };
  show($('#deCoverPrev'), state._deCover);
  show($('#deCoverDetailPrev'), state._deCoverDetail);
  const ca = $('#deCoverCrop'); if (ca) ca.disabled = !state._deCover;
  const cb = $('#deCoverDetailCrop'); if (cb) cb.disabled = !state._deCoverDetail;
  fitCoverAll();
}

// ── 图片裁切器（拖拽位置 + 滚轮缩放，输出固定比例 JPEG，上传后替换封面）──
const CROP_PRESETS = {
  // ratio 语义为 高/宽（stageH = stageW * ratio）：3:2 → 2/3，16:9 → 9/16。之前误写成宽/高导致舞台竖条、裁切内容拉伸
  cover: { ratio: 2 / 3, outW: 600, outH: 400, hint: '列表封面 3:2 · 首页卡片' },
  coverDetail: { ratio: 9 / 16, outW: 640, outH: 360, hint: '详情大图 16:9 · 详情页顶部' },
};
let cropCtx = null;
let cropImgEl = null;

function openCrop(target, url) {
  const preset = CROP_PRESETS[target];
  const img = new Image();
  img.onload = () => {
    // 必须先显示弹窗再量舞台宽：display:none 时 clientWidth 恒为 0，兜底 420 会导致舞台实际比例与裁切比例不一致 → 裁切输出被拉伸
    $('#cropModal').style.display = 'flex';
    const stage = $('#cropStage');
    const stageW = stage.clientWidth || 420;
    const stageH = Math.round(stageW * preset.ratio);
    stage.style.height = stageH + 'px';
    const natW = img.naturalWidth || stageW;
    const natH = img.naturalHeight || stageH;
    const s = Math.max(stageW / natW, stageH / natH); // 铺满裁切框
    cropCtx = { target, url, natW, natH, s, dx: 0, dy: 0, stageW, stageH, outW: preset.outW, outH: preset.outH, ratioText: `${preset.outW}×${preset.outH}（${preset.hint}）` };
    cropImgEl = img;
    $('#cropImg').src = url;
    $('#cropRatio').textContent = cropCtx.ratioText;
    cropRender();
  };
  img.onerror = () => toast('图片加载失败，请换一张', 'err');
  img.src = url;
}
function cropRender() {
  const c = cropCtx;
  if (!c) return;
  const dW = c.natW * c.s;
  const dH = c.natH * c.s;
  const maxDx = Math.max(0, (dW - c.stageW) / 2);
  const maxDy = Math.max(0, (dH - c.stageH) / 2);
  c.dx = Math.max(-maxDx, Math.min(maxDx, c.dx));
  c.dy = Math.max(-maxDy, Math.min(maxDy, c.dy));
  const el = $('#cropImg');
  el.style.width = dW + 'px';
  el.style.height = dH + 'px';
  el.style.left = c.stageW / 2 + c.dx - dW / 2 + 'px';
  el.style.top = c.stageH / 2 + c.dy - dH / 2 + 'px';
}
function cropClose() { $('#cropModal').style.display = 'none'; cropCtx = null; cropImgEl = null; }
function cropConfirm() {
  const c = cropCtx;
  if (!c || !cropImgEl) return;
  const canvas = document.createElement('canvas');
  canvas.width = c.outW;
  canvas.height = c.outH;
  const ctx = canvas.getContext('2d');
  const dW = c.natW * c.s;
  const dH = c.natH * c.s;
  const left = c.stageW / 2 + c.dx - dW / 2;
  const top = c.stageH / 2 + c.dy - dH / 2;
  const vx = Math.max(0, left);
  const vy = Math.max(0, top);
  const vw = Math.min(c.stageW, left + dW) - vx;
  const vh = Math.min(c.stageH, top + dH) - vy;
  if (vw <= 0 || vh <= 0) { toast('请先调整图片位置', 'err'); return; }
  ctx.drawImage(cropImgEl, (vx - left) / c.s, (vy - top) / c.s, vw / c.s, vh / c.s, 0, 0, c.outW, c.outH);
  const dataUrl = canvas.toDataURL('image/jpeg', 0.85);
  const target = c.target;
  cropClose();
  (async () => {
    try {
      if (dataUrl.length > 7_500_000) throw new Error('图片较大，请缩小后重试');
      if (!state.adminToken) {
        try { await adminLogin('admin', 'admin123'); showAdminDash(true); }
        catch { throw new Error('请先在「后台」登录管理员再上传图片'); }
      }
      const res = await api('POST', '/admin/upload-image', { body: { dataUrl }, kind: 'admin' });
      if (!res || !res.url) throw new Error('上传失败');
      if (target === 'cover') state._deCover = res.url; else state._deCoverDetail = res.url;
      deRenderCovers();
      deRenderPreview();
      toast('封面已更新，记得点「保存」', 'ok');
    } catch (e) { toast(e.message, 'err'); }
  })();
}

/** 在富文本编辑器光标处插入 HTML；编辑器无焦点/无选区时先把光标定位到正文末尾，保证一定插入成功。 */
function insertHtmlAtCursor(html) {
  const el = $('#deDesc');
  if (!el) return;
  el.focus();
  let sel = null;
  try { sel = window.getSelection(); } catch { /* 忽略 */ }
  let hasSelInEditor = false;
  if (sel && sel.rangeCount > 0 && sel.anchorNode) {
    hasSelInEditor = el === sel.anchorNode || el.contains(sel.anchorNode);
  }
  if (sel && (!hasSelInEditor)) {
    const range = document.createRange();
    range.selectNodeContents(el);
    range.collapse(false); // 折叠到末尾
    sel.removeAllRanges();
    sel.addRange(range);
  }
  try { document.execCommand('insertHTML', false, html); } catch (e) { /* 忽略 */ }
  deRenderPreview();
}

function deRenderCustomFields() {
  const wrap = $('#deCustomFields');
  if (!wrap) return;
  if (!state._deCustomFields.length) { wrap.innerHTML = '<span class="muted">（未配置，报名时仅填备注）</span>'; return; }
  wrap.innerHTML = state._deCustomFields
    .map((f, i) => {
      const type = f.type || 'text';
      const optionsBox =
        type === 'choice'
          ? `<textarea class="de-cf-options" data-i="${i}" rows="3" placeholder="每行一个选项，如：&#10;有酒&#10;无酒&#10;热饮">${esc((f.options || []).join('\n'))}</textarea>`
          : '';
      return `<div class="de-cf-row">
        <input class="de-cf-label" data-i="${i}" placeholder="字段名，如：饮品选择" value="${esc(f.label || '')}" />
        <input class="de-cf-key" data-i="${i}" placeholder="key（英文，如 drink）" value="${esc(f.key || '')}" />
        <label class="de-cf-req"><input type="checkbox" data-i="${i}" ${f.required ? 'checked' : ''} />必填</label>
        <select class="de-cf-type" data-i="${i}">
          <option value="text" ${type === 'text' ? 'selected' : ''}>单行文本</option>
          <option value="textarea" ${type === 'textarea' ? 'selected' : ''}>多行文本</option>
          <option value="choice" ${type === 'choice' ? 'selected' : ''}>单选勾选</option>
        </select>
        <button type="button" class="de-cf-del" data-i="${i}" title="删除">×</button>
        ${optionsBox}
      </div>`;
    })
    .join('');
}

function deRenderPreview() {
  const screen = $('#deScreen');
  if (!screen) return;
  const d = deReadForm();
  const ev = state.events.find((x) => x.id === state._deEventId) || {};
  const opts = ev.registrationOptions || [];
  const minCents = opts.length ? Math.min(...opts.map((o) => o.price)) : 0;
  const yuan = minCents / 100;
  const priceStr = Number.isInteger(yuan) ? String(yuan) : yuan.toFixed(2);
  const waitlist = ev.waitlist_count ?? 0;
  const view = ev.view_count ?? 0;
  const timeDisplay = deTimeDisplay(d.startTime, d.endTime);
  const locDisplay = d.locationCity ? `${d.locationCity} | ${d.locationName || '地点待定'}` : (d.locationName || '地点待定');
  const h = [];
  const pvCover = d.coverDetailImage || d.coverImage;
  if (pvCover) h.push(`<img class="pv-cover" src="${esc(pvCover)}" />`);
  h.push(`<div class="pv-head">`);
  if (d.category) h.push(`<span class="pv-cat">${esc(d.category)}</span>`);
  h.push(`<div class="pv-title">${esc(d.title) || '（未填写标题）'}</div>`);
  h.push(`<div class="pv-stats"><span>浏览 ${view}</span>${waitlist > 0 ? `<span>候补中 ${waitlist}</span>` : ''}</div>`);
  h.push(`<div class="pv-pricerow"><div class="pv-price">¥${priceStr}<small>起</small></div><button class="pv-cta" disabled>立即报名</button></div></div>`);
  h.push(`<div class="pv-info">`);
  h.push(`<div class="pv-info-row"><span class="k">🕐 时间</span><span class="v">${esc(timeDisplay) || '—'}</span></div>`);
  h.push(`<div class="pv-info-row"><span class="k">📍 地点</span><span class="v">${esc(locDisplay)}</span></div>`);
  if (d.locationAddress) h.push(`<div class="pv-info-row"><span class="k">📮 地址</span><span class="v">${esc(d.locationAddress)}</span></div>`);
  h.push(`</div>`);
  if (d.reminder) h.push(`<div class="pv-reminder"><span class="ri">⚠️</span><span>${esc(d.reminder)}</span></div>`);
  h.push(`<div class="pv-consent">❗ 报名成功默认同意主办方用现场照片作为后续宣传素材</div>`);
  h.push(`<div class="pv-detail"><div class="pv-detail-title">活动详情</div><div class="pv-desc">${d.description || '（暂无详情文字）'}</div>`);
  h.push(`</div>`);
  if (opts.length) {
    h.push(`<div class="pv-opts"><div class="pv-detail-title">票种</div>`);
    opts.forEach((o) => h.push(`<div class="pv-opt"><span class="pn">${esc(o.name)}</span><span class="pp">¥${(o.price / 100)}</span></div>`));
    h.push(`</div>`);
  }
  h.push(`<div class="pv-cta2"><button class="btn primary" disabled>立即报名</button></div>`);
  screen.innerHTML = h.join('');
}

async function deSave() {
  const id = state._deEventId;
  if (!id) { toast('请先选择活动', 'err'); return; }
  if (!state.adminToken) {
    const u = ($('#formAdminLogin input[name=username]').value || '').trim();
    const p = $('#formAdminLogin input[name=password]').value || '';
    try { await adminLogin(u, p); showAdminDash(true); }
    catch { toast('请先在「后台」登录管理员（admin / admin123）', 'err'); return; }
  }
  const d = deReadForm();
  const body = {
    title: d.title, locationCity: d.locationCity,
    locationName: d.locationName, locationAddress: d.locationAddress,
    reminder: d.reminder, description: d.description,
    coverImage: d.coverImage, coverDetailImage: d.coverDetailImage,
    latitude: d.latitude, longitude: d.longitude, customFields: d.customFields,
  };
  if (d.startTime) body.startTime = d.startTime;
  if (d.endTime) body.endTime = d.endTime;
  if (d.registrationStartTime) body.registrationStartTime = d.registrationStartTime;
  if (d.registrationEndTime) body.registrationEndTime = d.registrationEndTime;
  body.refundRule = d.refundRule;
  body.status = d.status;
  try {
    await api('PUT', `/admin/events/${id}`, { body, kind: 'admin' });
    toast('活动详情已保存并发布', 'ok');
    await loadEvents();
    const ev = state.events.find((x) => x.id === id);
    if (ev) deWriteForm(ev);
  } catch (err) { toast(err.message, 'err'); }
}

// 兜底：若浏览器缓存的旧页面缺少归档容器（有标签按钮、无 #tab-archived/#archivedList），现场注入一个可用容器
function ensureArchivedSection() {
  if (window.__unconditionalBoot) return; // v36+ 无条件启动：禁用旧页注入（避免 nav 混入"归档"按钮）
  if (document.getElementById('archivedList')) return; // 已存在，无需注入
  try {
    // 注入归档卡片样式（旧缓存页可能没有）
    if (!document.getElementById('__archInjStyle')) {
      const st = document.createElement('style');
      st.id = '__archInjStyle';
      st.textContent = [
        '.eventlist{display:grid;gap:12px}',
        '.archived-item{background:#fff;border:1px solid #e6e8ef;border-radius:10px;padding:14px 16px;box-shadow:0 1px 2px rgba(16,24,40,.04)}',
        '.ai-top{display:flex;align-items:center;justify-content:space-between;gap:12px;margin-bottom:6px}',
        '.ai-title{font-size:15px;font-weight:600;color:#111827}',
        '.ai-meta{font-size:12.5px;color:#6b7280;margin-bottom:10px}',
        '.ai-stats{display:flex;gap:18px;flex-wrap:wrap;font-size:13px;color:#374151}',
        '.ai-stats b{color:#111827;font-weight:700}',
        '.ai-stat-final{color:#059669}',
        '.ai-actions{display:inline-flex;align-items:center;gap:8px;flex-shrink:0}',
        '.ai-delete{background:#fff;color:#dc2626;border:1px solid #fecaca;border-radius:6px;padding:3px 12px;font-size:12.5px;cursor:pointer;transition:all .15s}',
        '.ai-delete:hover{background:#dc2626;color:#fff;border-color:#dc2626}',
        '.ai-restore{background:#fff;color:#059669;border:1px solid #a7f3d0;border-radius:6px;padding:3px 12px;font-size:12.5px;cursor:pointer;transition:all .15s}',
        '.ai-restore:hover{background:#059669;color:#fff;border-color:#059669}',
        '.ai-empty{padding:24px;text-align:center;color:#6b7280;font-size:13.5px;background:#fff;border:1px dashed #d8dbe4;border-radius:10px}'
      ].join('\n');
      (document.head || document.documentElement).appendChild(st);
    }
    // 注入/补全 #tab-archived + #archivedList
    let section = document.getElementById('tab-archived');
    if (!section) {
      section = document.createElement('section');
      section.id = 'tab-archived';
      section.className = 'tab';
      section.style.cssText = 'display:none;padding:18px 22px';
      const inner = document.createElement('div');
      inner.className = 'tab-inner';
      inner.innerHTML = '<h2 style="margin:0 0 6px">归档活动 <span style="font-size:12px;color:#6b7280;font-weight:400">（已结束 / 已下架 / 已取消）</span></h2>'
        + '<p style="margin:0 0 14px;font-size:12.5px;color:#6b7280">仅活动信息 + 最终核验人数，不显示票种。</p>'
        + '<div id="archivedList" class="eventlist"></div>';
      section.appendChild(inner);
      const admin = document.getElementById('tab-admin');
      if (admin && admin.parentNode) admin.parentNode.insertBefore(section, admin);
      else (document.body || document.documentElement).appendChild(section);
    } else if (!section.querySelector('#archivedList')) {
      const list = document.createElement('div');
      list.id = 'archivedList';
      list.className = 'eventlist';
      section.appendChild(list);
    }
    diag('ensureArchivedSection: 已注入 #tab-archived + #archivedList');
  } catch (e) { diag('ensureArchivedSection 失败: ' + e.message); }
}

/** 自愈：旧缓存页缺「分享」管理区（#tab-share + 列表 + 表单）时现场注入（与 index.html 保持同构）。 */
function ensureShareSection() {
  if (window.__unconditionalBoot) return; // v36+ 无条件启动：禁用旧页注入（避免 nav 混入"分享"按钮）
  if (document.getElementById('shareList')) return; // 已存在（新页或已注入），无需重复
  try {
    if (!document.getElementById('__shareInjStyle')) {
      const st = document.createElement('style');
      st.id = '__shareInjStyle';
      st.textContent = [
        '.sharelist{display:grid;gap:12px}',
        '.shareitem{background:#fff;border:1px solid #e6e8ef;border-radius:10px;padding:12px 14px;box-shadow:0 1px 2px rgba(16,24,40,.04)}',
        '.sh-top{display:flex;align-items:center;justify-content:space-between;gap:8px;margin-bottom:6px;flex-wrap:wrap}',
        '.sh-title{font-size:14.5px;font-weight:600;color:#111827;margin-bottom:4px}',
        '.sh-actions{display:inline-flex;gap:8px;margin-top:8px;flex-wrap:wrap}',
        '.de-cover-frame{position:relative;overflow:hidden;width:100%;padding-top:66.6667%;border-radius:8px;background:#f3f4f6;margin-bottom:8px}',
        '.de-cover-frame .de-coverprev{position:absolute;left:0;top:0;width:auto;height:auto;max-width:none;aspect-ratio:auto;margin:0;border-radius:0}',
        '.de-cover-actions{display:flex;gap:8px;align-items:center;flex-wrap:wrap}',
        '.filebtn{font-size:12px}',
        '.sh-rt-toolbar{display:flex;gap:4px;flex-wrap:wrap;margin-bottom:6px}',
        '.sh-rt-toolbar button{min-width:34px;height:28px;padding:0 9px;border:1px solid var(--line);border-radius:6px;background:#fff;color:#374151;font-size:13px;cursor:pointer;line-height:1}',
        '.sh-rt-toolbar button:hover{background:#f3f4f6}',
        '.sh-rt-body{min-height:120px;max-height:320px;border:1px solid var(--line);border-radius:8px;padding:10px 12px;font-size:13.5px;line-height:1.7;color:#1f2937;background:#fff;outline:none;overflow-y:auto}',
        '.sh-rt-body:focus{border-color:var(--brand)}',
        '.sh-rt-body:empty:before{content:attr(data-placeholder);color:#9ca3af}',
        '.sh-rt-body h3{font-size:16px;font-weight:700;margin:10px 0 4px}',
        '.sh-rt-body ul,.sh-rt-body ol{margin:6px 0;padding-left:20px}',
        '.sh-rt-body li{margin:3px 0}'
      ].join('\n');
      (document.head || document.documentElement).appendChild(st);
    }
    const sec = document.createElement('section');
    sec.id = 'tab-share';
    sec.className = 'tab';
    sec.style.cssText = 'display:none';
    sec.innerHTML =
      '<div class="grid2">'
      + '  <div class="card">'
      + '    <h2>分享内容 <span class="hint">（现场视频 / 网课 / 知识文字 · 小程序「分享」tab 展示）</span></h2>'
      + '    <div class="btns" style="margin-bottom:12px"><button id="shareRefresh" class="ghost">刷新</button></div>'
      + '    <div id="shareList" class="sharelist">加载中…</div>'
      + '  </div>'
      + '  <div class="card">'
      + '    <h2>新增 / 编辑分享</h2>'
      + '    <form id="formShare" class="form">'
      + '      <div class="row2">'
      + '        <label>类型<select id="shType"><option value="VIDEO">现场视频</option><option value="COURSE">网课</option><option value="TEXT">知识文字</option></select></label>'
      + '        <label>状态<select id="shStatus"><option value="PUBLISHED">已发布</option><option value="DRAFT">草稿</option><option value="OFFLINE">已下架</option></select></label>'
      + '      </div>'
      + '      <label>标题<input id="shTitle" placeholder="分享标题" /></label>'
      + '      <label>摘要<textarea id="shSummary" rows="2" placeholder="列表页显示的简介"></textarea></label>'
      + '      <label>封面图'
      + '        <div class="de-cover-actions" style="margin-top:6px">'
      + '          <input type="file" id="shCoverFile" accept="image/*" class="filebtn" />'
      + '          <button type="button" id="shCoverClear" class="ghost">清除封面</button>'
      + '        </div>'
      + '        <div class="de-cover-frame" id="shCoverFrame" style="display:none;margin-top:8px"><img id="shCoverPrev" class="de-coverprev" alt="" /></div>'
      + '      </label>'
      + '      <label>视频链接<input id="shVideoUrl" placeholder="mp4 直链（现场视频 / 网课填，如 https://…/xxx.mp4）" /></label>'
      + '      <label>正文内容'
      + '        <span class="hint" style="display:block;margin-bottom:4px">（支持加粗 / 标题 / 列表 / 插图，与活动详情编辑器一致；文字类型必填）</span>'
      + '        <div class="sh-rt-toolbar" id="shRtToolbar">'
      + '          <button type="button" data-cmd="bold" title="加粗"><b>B</b></button>'
      + '          <button type="button" data-cmd="italic" title="斜体"><i>I</i></button>'
      + '          <button type="button" data-cmd="underline" title="下划线"><u>U</u></button>'
      + '          <button type="button" data-cmd="formatBlock" data-val="H3" title="小标题">标题</button>'
      + '          <button type="button" data-cmd="formatBlock" data-val="P" title="正文段落">正文</button>'
      + '          <button type="button" data-cmd="insertUnorderedList" title="无序列表">• 列表</button>'
      + '          <button type="button" id="shRtImg" title="插入图片（上传后插入到光标处）">🖼️ 插图</button>'
      + '          <input type="file" id="shRtImgFile" accept="image/*" style="display:none" />'
      + '        </div>'
      + '        <div id="shContent" class="sh-rt-body" contenteditable="true" data-placeholder="知识文字正文（文字类型填）；视频 / 网课可留空"></div>'
      + '      </label>'
      + '      <label>排序<input type="number" id="shSort" value="0" style="width:100px" placeholder="数字越小越靠前" /></label>'
      + '      <div class="btns">'
      + '        <button class="primary" type="submit">保存分享</button>'
      + '        <button class="ghost" type="button" id="shReset">清空表单</button>'
      + '      </div>'
      + '      <p class="muted" id="shEditHint" style="display:none">正在编辑 #<b id="shEditId"></b>：<span id="shEditLabel"></span></p>'
      + '    </form>'
      + '  </div>'
      + '</div>';
    const anchor = document.getElementById('tab-archived') || document.getElementById('tab-detail') || document.getElementById('tab-admin');
    if (anchor && anchor.parentNode) anchor.parentNode.insertBefore(sec, anchor);
    else (document.body || document.documentElement).appendChild(sec);
    // 若旧页 nav 缺「分享」按钮则补一个（放在「活动详情」之后；tab 绑定在 init 里统一完成）
    const tabsNav = document.getElementById('tabs');
    if (tabsNav && !tabsNav.querySelector('button[data-tab="share"]')) {
      const nb = document.createElement('button');
      nb.dataset.tab = 'share';
      nb.textContent = '分享';
      const detailBtn = tabsNav.querySelector('button[data-tab="detail"]');
      if (detailBtn && detailBtn.nextSibling) tabsNav.insertBefore(nb, detailBtn.nextSibling);
      else tabsNav.appendChild(nb);
    }
    diag('ensureShareSection: 已注入 #tab-share + 分享管理区');
  } catch (e) { diag('ensureShareSection 失败: ' + e.message); }
}

/** 自愈：旧缓存页缺评论容器时现场注入（新结构按类型分 tab，三个容器任一存在即可）。 */
function ensureCommentsSection() {
  if (window.__unconditionalBoot) return; // v36+ 无条件启动：禁用旧页注入（避免 nav 混入"评论"按钮）
  if (document.getElementById('evCmtList') || document.getElementById('shCmtList') || document.getElementById('poCmtList')) return; // 已存在（新页）
  if (document.getElementById('cmtList')) return; // 旧页兜底容器
  try {
    if (!document.getElementById('__cmtInjStyle')) {
      const st = document.createElement('style');
      st.id = '__cmtInjStyle';
      st.textContent = [
        '.cmtlist{display:grid;gap:10px}',
        '.cmtitem{background:#fff;border:1px solid #e6e8ef;border-radius:10px;padding:12px 14px;box-shadow:0 1px 2px rgba(16,24,40,.04)}',
        '.cmtitem .cmt-top{display:flex;align-items:center;gap:8px;margin-bottom:6px;flex-wrap:wrap}',
        '.cmtitem .cmt-target{font-size:13.5px;font-weight:600;color:#111827}',
        '.cmtitem .cmt-body{font-size:14px;color:#374151;line-height:1.6;word-break:break-word}',
        '.cmtitem .cmt-meta{font-size:12px;color:#6b7280;margin-top:4px}',
        '.cmtitem .sh-actions{margin-top:6px}',
        '.cmtitem .cmt-replies{margin-top:10px;padding:10px 12px;border-radius:8px;background:#f7f8fc}',
        '.cmtitem .cmt-r{display:flex;align-items:baseline;gap:8px;padding:4px 0;flex-wrap:wrap}',
        '.cmtitem .cmt-r-name{font-size:12.5px;font-weight:600;color:var(--brand-deep);flex:none}',
        '.cmtitem .cmt-r-content{font-size:13px;color:#3b4257;line-height:1.5;flex:1;min-width:0;word-break:break-word}',
        '.cmtitem .cmt-r-del{flex:none;padding:2px 8px;font-size:12px}',
        '.cmtitem .cmt-expand{margin-top:6px}',
        '.cmtitem .cmt-expand button{font-size:12px;color:var(--brand);border-color:#c7d2fe;background:#fff}'
      ].join('\n');
      (document.head || document.documentElement).appendChild(st);
    }
    const sec = document.createElement('section');
    sec.id = 'tab-comments';
    sec.className = 'tab';
    sec.style.cssText = 'display:none';
    sec.innerHTML =
      '<div class="grid2">'
      + '  <div class="card">'
      + '    <h2>评论管理 <span class="hint">（分享 + 活动全部评论 · 删除根评论会连带其下回复）</span></h2>'
      + '    <div class="row2" style="margin-bottom:12px">'
      + '      <select id="cmtFilter"><option value="ALL">全部类型</option><option value="SHARE">分享评论</option><option value="EVENT">活动评论</option></select>'
      + '      <button id="cmtRefresh" class="ghost">刷新</button>'
      + '    </div>'
      + '    <div id="cmtList" class="cmtlist">加载中…</div>'
      + '  </div>'
      + '  <div class="card">'
      + '    <h2>说明</h2>'
      + '    <p class="muted">· 评论区来自小程序「分享详情」和「活动详情」页</p>'
      + '    <p class="muted">· 活动评论需参加过（已支付报名）该活动才能发</p>'
      + '    <p class="muted">· 用户发评论/评价时自动过滤违禁词，命中即拒绝发布</p>'
      + '    <p class="muted">· 删除根评论会连同其下回复一起删除，不可恢复</p>'
      + '  </div>'
      + '</div>';
    const anchor = document.getElementById('tab-share') || document.getElementById('tab-archived') || document.getElementById('tab-admin');
    if (anchor && anchor.parentNode) anchor.parentNode.insertBefore(sec, anchor.nextSibling);
    else (document.body || document.documentElement).appendChild(sec);
    const tabsNav = document.getElementById('tabs');
    if (tabsNav && !tabsNav.querySelector('button[data-tab="comments"]')) {
      const nb = document.createElement('button');
      nb.dataset.tab = 'comments';
      nb.textContent = '评论';
      const shareBtn = tabsNav.querySelector('button[data-tab="share"]');
      if (shareBtn && shareBtn.nextSibling) tabsNav.insertBefore(nb, shareBtn.nextSibling);
      else tabsNav.appendChild(nb);
    }
    diag('ensureCommentsSection: 已注入 #tab-comments + 评论管理区');
  } catch (e) { diag('ensureCommentsSection 失败: ' + e.message); }
}

async function loadArchived() {
  ensureArchivedSection(); // 兜底：缓存旧页缺容器时现场注入
  const hasList = !!document.getElementById('archivedList');
  diag('loadArchived 开始 | adminToken=' + (state.adminToken ? '有(' + state.adminToken.length + ')' : '无') + ' | #archivedList=' + (hasList ? '存在' : '缺失'));
  const wrap = $('#archivedList');
  const status = (msg) => { diag('status→ ' + msg); if (hasList) wrap.innerHTML = `<div class="ai-empty">${msg}</div>`; };
  const doFetch = () => api('GET', '/admin/events/archived', { kind: 'admin' });
  let list = null;
  // 1) 有 token 就先试一次（可能有效，也可能失效）
  if (state.adminToken) {
    try { list = await doFetch(); diag('① 首次拉取成功 count=' + (list && list.length)); }
    catch (e) { list = null; diag('① 首次拉取失败: ' + e.message + ' (status ' + e.status + ')'); }
  }
  // 2) 未登录 / token 失效 → 自动登录沙箱管理员再试
  if (!list) {
    status('① 自动登录管理员…');
    try {
      await adminLogin('admin', 'admin123'); showAdminDash(true);
      diag('① 自动登录成功 tokenLen=' + (state.adminToken || '').length);
    } catch (e) { diag('① 自动登录失败: ' + e.message + ' (status ' + (e.status || '?') + ')'); status('① 自动登录失败：' + esc(e.message) + '（沙箱管理员 admin / admin123）'); return; }
    status('② 拉取归档活动…');
    try { list = await doFetch(); diag('② 重试拉取成功 count=' + (list && list.length)); }
    catch (e) { diag('② 重试拉取失败: ' + e.message + ' (status ' + (e.status || '?') + ')'); status('② 拉取失败：' + esc(e.message)); return; }
  }
  if (!list || !list.length) { diag('③ 列表为空'); status('后端返回 0 条归档活动'); return; }
  diag('④ 渲染 ' + list.length + ' 条');
  if (hasList) {
    wrap.innerHTML = list.map((a) => `
    <div class="archived-item">
      <div class="ai-top">
        <span class="ai-title">${esc(a.title)}</span>
        <span class="ai-actions">
          <span class="badge dim">${esc(evStatusZh[a.status] || a.status)}</span>
          <button type="button" class="ai-restore" data-id="${a.id}">恢复上架</button>
          <button type="button" class="ai-delete" data-id="${a.id}">删除</button>
        </span>
      </div>
      <div class="ai-meta">${a.category ? `<span>${esc(a.category)}</span> · ` : ''}📍 ${esc(a.location_city || a.location_name || '—')} · 🕐 ${esc(a.start_time_display || fmtTime(a.start_time))}${a.location_address ? ' · ' + esc(a.location_address) : ''}</div>
      <div class="ai-stats">
        <span>已报名 <b>${a.attendance_count ?? 0}</b> 人</span>
        <span>最终核验 <b class="ai-stat-final">${a.checked_in_count ?? 0}</b> 人</span>
        <span class="muted">归档于 ${fmtTime(a.updated_at)}</span>
      </div>
    </div>`).join('');
    // 事件委托：点击「恢复上架」/「删除」→ 二次确认 → 调接口 → 刷新列表
    wrap.onclick = (e) => {
      if (!e.target || !e.target.closest) return;
      const del = e.target.closest('.ai-delete');
      const res = e.target.closest('.ai-restore');
      if (!del && !res) return;
      const btn = del || res;
      const id = Number(btn.dataset.id);
      const card = btn.closest('.archived-item');
      const title = card ? ((card.querySelector('.ai-title') || {}).textContent || '').trim() : '';
      if (del) deleteArchivedEvent(id, title);
      else restoreArchivedEvent(id, title);
    };
  }
}

// ───────────── 初始化 ─────────────
async function init() {
  ensureDetailEditor(); // 幂等：旧页在此处补注入（保证 DOM 已就绪、且早于下方所有接线）
  ensureArchivedSection(); // 幂等：旧页缺 #archivedList 时补注入（归档活动容器）
  ensureShareSection(); // 幂等：旧页缺 #tab-share 时补注入（分享管理区）
  ensureCommentsSection(); // 幂等：旧页缺 #tab-comments 时补注入（评论管理区）
  ensureDiagToggle(); // 幂等：右上角「诊断:开/关」切换按钮
  $('#uiVerBadge').textContent = 'UI ' + UI_VERSION;
  $$('#tabs button').forEach((b) => (b.onclick = () => switchTab(b.dataset.tab)));
  // 顶级 tab 内的子 tab 切换
  $$('.subtabs button').forEach((b) => (b.onclick = () => {
    const sec = b.closest('.tab');
    switchSubTab(sec ? sec.id.replace('tab-', '') : '', b.dataset.sub);
  }));

  // 初始标签优先级：URL hash（可分享）> localStorage（上次停留的标签）> 活动页；并强制标签互斥
  const hash = (location.hash || '').replace(/^#/, '');
  let lastTab = null;
  try { lastTab = localStorage.getItem('cl_last_tab'); } catch (e) { /* 忽略 */ }
  // 支持 #detail-<id>（活动详情 + 指定活动，刷新/分享后恢复）
  const dm = hash.match(/^detail-(\d+)$/);
  const rawInitial = dm ? 'detail' : (hash && $(`#tab-${hash}`)) ? hash : (lastTab && $(`#tab-${lastTab}`)) ? lastTab : 'events';
  const initial = rawInitial;
  const legacy = legacyTabMap(rawInitial);
  if (legacy) { switchTab(legacy[0]); switchSubTab(legacy[0], legacy[1]); }
  else switchTab(rawInitial);

  // config + env badge
  try {
    const cfg = await api('GET', '/config', { kind: 'user' });
    state.mockPay = cfg.mockPayEnabled;
    $('#envBadge').textContent = `env=${cfg.env} · mockPay=${cfg.mockPayEnabled ? '开' : '关'}`;
  } catch { $('#envBadge').textContent = 'env=?'; }

  // 自动登录一个演示用户
  await ensureUser().catch(() => {});
  refreshUserBadge();
  await loadEvents().catch(() => {});

  // 活动详情：刷新后恢复上次选中的活动（优先 URL #detail-<id>，其次 localStorage）
  if (initial === 'detail') {
    let savedId = dm ? Number(dm[1]) : null;
    if (!savedId) { try { savedId = Number(localStorage.getItem('cl_detail_event')); } catch (e) { /* 忽略 */ } }
    if (savedId && state.events.some((e) => e.id === savedId)) deLoadEvent(savedId);
  }

  // 事件表单默认时间
  const setDT = (id, ms) => { const el = $(id); if (el && !el.value) el.value = toLocalInput(ms); };
  setDT('#formEvent input[name=startTime]', Date.now() + 10 * 86400000);
  setDT('#formEvent input[name=endTime]', Date.now() + 10 * 86400000 + 4 * 3600000);
  setDT('#formEvent input[name=regStart]', Date.now() - 3600000);
  setDT('#formEvent input[name=regEnd]', Date.now() + 9 * 86400000);

  $('#regEventSel').onchange = refreshOptionSelect;

  // 活动列表：「编辑活动」→ 直接进「活动详情」标签编辑完整内容（含活动设置/归档/删除）
  $('#eventList').addEventListener('click', (e) => {
    const optBtn = e.target.closest('[data-opt]');
    if (optBtn) { openOptionEdit(Number(optBtn.dataset.event), Number(optBtn.dataset.opt)); return; }
    const btn = e.target.closest('[data-edit]');
    if (btn) viewEvent(Number(btn.dataset.edit));
    const vbtn = e.target.closest('[data-view]');
    if (vbtn) viewEvent(Number(vbtn.dataset.view));
  });

  $('#formEvent').onsubmit = async (e) => {
    e.preventDefault();
    try {
      if (!(await ensureAdmin()) && !state.adminToken) return await requireAdminThen(() => submitEvent(e));
      await submitEvent(e);
    } catch (err) { toast(err.message, 'err'); }
  };
  async function submitEvent(e) {
    const f = new FormData(e.target);
    const st = f.get('startTime') ? new Date(f.get('startTime')) : new Date(Date.now() + 10 * 86400000);
    const body = {
      title: f.get('title').trim(),
      startTime: st.toISOString(), endTime: new Date(st.getTime() + 4 * 3600000).toISOString(),
      registrationStartTime: new Date(f.get('regStart')).toISOString(), registrationEndTime: new Date(f.get('regEnd')).toISOString(),
      refundRule: f.get('refundRule'), status: f.get('status') || 'PUBLISHED',
    };
    const ev = await api('POST', '/admin/events', { body, kind: 'admin' });
    toast(`活动已创建（#${ev.id}），点列表「编辑活动」完善详情`, 'ok');
    await loadEvents();
  }
  async function requireAdminThen(fn) {
    const u = $('#formAdminLogin input[name=username]').value;
    const p = $('#formAdminLogin input[name=password]').value;
    try { await adminLogin(u, p); } catch { showAdminDash(false); return; }
    showAdminDash(true); await fn();
  }

  $('#formOption').onsubmit = async (e) => {
    e.preventDefault();
    try {
      if (!state.adminToken) {
        const u = $('#formAdminLogin input[name=username]').value;
        const p = $('#formAdminLogin input[name=password]').value;
        await adminLogin(u, p); showAdminDash(true);
      }
      const f = new FormData(e.target);
      const optionType = OPT_PRESET_TYPE[$('#optPreset').value] || 'SINGLE';
      const gateCode = (f.get('gateCode') || '').toString().trim() || undefined;
      if (optionType === 'INVITE' && !gateCode) { toast('邀请票需填写购买邀请码', 'err'); return; }
      if (optionType === 'WAITLIST') f.set('priceYuan', '0');
      const soldLimitRaw = (f.get('soldLimit') || '').toString().trim();
      const soldLimit = soldLimitRaw === '' ? null : Number(soldLimitRaw);
      if (soldLimit !== null && (!Number.isInteger(soldLimit) || soldLimit < 0)) { toast('购票上限需为 ≥0 的整数（留空=不限）', 'err'); return; }
      const body = { name: f.get('name').trim(), price: Math.round(Number(f.get('priceYuan')) * 100), optionType, gateCode, soldLimit };
      await api('POST', `/admin/events/${f.get('eventId')}/options`, { body, kind: 'admin' });
      toast('报名类型已添加', 'ok');
      $('#formOption').reset(); $('#optGateLabel').style.display = 'none'; $('#optTypeNote').textContent = '';
      const pEl = $('#formOption [name=priceYuan]'); if (pEl) pEl.readOnly = false;
      await loadEvents();
    } catch (err) { toast(err.message, 'err'); }
  };

  // 报名类型：4 类预选（单人/双人/邀请/候补）→ 带出名称+参考价，可再编辑
  const OPT_PRESET_NAME = { single: '单人票', double: '双人票', invite: '邀请票', waitlist: '候补票' };
  const OPT_PRESET_TYPE = { single: 'SINGLE', double: 'DOUBLE', invite: 'INVITE', waitlist: 'WAITLIST' };
  const OPT_REF_PRICE_YUAN = { single: 99, double: 169, invite: 99, waitlist: 0 };
  const OPT_TYPE_NOTE = {
    single: '单人票：1 人 1 码，支付后扫码核销。',
    double: '双人票：1 人付费、出 2 个码，两人各自扫码分别核销。',
    invite: '邀请票：需输入后台配置的"购买邀请码"才能购买；核销仍扫二维码。',
    waitlist: '候补票：免费、免支付、不计名额、不核销，仅统计候补人数。',
  };
  function applyOptPreset(preset) {
    const form = $('#formOption');
    const price = form.querySelector('[name=priceYuan]');
    const isWaitlist = preset === 'waitlist';
    const isInvite = preset === 'invite';
    if (OPT_PRESET_NAME[preset]) form.querySelector('[name=name]').value = OPT_PRESET_NAME[preset];
    if (OPT_REF_PRICE_YUAN[preset] !== undefined) price.value = String(OPT_REF_PRICE_YUAN[preset]);
    if (isWaitlist) { price.value = '0'; price.readOnly = true; form.querySelector('[name=gateCode]').value = ''; }
    else { price.readOnly = false; }
    $('#optGateLabel').style.display = isInvite ? '' : 'none';
    $('#optTypeNote').textContent = OPT_TYPE_NOTE[preset] || '';
  }
  $('#optPreset').onchange = (e) => applyOptPreset(e.target.value);

  // 编辑已有报名类型（名称 + 价格）
  function findOption(eventId, optId) {
    const ev = (state.events || []).find((x) => x.id === Number(eventId));
    return ((ev && ev.registrationOptions) || []).find((o) => o.id === Number(optId)) || null;
  }
  async function openOptionEdit(eventId, optId) {
    const o = findOption(eventId, optId);
    if (!o) { toast('未找到该报名类型，请刷新后重试', 'err'); return; }
    // 后台接口才返回 option_type + gate_code（公开接口已脱敏）
    let type = o.option_type || 'SINGLE'; let gate = '';
    try {
      const opts = await api('GET', `/admin/events/${eventId}/options`, { kind: 'admin' });
      const full = (opts || []).find((x) => x.id === Number(optId));
      if (full) { type = full.option_type || 'SINGLE'; gate = full.gate_code || ''; }
    } catch { /* 回退公开字段 */ }
    const isInvite = type === 'INVITE';
    const isWaitlist = type === 'WAITLIST';
    const typeZh = { SINGLE: '单人', DOUBLE: '双人', INVITE: '邀请', WAITLIST: '候补' }[type] || type;
    $('#optEditLabel').textContent = `${o.name} · ${o.price_display} · ${typeZh}票`;
    const form = $('#formOptionEdit');
    form.querySelector('[name=eventId]').value = String(eventId);
    form.querySelector('[name=optId]').value = String(optId);
    form.querySelector('[name=optionType]').value = type;
    form.querySelector('[name=name]').value = o.name || '';
    form.querySelector('[name=priceYuan]').value = o.price != null ? (Number(o.price) / 100).toFixed(2) : (o.price_display || '');
    form.querySelector('[name=priceYuan]').readOnly = isWaitlist;
    form.querySelector('[name=soldLimit]').value = o.sold_limit != null ? String(o.sold_limit) : '';
    $('#optEditGateLabel').style.display = isInvite ? '' : 'none';
    form.querySelector('[name=gateCode]').value = gate;
    $('#optEditWrap').style.display = 'block';
  }
  function closeOptionEdit() { $('#optEditWrap').style.display = 'none'; }
  $('#formOptionEdit').onsubmit = async (e) => {
    e.preventDefault();
    try {
      const f = new FormData(e.target);
      const optionType = f.get('optionType') || 'SINGLE';
      const gateCode = (f.get('gateCode') || '').toString().trim() || undefined;
      if (optionType === 'INVITE' && !gateCode) { toast('邀请票需填写购买邀请码', 'err'); return; }
      if (optionType === 'WAITLIST') f.set('priceYuan', '0');
      const soldLimitRaw = (f.get('soldLimit') || '').toString().trim();
      const soldLimit = soldLimitRaw === '' ? null : Number(soldLimitRaw);
      if (soldLimit !== null && (!Number.isInteger(soldLimit) || soldLimit < 0)) { toast('购票上限需为 ≥0 的整数（留空=不限）', 'err'); return; }
      const body = { name: f.get('name').trim(), price: Math.round(Number(f.get('priceYuan')) * 100), optionType, gateCode, soldLimit };
      await api('PUT', `/admin/events/${f.get('eventId')}/options/${f.get('optId')}`, { body, kind: 'admin' });
      toast('报名类型已更新', 'ok');
      closeOptionEdit(); await loadEvents();
    } catch (err) { toast(err.message, 'err'); }
  };
  $('#optEditCancel').onclick = () => closeOptionEdit();
  $('#optEditDelete').onclick = async () => {
    const form = $('#formOptionEdit');
    const evId = Number(form.querySelector('[name=eventId]').value);
    const optId = Number(form.querySelector('[name=optId]').value);
    if (!evId || !optId) { toast('缺少票种信息', 'err'); return; }
    if (!state.adminToken) { toast('请先在「后台」登录管理员', 'err'); return; }
    if (!confirm('确定删除该票种？若该票种已有报名，删除将被拒绝（409）。')) return;
    try {
      await deleteOption(optId, evId);
      closeOptionEdit();
    } catch (err) { toast(err.message, 'err'); }
  };

  $('#formRegister').onsubmit = (e) => createRegistration(e).catch((err) => toast(err.message, 'err'));

  // 签到
  $('#qrResolveBtn').onclick = () => qrResolve().catch((err) => toast(err.message, 'err'));
  $('#formQrCheckin').onsubmit = (e) => {
    e.preventDefault();
    if (!window._lastRegId) { toast('请先点“解析凭证”', 'err'); return; }
    doCheckin(window._lastRegId, 'QR').catch((err) => toast(err.message, 'err'));
  };

  $('#formPhoneCheckin').onsubmit = (e) => phoneSearch(e).catch((err) => toast(err.message, 'err'));

  // 后台
  $('#formAdminLogin').onsubmit = async (e) => {
    e.preventDefault();
    const f = new FormData(e.target);
    try {
      await adminLogin(f.get('username').trim(), f.get('password'));
      showAdminDash(true); await loadAdminDash(); toast('后台登录成功', 'ok');
    } catch (err) { toast(err.message, 'err'); }
  };
  $('#f_query').onclick = () => { state.regPage = 1; queryAdminRegs(1).catch((err) => toast(err.message, 'err')); };
  const fr = $('#f_reset');
  if (fr) fr.onclick = () => {
    ['f_regNo', 'f_name', 'f_attend', 'f_phone', 'f_event', 'f_optType', 'f_pay', 'f_ci', 'f_paidFrom'].forEach((id) => { const el = $(`#${id}`); if (el) el.value = ''; });
    state.regPage = 1;
    queryAdminRegs(1).catch((err) => toast(err.message, 'err'));
  };
  const fe = $('#f_export');
  if (fe) fe.onclick = (e) => { e.preventDefault(); downloadCsv().catch((err) => toast(err.message, 'err')); };
  // 参加次数统计：回头客筛选（§ ②）
  $('#f_attend_stat_btn').onclick = () => queryAttendance().catch((err) => toast(err.message, 'err'));
  $('#f_attend_stat_clear').onclick = () => { const el = $('#f_attend_stat'); if (el) el.value = ''; queryAttendance().catch(() => {}); };
  $('#reloginBtn').onclick = () => { localStorage.removeItem('cl_token'); location.reload(); };

  // 活动详情编辑（WYSIWYG）
  const deSel = $('#deEventSel');
  if (deSel) deSel.onchange = () => deLoadEvent(Number(deSel.value));
  ['#deTitle', '#deCity', '#deLocName', '#deAddr', '#deStart', '#deEnd', '#deReminder', '#deDesc'].forEach((sel) => {
    const el = $(sel);
    if (el) { el.oninput = deRenderPreview; el.onchange = deRenderPreview; }
  });
  // 富文本工具栏（contenteditable 选区操作）
  $$('.de-rt-toolbar button').forEach((b) => (b.onclick = () => {
    b.blur();
    const cmd = b.dataset.cmd;
    if (cmd) { try { document.execCommand(cmd, false, b.dataset.val || null); } catch (e) { /* 忽略 */ } }
    deRenderPreview();
  }));
  // 富文本插图：上传图片 → 插入光标处（与正文混排）
  const deRtImg = $('#deRtImg');
  const deRtImgFile = $('#deRtImgFile');
  if (deRtImg && deRtImgFile) deRtImg.onclick = () => deRtImgFile.click();
  if (deRtImgFile) deRtImgFile.onchange = async () => {
    const f = deRtImgFile.files[0]; if (!f) return;
    deRtImgFile.value = '';
    try {
      const url = await deUploadImage(f);
      insertHtmlAtCursor(`<img src="${url}" style="max-width:100%;border-radius:8px;display:block;margin:12px 0" alt="" />`);
      toast('已插入正文（有光标插光标处；无光标插正文末尾），可继续编辑', 'ok');
    } catch (e) { toast(e.message, 'err'); }
  };
  // 双封面：文件选择 → 打开裁切器（不直接上传，裁切确认后才上传）
  const openCropFromFile = (target, input) => {
    const f = input.files[0]; if (!f) return;
    input.value = '';
    deReadFileAsDataURL(f).then((dataUrl) => openCrop(target, dataUrl)).catch((e) => toast(e.message, 'err'));
  };
  const dcf = $('#deCoverFile');
  if (dcf) dcf.onchange = () => openCropFromFile('cover', dcf);
  const dcfd = $('#deCoverDetailFile');
  if (dcfd) dcfd.onchange = () => openCropFromFile('coverDetail', dcfd);
  const dcc = $('#deCoverCrop');
  if (dcc) dcc.onclick = () => { if (state._deCover) openCrop('cover', state._deCover); };
  const dcdc = $('#deCoverDetailCrop');
  if (dcdc) dcdc.onclick = () => { if (state._deCoverDetail) openCrop('coverDetail', state._deCoverDetail); };
  // 裁切弹窗：拖拽 / 滚轮缩放 / 按钮
  const cropStage = $('#cropStage');
  if (cropStage) {
    let dragging = null;
    cropStage.addEventListener('mousedown', (e) => {
      if (e.target.id !== 'cropImg' || !cropCtx) return;
      dragging = { x: e.clientX - cropCtx.dx, y: e.clientY - cropCtx.dy };
      e.preventDefault();
    });
    window.addEventListener('mousemove', (e) => {
      if (!dragging || !cropCtx) return;
      cropCtx.dx = e.clientX - dragging.x;
      cropCtx.dy = e.clientY - dragging.y;
      cropRender();
    });
    window.addEventListener('mouseup', () => { dragging = null; });
    cropStage.addEventListener('wheel', (e) => {
      e.preventDefault();
      if (!cropCtx) return;
      cropCtx.s = Math.max(0.4, Math.min(5, cropCtx.s * (e.deltaY < 0 ? 1.12 : 0.9)));
      cropRender();
    }, { passive: false });
  }
  const ci = $('#cropZoomIn'); if (ci) ci.onclick = () => { if (cropCtx) { cropCtx.s = Math.min(5, cropCtx.s * 1.2); cropRender(); } };
  const co = $('#cropZoomOut'); if (co) co.onclick = () => { if (cropCtx) { cropCtx.s = Math.max(0.4, cropCtx.s / 1.2); cropRender(); } };
  const cr = $('#cropReset'); if (cr) cr.onclick = () => { if (cropCtx) { cropCtx.s = Math.max(cropStage.clientWidth / cropCtx.natW, cropCtx.stageH / cropCtx.natH); cropCtx.dx = 0; cropCtx.dy = 0; cropRender(); } };
  const cok = $('#cropOk'); if (cok) cok.onclick = cropConfirm;
  const ccl = $('#cropCancel'); if (ccl) ccl.onclick = cropClose;
  $('#deSave').onclick = () => deSave().catch((e) => toast(e.message, 'err'));
  $('#deReset').onclick = () => { if (state._deEventId) deLoadEvent(state._deEventId); };
  const dar = $('#deArchive'); if (dar) dar.onclick = () => deArchive().catch((e) => toast(e.message, 'err'));
  const ddel = $('#deDelete'); if (ddel) ddel.onclick = () => deDelete().catch((e) => toast(e.message, 'err'));
  // 分享管理（「分享」tab）
  const shf = $('#shCoverFile');
  if (shf) shf.onchange = async () => {
    const f = shf.files[0]; if (!f) return;
    shf.value = '';
    try { _shCover = await deUploadImage(f); shRenderCover(); } catch (e) { toast(e.message, 'err'); }
  };
  const shc = $('#shCoverClear'); if (shc) shc.onclick = () => { _shCover = null; shRenderCover(); };
  const shForm = $('#formShare');
  if (shForm) shForm.onsubmit = (e) => { e.preventDefault(); shSave().catch((err) => toast(err.message, 'err')); };
  const shr = $('#shReset'); if (shr) shr.onclick = shResetForm;
  const shl = $('#shareList');
  if (shl) shl.addEventListener('click', (e) => {
    const eb = e.target.closest('[data-edit]');
    if (eb) {
      const s = (state._shares || []).find((x) => x.id === Number(eb.dataset.edit));
      if (s) shFillForm(s);
      return;
    }
    const sb = e.target.closest('[data-status]');
    if (sb) {
      shSetStatus(Number(sb.dataset.status), sb.dataset.next).catch((err) => toast(err.message, 'err'));
      return;
    }
    const dbb = e.target.closest('[data-del]');
    if (dbb) {
      const id = Number(dbb.dataset.del);
      const s = (state._shares || []).find((x) => x.id === id);
      if (!confirm(`删除分享「${s ? s.title : '#' + id}」？`)) return;
      api('DELETE', `/admin/shares/${id}`, { kind: 'admin' })
        .then(() => { toast('分享已删除', 'ok'); if (_shEditId === id) shResetForm(); loadShares(); })
        .catch((err) => toast(err.message, 'err'));
    }
  });
  const shRef = $('#shareRefresh'); if (shRef) shRef.onclick = () => loadShares().catch((e) => toast(e.message, 'err'));
  // 分享正文富文本工具栏 + 插图（与活动详情编辑器一致）
  const shRtToolbar = $('#shRtToolbar');
  if (shRtToolbar) {
    shRtToolbar.querySelectorAll('button[data-cmd]').forEach((b) => (b.onclick = () => {
      b.blur();
      const cmd = b.dataset.cmd;
      if (cmd) { try { document.execCommand(cmd, false, b.dataset.val || null); } catch (e) { /* 忽略 */ } }
    }));
    const shRtImg = $('#shRtImg');
    const shRtImgFile = $('#shRtImgFile');
    if (shRtImg && shRtImgFile) shRtImg.onclick = () => shRtImgFile.click();
    if (shRtImgFile) shRtImgFile.onchange = async () => {
      const f = shRtImgFile.files[0]; if (!f) return;
      shRtImgFile.value = '';
      try {
        const url = await deUploadImage(f);
        insertHtmlAtCursor(`<img src="${url}" style="max-width:100%;border-radius:8px;display:block;margin:12px 0" alt="" />`);
        toast('已插入正文，可继续编辑', 'ok');
      } catch (e) { toast(e.message, 'err'); }
    };
  }
  // 评论管理看板：按类型分布在 活动/分享/论坛 三个子 tab，共用事件委托（删除/展开）
  ['evCmtList', 'shCmtList', 'poCmtList'].forEach((id) => {
    const w = document.getElementById(id);
    if (!w) return;
    w.addEventListener('click', (e) => {
      const db2 = e.target.closest('[data-cmtdel]');
      if (db2) { delComment(Number(db2.dataset.cmtdel)); return; }
      const ex = e.target.closest('[data-cmtexpand]');
      if (ex) toggleCmtReplies(Number(ex.dataset.cmtexpand));
    });
  });
  // 各类型评论刷新按钮
  const cmtRefreshMap = { evCmtRefresh: ['EVENT', 'evCmtList'], shCmtRefresh: ['SHARE', 'shCmtList'], poCmtRefresh: ['POST', 'poCmtList'] };
  Object.keys(cmtRefreshMap).forEach((id) => {
    const b = document.getElementById(id);
    if (b) b.onclick = () => { const m = cmtRefreshMap[id]; loadComments(m[0], m[1]).catch((e) => toast(e.message, 'err')); };
  });
  // 论坛帖子管理：归档 / 恢复 / 删除
  ['forumList', 'forumArchivedList'].forEach((id) => {
    const w = document.getElementById(id);
    if (!w) return;
    w.addEventListener('click', (e) => {
      const pa = e.target.closest('[data-parchive]');
      if (pa) { forumArchive(Number(pa.dataset.parchive)).catch((err) => toast(err.message, 'err')); return; }
      const pr = e.target.closest('[data-prestore]');
      if (pr) { forumRestore(Number(pr.dataset.prestore)).catch((err) => toast(err.message, 'err')); return; }
      const pd = e.target.closest('[data-pdel]');
      if (pd) forumDel(Number(pd.dataset.pdel));
    });
  });
  const foRef = $('#forumRefresh'); if (foRef) foRef.onclick = () => loadForumPosts('ACTIVE').catch((e) => toast(e.message, 'err'));
  const foArchRef = $('#forumArchivedRefresh'); if (foArchRef) foArchRef.onclick = () => loadForumPosts('ARCHIVED').catch((e) => toast(e.message, 'err'));
  // 分享归档：恢复发布 / 删除
  const shArch = $('#shareArchivedList');
  if (shArch) shArch.addEventListener('click', (e) => {
    const rs = e.target.closest('[data-shrestore]');
    if (rs) { shRestore(Number(rs.dataset.shrestore)).catch((err) => toast(err.message, 'err')); return; }
    const dd = e.target.closest('[data-del]');
    if (dd) {
      const id = Number(dd.dataset.del);
      const s = (state._shares || []).find((x) => x.id === id);
      if (!confirm(`删除分享「${s ? s.title : '#' + id}」？`)) return;
      api('DELETE', `/admin/shares/${id}`, { kind: 'admin' })
        .then(() => { toast('分享已删除', 'ok'); if (_shEditId === id) shResetForm(); loadShares(); loadShareArchived(); })
        .catch((err) => toast(err.message, 'err'));
    }
  });
  const shArchRef = $('#shareArchivedRefresh'); if (shArchRef) shArchRef.onclick = () => loadShareArchived().catch((e) => toast(e.message, 'err'));
  // 自定义报名字段编辑器（委托绑定：增删/编辑不逐个重绑）
  const cfWrap = $('#deCustomFields');
  if (cfWrap) {
    cfWrap.addEventListener('input', (e) => {
      const f = state._deCustomFields[Number(e.target.dataset.i)];
      if (!f) return;
      if (e.target.classList.contains('de-cf-label')) f.label = e.target.value;
      else if (e.target.classList.contains('de-cf-key')) f.key = e.target.value;
      else if (e.target.classList.contains('de-cf-options')) f.options = e.target.value.split('\n').map((s) => s.trim()).filter(Boolean);
    });
    cfWrap.addEventListener('change', (e) => {
      const f = state._deCustomFields[Number(e.target.dataset.i)];
      if (!f) return;
      if (e.target.type === 'checkbox') f.required = e.target.checked;
      else if (e.target.classList.contains('de-cf-type')) { f.type = e.target.value; deRenderCustomFields(); }
    });
    cfWrap.addEventListener('click', (e) => {
      if (!e.target.classList.contains('de-cf-del')) return;
      state._deCustomFields.splice(Number(e.target.dataset.i), 1);
      deRenderCustomFields();
    });
  }
  const cfAdd = $('#deCfAdd');
  if (cfAdd) cfAdd.onclick = () => { state._deCustomFields.push({ label: '', key: '', required: false, type: 'text' }); deRenderCustomFields(); };
  // 封面预览随窗口缩放重算（JS 手动 cover，任何内核不变形）
  let _coverResizeT = null;
  window.addEventListener('resize', () => {
    clearTimeout(_coverResizeT);
    _coverResizeT = setTimeout(fitCoverAll, 120);
  });
  const ar = $('#archivedRefresh');
  if (ar) ar.onclick = () => loadArchived().catch((e) => toast(e.message, 'err'));

  if (state.adminToken) { showAdminDash(true); loadAdminDash().catch(() => {}); }
  diag('init 完成 | #tabs按钮=' + document.querySelectorAll('#tabs button').length
    + ' | #archivedList=' + (document.getElementById('archivedList') ? '存在' : '缺失')
    + ' | #tab-share=' + (document.getElementById('tab-share') ? '存在' : '缺失')
    + ' | #formShare=' + (document.getElementById('formShare') ? '存在' : '缺失')
    + ' | #shareList=' + (document.getElementById('shareList') ? '存在' : '缺失')
    + ' | #tab-comments=' + (document.getElementById('tab-comments') ? '存在' : '缺失')
    + ' | #cmtList=' + (document.getElementById('cmtList') ? '存在' : '缺失')
    + ' | adminToken=' + (state.adminToken ? '有' : '无')
    + ' | UI=' + UI_VERSION);
}

function showAdminDash(on) {
  $('#adminLoginWrap').style.display = on ? 'none' : '';
  $('#adminDash').style.display = on ? '' : 'none';
}

function toLocalInput(ms) {
  // 防御：非法时间（NaN/undefined/异常字符串）一律返回空串，绝不抛 Invalid time value
  const n = Number(ms);
  if (ms == null || !Number.isFinite(n)) return '';
  const d = new Date(n - new Date().getTimezoneOffset() * 60000);
  if (Number.isNaN(d.getTime())) return '';
  return d.toISOString().slice(0, 16);
}

// 页面结构齐全时才自行 init；旧结构由守卫标记 __stalePage 并交给 bootFromServer 在替换
// body 后统一 init（避免 double-init 竞态：旧结构上的 init 与 boot 后的 init 并发互相干扰）。
if (!window.__stalePage) {
  init().catch((err) => { console.error('INIT FAILED:', err); reportErr('init 失败: ' + (err && err.message || err)); });
}