'use strict';
/* 前端：登录 / WebSocket 实时指标 / 服务控制 / 命令终端 / 电源 */
(function () {
  const $ = (id) => document.getElementById(id);

  const S = {
    ws: null,
    authed: false,
    host: '—',
    hist: { cpu: [], mem: [], rx: [], tx: [] },
    confirmCb: null,
    retry: 0,
    svcData: [],
    histIdx: -1,
  };

  /* ---------------- 工具 ---------------- */
  function fmtBytes(n) {
    if (!n && n !== 0) return '—';
    const u = ['B', 'K', 'M', 'G', 'T'];
    let i = 0;
    let v = n;
    while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
    return (v >= 100 || i === 0 ? v.toFixed(0) : v.toFixed(1)) + u[i];
  }
  function fmtRate(n) {
    if (!n && n !== 0) return '0 B/s';
    const u = ['B/s', 'K/s', 'M/s', 'G/s'];
    let i = 0;
    let v = n;
    while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
    return (v >= 100 || i === 0 ? v.toFixed(0) : v.toFixed(1)) + ' ' + u[i];
  }
  function fmtDur(sec) {
    sec = Math.max(0, Math.floor(sec));
    const d = Math.floor(sec / 86400);
    const h = Math.floor((sec % 86400) / 3600);
    const m = Math.floor((sec % 3600) / 60);
    if (d) return d + '天 ' + h + '小时';
    if (h) return h + '小时 ' + m + '分';
    return m + '分 ' + (sec % 60) + '秒';
  }
  function toast(msg, bad) {
    const t = $('toast');
    t.textContent = msg;
    t.className = 'toast show' + (bad ? ' bad' : '');
    clearTimeout(t._h);
    t._h = setTimeout(() => { t.className = 'toast'; }, 2600);
  }

  /* ---------------- 主题（白天 / 夜晚） ---------------- */
  const THEME_KEY = 'sp.theme';

  function cssVar(name, fallback) {
    try {
      const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
      return v || fallback;
    } catch (e) { return fallback; }
  }

  function currentTheme() {
    return document.documentElement.getAttribute('data-theme') === 'light' ? 'light' : 'dark';
  }

  function applyTheme(mode) {
    const m = mode === 'light' ? 'light' : 'dark';
    document.documentElement.setAttribute('data-theme', m);
    const cs = document.querySelector('meta[name="color-scheme"]');
    if (cs) cs.setAttribute('content', m === 'light' ? 'light' : 'dark');
    const tc = document.querySelector('meta[name="theme-color"]');
    if (tc) tc.setAttribute('content', m === 'light' ? '#f3f2ee' : '#0a0b0d');
    // 开关按钮：aria-checked 表示"是否处于白天"，图标由 CSS 依据 data-theme 显示日/月
    const label = m === 'light' ? '夜晚' : '白天';
    ['btn-theme', 'btn-theme-login'].forEach((id) => {
      const b = $(id);
      if (!b) return;
      b.setAttribute('aria-checked', m === 'light' ? 'true' : 'false');
      b.title = '切换到' + label;
    });
    redrawSparks();
  }

  function toggleTheme() {
    const next = currentTheme() === 'light' ? 'dark' : 'light';
    try { localStorage.setItem(THEME_KEY, next); } catch (e) { /* 隐私模式忽略 */ }
    applyTheme(next);
  }

  function redrawSparks() {
    if (!S.hist.cpu.length) return;
    spark($('c-cpu-spark'), S.hist.cpu, 100);
    if (S.hist.mem.length) spark($('c-mem-spark'), S.hist.mem, 100);
    if (S.hist.rx.length) {
      const peak = Math.max(1024, ...S.hist.rx, ...S.hist.tx) * 1.1;
      spark($('c-net-spark'), S.hist.rx, peak, null, null, S.hist.tx);
    }
  }

  /* ---------------- 迷你折线 ---------------- */
  function spark(canvas, arr, max, color, color2, arr2) {
    if (!canvas) return;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const w = canvas.clientWidth || 300;
    const h = canvas.clientHeight || 46;
    if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(h * dpr);
    }
    const c = canvas.getContext('2d');
    c.setTransform(dpr, 0, 0, dpr, 0, 0);
    c.clearRect(0, 0, w, h);
    c.strokeStyle = cssVar('--spark-grid', 'rgba(255,255,255,0.055)');
    c.lineWidth = 1;
    for (let i = 1; i < 3; i++) {
      const y = (h / 3) * i;
      c.beginPath(); c.moveTo(0, y); c.lineTo(w, y); c.stroke();
    }
    const draw = (data, col, fill) => {
      if (data.length < 2) return;
      const n = data.length;
      const step = w / Math.max(1, n - 1);
      c.beginPath();
      for (let i = 0; i < n; i++) {
        const v = Math.max(0, Math.min(max, data[i])) / max;
        const x = i * step;
        const y = h - 3 - v * (h - 8);
        if (i === 0) c.moveTo(x, y); else c.lineTo(x, y);
      }
      if (fill) {
        const grad = c.createLinearGradient(0, 0, 0, h);
        grad.addColorStop(0, fill);
        grad.addColorStop(1, 'rgba(0,0,0,0)');
        c.lineTo(w, h); c.lineTo(0, h); c.closePath();
        c.fillStyle = grad; c.fill();
        c.beginPath();
        for (let i = 0; i < n; i++) {
          const v = Math.max(0, Math.min(max, data[i])) / max;
          const x = i * step;
          const y = h - 3 - v * (h - 8);
          if (i === 0) c.moveTo(x, y); else c.lineTo(x, y);
        }
      }
      c.strokeStyle = col; c.lineWidth = 1.6; c.stroke();
    };
    if (arr2) draw(arr2, color2 || cssVar('--spark-b', 'rgba(92,189,138,0.85)'), null);
    draw(arr, color || cssVar('--spark-a', 'rgba(217,165,102,0.95)'), cssVar('--spark-fill', 'rgba(217,165,102,0.15)'));
  }

  /* ---------------- 登录 ---------------- */
  async function api(path, body, method) {
    const opt = { method: method || (body ? 'POST' : 'GET'), headers: {} };
    if (body) { opt.headers['Content-Type'] = 'application/json'; opt.body = JSON.stringify(body); }
    const r = await fetch(path, opt);
    let j = null;
    try { j = await r.json(); } catch (e) { j = { ok: false, err: 'HTTP ' + r.status + '（响应不是 JSON）' }; }
    return { status: r.status, ...j };
  }

  async function ping() {
    try {
      const r = await api('/api/ping');
      $('login-host').textContent = r.host || '—';
      if (r.auth) return true;
    } catch (e) { /* 服务没起来 */ }
    return false;
  }

  $('login-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = $('lg-btn');
    if (btn.disabled) return;
    const old = btn.textContent;
    btn.disabled = true;
    btn.textContent = '登录中…';
    $('lg-err').textContent = '';
    try {
      const r = await api('/api/login', { user: $('lg-user').value.trim(), pass: $('lg-pass').value });
      if (r.ok) { enterApp(); return; }
      $('lg-err').textContent = r.err || ('登录失败（HTTP ' + r.status + '）');
      $('lg-pass').value = '';
      $('lg-pass').focus();
    } catch (err) {
      $('lg-err').textContent = '网络错误：' + ((err && err.message) || '请求失败');
    } finally {
      btn.disabled = false;
      btn.textContent = old;
    }
  });

  $('btn-logout').addEventListener('click', async () => {
    await api('/api/logout', {});
    location.reload();
  });

  function enterApp() {
    S.authed = true;
    $('login-wrap').hidden = true;
    // 登录页那颗角落开关让位给顶栏的同款开关
    const fab = $('btn-theme-login');
    if (fab) fab.hidden = true;
    $('app').hidden = false;
    showServers();
    connect();
  }

  /* ---------------- WebSocket ---------------- */
  function connect() {
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    let ws;
    try {
      ws = new WebSocket(proto + '//' + location.host + '/ws');
    } catch (e) {
      toast('WebSocket 无法建立：' + ((e && e.message) || e), true);
      $('live-dot').classList.add('off');
      return;
    }
    S.ws = ws;
    ws.onopen = () => {
      S.retry = 0;
      $('live-dot').classList.remove('off');
      $('conn').hidden = true;
    };
    ws.onclose = () => {
      $('live-dot').classList.add('off');
      $('conn').hidden = false;
      S.retry++;
      const delay = Math.min(1500 * S.retry, 8000);
      setTimeout(() => { if (S.authed) connect(); }, delay);
    };
    ws.onerror = () => {};
    ws.onmessage = (ev) => {
      let m;
      try { m = JSON.parse(ev.data); } catch (e) { return; }
      if (m.t === 'state' && (!S.hostId || S.hostId === 'local')) render(m.data);
      else if (m.t === 'pong') { /* noop */ }
    };
  }

  function send(o) {
    if (S.ws && S.ws.readyState === 1) S.ws.send(JSON.stringify(o));
  }

  /* ---------------- 渲染 ---------------- */
  let lastSvcKey = '';

  function render(d) {
    const h = d.host;
    S.host = h.hostname;
    $('h-host').textContent = h.hostname;
    $('h-os').textContent = h.platform + ' ' + h.release + ' · ' + h.arch;
    $('h-uptime').textContent = 'uptime ' + fmtDur(h.uptime);
    $('h-load').textContent = 'load ' + d.load.map((x) => x.toFixed(2)).join(' / ');

    /* CPU */
    const cpu = d.cpu.pct;
    $('c-cpu').textContent = cpu.toFixed(1) + '%';
    const cb = $('c-cpu-bar');
    cb.style.width = Math.min(100, cpu) + '%';
    cb.className = cpu > 85 ? 'bad' : cpu > 60 ? 'warn' : '';
    $('c-cores').innerHTML = d.cpu.cores.slice(0, 16)
      .map((v, i) => '<span title="core ' + i + '">' + Math.round(v) + '%</span>').join('');
    $('c-cpu-info').textContent = h.cores + ' 核 · ' + h.model;
    S.hist.cpu.push(cpu);
    if (S.hist.cpu.length > 90) S.hist.cpu.shift();
    spark($('c-cpu-spark'), S.hist.cpu, 100);

    /* 内存 */
    const m = d.mem;
    const memPct = m.total ? (m.used / m.total) * 100 : 0;
    $('c-mem').textContent = memPct.toFixed(0) + '%';
    const mb = $('c-mem-bar');
    mb.style.width = memPct + '%';
    mb.className = memPct > 88 ? 'bad' : memPct > 70 ? 'warn' : '';
    $('c-mem-kv').innerHTML =
      '<div><span>已用</span><b>' + fmtBytes(m.used) + ' / ' + fmtBytes(m.total) + '</b></div>' +
      '<div><span>可用</span><b>' + fmtBytes(m.avail) + '</b></div>' +
      '<div><span>Swap</span><b>' + fmtBytes(m.swapUsed) + ' / ' + fmtBytes(m.swapTotal) + '</b></div>';
    S.hist.mem.push(memPct);
    if (S.hist.mem.length > 90) S.hist.mem.shift();
    spark($('c-mem-spark'), S.hist.mem, 100);

    /* 网络（本机读 /proc/net/dev，远程由探测脚本带回同一份计数） */
    const rate = d.net.rate;
    $('c-net').textContent = fmtRate(rate.rx + rate.tx);
    $('c-net-kv').innerHTML =
      '<div><span>↓ 下行</span><b>' + fmtRate(rate.rx) + '</b></div>' +
      '<div><span>↑ 上行</span><b>' + fmtRate(rate.tx) + '</b></div>' +
      '<div><span>累计</span><b>' + fmtBytes(d.net.total.rx) + ' / ' + fmtBytes(d.net.total.tx) + '</b></div>';
    S.hist.rx.push(rate.rx);
    S.hist.tx.push(rate.tx);
    if (S.hist.rx.length > 90) { S.hist.rx.shift(); S.hist.tx.shift(); }
    const peak = Math.max(1024, ...S.hist.rx, ...S.hist.tx) * 1.1;
    spark($('c-net-spark'), S.hist.rx, peak, null, null, S.hist.tx);
    $('c-net-info').innerHTML =
      '<span class="lg"><i class="sw sw-a"></i>下行</span>' +
      '<span class="lg"><i class="sw sw-b"></i>上行</span>';

    renderRest(d);
  }

  /* 网络之后的公共渲染（本地与远程共用） */
  function renderRest(d) {
    const h = d.host;
    /* 磁盘 */
    if (d.disk.length) {
      const root = d.disk.find((x) => x.mount === '/') || d.disk[0];
      $('c-disk').textContent = root.pct + '%';
      $('c-disks').innerHTML = d.disk.map((x) =>
        '<div class="disk-row"><div class="t"><span>' + x.mount + '</span><span>' +
        fmtBytes(x.used) + ' / ' + fmtBytes(x.size) + '</span></div>' +
        '<div class="b"><i style="width:' + Math.min(100, x.pct) + '%"></i></div></div>').join('');
    }

    /* 进程 */
    const tb = $('proc-table').querySelector('tbody');
    tb.innerHTML = d.procs.map((p) =>
      '<tr data-pid="' + p.pid + '" data-name="' + esc(p.name) + '">' +
      '<td>' + p.pid + '</td><td class="name">' + esc(p.name) + '</td>' +
      '<td class="r">' + p.cpu.toFixed(1) + '%</td><td class="r">' + p.mem.toFixed(1) + '%</td>' +
      '<td class="r">' + fmtBytes(p.rss) + '</td>' +
      '<td class="ta">' + actBtn('kill', '结束进程', true) + '</td></tr>').join('') ||
      '<tr><td colspan="6" style="color:var(--text-mute)">没有取到进程列表</td></tr>';

    /* 服务 */
    S.svcData = d.services;
    const key = d.services.map((s) => s.unit + ':' + s.active + ':' + s.sub).join('|');
    if (key !== lastSvcKey) { lastSvcKey = key; paintSvc(); }

    $('h-clock').textContent = new Date().toLocaleTimeString('zh-CN', { hour12: false });
    $('foot').textContent = (d.remote ? 'SSH 采集 · ' : '') + 'Node ' + h.node + ' · 采样间隔 2s · ' +
      new Date(d.t).toLocaleString('zh-CN');
  }

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  }

  /* ---------------- 服务渲染 / 筛选 ---------------- */
  function paintSvc() {
    const all = S.svcData || [];
    const q = ($('svc-filter').value || '').trim().toLowerCase();
    const list = q ? all.filter((s) => (s.unit + ' ' + s.desc + ' ' + s.sub).toLowerCase().includes(q)) : all;
    $('svc-count').textContent = q ? list.length + ' / ' + all.length : String(all.length);

    if (!list.length) {
      $('svc-list').innerHTML = '<div class="svc"><span class="nm" style="color:var(--text-mute)">没有匹配的单元</span></div>';
      return;
    }
    $('svc-list').innerHTML = list.map((s) => {
      const cls = s.active === 'active' ? 'active' : s.active === 'failed' ? 'failed' : '';
      const running = s.active === 'active';
      return '<div class="svc" data-unit="' + esc(s.unit) + '" tabindex="0" role="group" aria-label="' + esc(s.unit) + ' ' + esc(s.sub) + '">' +
        '<i class="st ' + cls + '"></i>' +
        '<span class="nm" title="' + esc(s.desc) + '">' + esc(s.unit) + '<i>' + esc(s.sub) + '</i></span>' +
        '<span class="acts">' +
        (running
          ? '<button data-u="' + s.unit + '" data-a="restart">重启</button><button class="stop" data-u="' + s.unit + '" data-a="stop">停止</button>'
          : '<button data-u="' + s.unit + '" data-a="start">启动</button>') +
        '<button data-log="' + s.unit + '">日志</button>' +
        '</span></div>';
    }).join('');
    if (q) {
      // 筛选时把命中的单元短暂高亮一下，方便扫视
      const first = $('svc-list').querySelector('.svc .nm');
      if (first) first.style.color = 'var(--text)';
    }
  }
  $('svc-filter').addEventListener('input', () => paintSvc());

  /* ---------------- 服务操作 ---------------- */
  $('svc-list').addEventListener('click', async (e) => {
    const btn = e.target.closest('button');
    if (!btn) return;
    if (btn.dataset.log) return openLogs(btn.dataset.log);
    const unit = btn.dataset.u;
    const action = btn.dataset.a;
    if (!unit || !action) return;
    btn.disabled = true;
    const r = await api('/api/service', { unit, action, host: S.hostId || 'local' });
    btn.disabled = false;
    toast(r.ok ? unit + ' ' + action + ' 成功' : (r.err || '操作失败'), !r.ok);
  });

  /* ---------------- 日志 ---------------- */
  async function openLogs(unit) {
    $('log-title').textContent = unit + ' · 最近 300 行';
    $('log-body').textContent = '加载中…';
    $('log-modal').hidden = false;
    const r = await api('/api/logs', { unit, lines: 300, host: S.hostId || 'local' });
    $('log-body').textContent = r.out || r.err || '(空)';
  }
  $('log-close').addEventListener('click', () => { $('log-modal').hidden = true; });
  $('log-modal').addEventListener('click', (e) => { if (e.target === $('log-modal')) $('log-modal').hidden = true; });

  /* ---------------- 确认弹层 ---------------- */
  function askConfirm(title, text, cb, noInput) {
    $('cf-title').textContent = title;
    $('cf-text').textContent = text;
    $('cf-input').value = '';
    $('cf-input').hidden = !!noInput;     /* 结束进程这类只要「确认/取消」，不要输入框 */
    $('confirm-modal').hidden = false;
    S.confirmCb = cb;
    setTimeout(function () { if (!noInput) $('cf-input').focus(); }, 50);
  }
  $('cf-cancel').addEventListener('click', function () { $('confirm-modal').hidden = true; S.confirmCb = null; });
  $('cf-ok').addEventListener('click', function () {
    var v = $('cf-input').value.trim();
    $('confirm-modal').hidden = true;
    var cb = S.confirmCb;
    S.confirmCb = null;
    if (cb) cb(v);
  });

  /* ---------------- 输入小卡片（v10：替代 window.prompt） ---------------- */
  function askPrompt(title, hint, value, cb) {
    $('pm-title').textContent = title;
    $('pm-hint').textContent = hint || '';
    $('pm-input').value = value || '';
    $('prompt-modal').hidden = false;
    S.promptCb = cb;
    setTimeout(function () { $('pm-input').focus(); $('pm-input').select(); }, 50);
  }
  function closePrompt() { $('prompt-modal').hidden = true; S.promptCb = null; }
  $('pm-cancel').addEventListener('click', closePrompt);
  $('pm-ok').addEventListener('click', function () {
    var v = $('pm-input').value.trim();
    var cb = S.promptCb;
    closePrompt();
    if (cb) cb(v);
  });
  $('pm-input').addEventListener('keydown', function (e) {
    if (e.key === 'Enter') { e.preventDefault(); $('pm-ok').click(); }
  });

  /* ---------------- 全局悬停提示（v11） ---------------- */
  var tipEl = null;
  var tipFor = null;

  /* 惰性取节点：即使浮层排在脚本之后，第一次 hover 时才查询也能拿到 */
  function tipNode() {
    if (!tipEl) tipEl = $('tip');
    return tipEl;
  }

  function placeTip(el) {
    var t = tipNode();
    if (!t) return;
    var r = el.getBoundingClientRect ? el.getBoundingClientRect() : { left: 0, top: 0, right: 0, width: 0, height: 0 };
    var w = t.offsetWidth || 96;
    var h = t.offsetHeight || 22;
    var gap = 8;
    var x = r.left - gap - w;                 /* 优先放左边 */
    if (x < 8) x = r.right + gap;             /* 左边放不下就放右边 */
    if (x + w > window.innerWidth - 8) x = window.innerWidth - w - 8;
    if (x < 8) x = 8;
    var y = r.top + r.height / 2 - h / 2;
    y = Math.min(Math.max(8, y), window.innerHeight - h - 8);
    t.style.left = Math.round(x) + 'px';
    t.style.top = Math.round(y) + 'px';
  }
  function showTip(el) {
    var t = tipNode();
    var text = el.getAttribute && el.getAttribute('data-tip');
    if (!t || !text) return;
    tipFor = el;
    t.textContent = text;
    t.hidden = false;
    placeTip(el);
    t.classList.add('on');
  }
  function hideTip() {
    tipFor = null;
    var t = tipNode();
    if (!t) return;
    t.classList.remove('on');
    t.hidden = true;
  }
  function tipTarget(ev) {
    var t = ev && ev.target;
    return t && t.closest ? t.closest('[data-tip]') : null;
  }
  document.addEventListener('mouseover', function (ev) {
    var el = tipTarget(ev);
    if (el && el !== tipFor) showTip(el);
  });
  document.addEventListener('mouseout', function (ev) {
    var el = tipTarget(ev);
    if (el && el === tipFor) hideTip();
  });
  document.addEventListener('focusin', function (ev) {
    var el = tipTarget(ev);
    if (el) showTip(el);
  });
  document.addEventListener('focusout', hideTip);
  document.addEventListener('scroll', hideTip, true);
  window.addEventListener('resize', hideTip);

  /* ---------------- 结束进程（v10） ---------------- */
  function procKill(pid, name) {
    askConfirm('结束进程',
      'PID ' + pid + ' · ' + name + '\n将向该进程发送 SIGTERM，它会立即退出。',
      function () {
        api('/api/proc/kill', { pid: pid, name: name, host: S.hostId || 'local' }).then(function (r) {
          toast(r.ok ? ('已结束 PID ' + pid) : (r.err || '结束失败'), !r.ok);
        });
      }, true);
  }
  $('proc-table').addEventListener('click', function (e) {
    var btn = e.target && e.target.closest ? e.target.closest('.ico-btn[data-act="kill"]') : null;
    if (!btn) return;
    var tr = btn.closest('tr');
    if (!tr) return;
    procKill(Number(tr.dataset.pid), tr.dataset.name);
  });

  /* ---------------- 文件管理 ---------------- */
  var FS = { dir: '/var/www', entries: [], cur: null, mtime: 0, size: 0, mode: '', dirty: false };

  /* 三个居中元信息：大小 / 修改时间 / 权限 */
  function setMeta(size, mtime, mode, prefix) {
    var p = prefix || 'fs-ed';
    $(p + '-size').textContent = size === null || size === undefined ? '—' : fmtSize(size);
    $(p + '-time').textContent = mtime ? fmtTime(mtime) : '—';
    $(p + '-mode').textContent = mode || '—';
  }

  function fmtSize(n) {
    if (n < 1024) return n + ' B';
    if (n < 1048576) return (n / 1024).toFixed(1) + ' K';
    if (n < 1073741824) return (n / 1048576).toFixed(1) + ' M';
    return (n / 1073741824).toFixed(2) + ' G';
  }
  function fmtTime(ms) {
    var d = new Date(ms), p = function (x) { return (x < 10 ? '0' : '') + x; };
    return p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes());
  }
  function setStatus(txt, bad) {
    var el = $('fs-status');
    if (!el) return;
    el.textContent = txt;
    el.className = 'fs-status' + (bad ? ' bad' : '');
  }

  /* 行内动作按钮：图标 + 悬停提示（v8） */
  var ACT_ICONS = {
    edit: '<path d="M11.4 2.6l2 2L6 12l-3 1 1-3 7.4-7.4z"/>',
    dl: '<path d="M8 2v8m0 0l3-3m-3 3L5 7M3 14h10"/>',
    ren: '<path d="M2 8l3-3h9v6H5L2 8z"/><circle cx="5" cy="8" r="1.1"/>',
    del: '<path d="M3 5h10M6 5V3.2h4V5M4.6 5l.7 9h5.4l.7-9M6.8 8v3.6M9.2 8v3.6"/>',
    kill: '<circle cx="8" cy="8" r="5.6"/><path d="M8 4.8v3.4"/>',
  };
  function actBtn(act, label, danger) {
    return '<button class="ico-btn' + (danger ? ' danger' : '') + '" data-act="' + act + '" ' +
      'data-tip="' + label + '" aria-label="' + label + '">' +
      '<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" ' +
      'stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round">' + ACT_ICONS[act] + '</svg></button>';
  }

  function fsRender() {
    var box = $('fs-list');
    box.innerHTML = '';
    if (!FS.entries.length) {
      var empty = document.createElement('div');
      empty.className = 'fs-empty';
      empty.textContent = '（空目录）';
      box.appendChild(empty);
      return;
    }
    FS.entries.forEach(function (e) {
      var row = document.createElement('div');
      row.className = 'fs-row' + (e.dir ? ' is-dir' : '') + (e.hidden ? ' is-hidden' : '');
      row.tabIndex = 0;
      row.setAttribute('role', 'button');
      row.dataset.path = e.path;
      row.dataset.name = e.name;
      row.dataset.dir = e.dir ? '1' : '0';
      if (!e.dir) {
        row.draggable = true;
        row.addEventListener('dragstart', function (ev) {
          var url = location.origin + '/api/fs/download?path=' + encodeURIComponent(e.path) + '&host=' + encodeURIComponent(S.hostId || 'local');
          try {
            ev.dataTransfer.setData('DownloadURL', 'application/octet-stream:' + e.name + ':' + url);
            ev.dataTransfer.setData('text/uri-list', url);
            ev.dataTransfer.effectAllowed = 'copy';
          } catch (err) { /* 仅 text 可用时忽略 */ }
        });
      }
      var acts = e.dir
        ? actBtn('ren', '重命名') + actBtn('del', '删除', true)
        : actBtn('dl', '下载') + actBtn('ren', '重命名') + actBtn('del', '删除', true);
      row.innerHTML =
        '<span class="fs-name"><i class="fs-ico">' + (e.dir ? '▸' : '·') + '</i>' + esc(e.name) +
          (e.link ? ' <em>→ ' + esc(e.link) + '</em>' : '') + '</span>' +
        '<span class="r">' + (e.dir ? '—' : fmtSize(e.size)) + '</span>' +
        '<span>' + fmtTime(e.mtime) + '</span>' +
        '<span class="fs-mode">' + e.mode + '</span>' +
        '<span class="fs-acts">' + acts + '</span>';
      box.appendChild(row);
    });
  }

  async function fsLoad(dir, quiet) {
    if (FS.dirty && !quiet && !window.confirm('当前文件还没保存，仍要切换目录吗？')) return;
    setStatus('读取目录…');
    try {
      var r = await api('/api/fs/list?dir=' + encodeURIComponent(dir) + '&host=' + encodeURIComponent(S.hostId || 'local'));
      if (!r.ok) { setStatus(r.err || '读取失败', true); return; }
      FS.dir = r.dir;
      FS.entries = r.entries || [];
      $('fs-path').value = r.dir;
      $('fs-up').disabled = !r.parent;
      $('fs-hint').textContent = r.count + ' 项 · ' + r.dir;
      fsRender();
      setStatus('已载入 ' + r.count + ' 项');
    } catch (e) { setStatus('网络错误：' + ((e && e.message) || e), true); }
  }

  async function fsOpen(path) {
    if (FS.dirty && !window.confirm('当前文件还没保存，仍要打开其它文件吗？')) return;
    try {
      var r = await api('/api/fs/read?path=' + encodeURIComponent(path) + '&host=' + encodeURIComponent(S.hostId || 'local'));
      if (!r.ok) { toast(r.err || '打不开这个文件', true); return; }
      FS.cur = r.path;
      FS.mtime = r.mtime;
      FS.size = r.size;
      FS.mode = r.mode;
      FS.dirty = false;
      $('fs-editor').hidden = false;
      $('fs-ed-name').textContent = r.path;
      setMeta(r.size, r.mtime, r.mode);
      $('fs-text').value = r.content;
      setStatus('已打开 · ' + fmtSize(r.size) + ' · Ctrl+S 保存');
      try { $('fs-text').focus(); } catch (e) {}
    } catch (e) { toast('网络错误：' + ((e && e.message) || e), true); }
  }

  async function fsSave(force, fromBig) {
    if (!FS.cur) return;
    var txt = fromBig ? $('fs-text-big').value : $('fs-text').value;
    setStatus('保存中…');
    try {
      var body = { path: FS.cur, content: txt, host: S.hostId || 'local' };
      if (!force) body.mtime = FS.mtime;
      var r = await api('/api/fs/write', body);
      if (!r.ok) {
        if (r.conflict && !force) {
          if (window.confirm('这个文件已被别的程序改过了。\n要用当前内容覆盖吗？')) { await fsSave(true); return; }
          setStatus('已取消保存（文件内容未变）', true);
          return;
        }
        setStatus(r.err || '保存失败', true);
        toast(r.err || '保存失败', true);
        return;
      }
      FS.mtime = r.mtime;
      FS.dirty = false;
      setStatus('已保存 · ' + new Date().toLocaleTimeString() + (r.backup ? ' · 旧版备份在 ' + r.backup : ''));
      FS.size = txt.length;
      FS.mtime = r.mtime || Date.now();
      setMeta(FS.size, FS.mtime, FS.mode);
      $('fs-text').value = txt;                       // 内嵌预览始终跟保存内容一致
      if (fromBig) { $('fs-big-status').textContent = '已保存'; fsBigClose(true); }
      fsLoad(FS.dir, true);
    } catch (e) { setStatus('网络错误：' + ((e && e.message) || e), true); }
  }

  function fsNewFile() {
    askPrompt('新建文件', '在当前目录 ' + FS.dir + ' 下创建', 'untitled.txt', async function (name) {
      if (!name) return;
      var r = await api('/api/fs/create', { path: FS.dir + (FS.dir === '/' ? '' : '/') + name, host: S.hostId || 'local' });
      if (!r.ok) { toast(r.err || '创建失败', true); return; }
      fsLoad(FS.dir, true);
      fsOpen(r.path);
    });
  }

  function fsNewDir() {
    askPrompt('新建目录', '在当前目录 ' + FS.dir + ' 下创建', 'new-dir', async function (name) {
      if (!name) return;
      var r = await api('/api/fs/mkdir', { path: FS.dir + (FS.dir === '/' ? '' : '/') + name, host: S.hostId || 'local' });
      toast(r.ok ? '已创建目录' : (r.err || '创建失败'), !r.ok);
      if (r.ok) fsLoad(FS.dir, true);
    });
  }

  function fsRename(path, oldName) {
    askPrompt('重命名', '把「' + oldName + '」改成：', oldName, async function (name) {
      if (!name || name === oldName) return;
      var to = path.slice(0, path.length - oldName.length) + name;
      var r = await api('/api/fs/rename', { from: path, to: to, host: S.hostId || 'local' });
      toast(r.ok ? '已改名' : (r.err || '改名失败'), !r.ok);
      if (r.ok) {
        if (FS.cur === path) { FS.cur = to; $('fs-ed-name').textContent = to; }
        fsLoad(FS.dir, true);
      }
    });
  }

  function fsDelete(path, name) {
    askConfirm('删除确认', '删除后不可恢复。请输入文件名「' + name + '」确认：', async function (v) {
      if (v !== name) { toast('输入不匹配，已取消', true); return; }
      var r = await api('/api/fs/delete', { path: path, recursive: true, host: S.hostId || 'local' });
      toast(r.ok ? '已删除' : (r.err || '删除失败'), !r.ok);
      if (r.ok) {
        if (FS.cur === path) { FS.cur = null; FS.size = 0; FS.mode = ''; $('fs-editor').hidden = true; }
        fsLoad(FS.dir, true);
      }
    });
  }

  function fsUpload(files) {
    if (!files || !files.length) return;
    var arr = Array.prototype.slice.call(files);
    var i = 0;
    function next() {
      if (i >= arr.length) { toast('上传完成：' + arr.length + ' 个文件'); fsLoad(FS.dir, true); return; }
      var f = arr[i++];
      setStatus('上传 ' + i + '/' + arr.length + '：' + f.name + ' (' + fmtSize(f.size) + ')');
      fetch('/api/fs/upload?dir=' + encodeURIComponent(FS.dir) + '&name=' + encodeURIComponent(f.name) + '&host=' + encodeURIComponent(S.hostId || 'local'), {
        method: 'POST', body: f,
      }).then(function (r) { return r.json(); }).then(function (j) {
        if (!j.ok) toast(f.name + '：' + (j.err || '失败'), true);
        next();
      }).catch(function (e) { toast(f.name + '：' + ((e && e.message) || '失败'), true); next(); });
    }
    next();
  }

  /* 目录导航 */
  $('fs-go').addEventListener('click', function () { fsLoad($('fs-path').value.trim() || '/'); });
  $('fs-path').addEventListener('keydown', function (e) {
    if (e.key === 'Enter') { e.preventDefault(); fsLoad($('fs-path').value.trim() || '/'); }
  });
  $('fs-up').addEventListener('click', function () {
    var parts = FS.dir.split('/').filter(Boolean);
    parts.pop();
    fsLoad('/' + parts.join('/'));
  });
  $('fs-newfile').addEventListener('click', fsNewFile);
  $('fs-newdir').addEventListener('click', fsNewDir);
  $('fs-upload').addEventListener('click', function () { $('fs-input').click(); });
  $('fs-input').addEventListener('change', function (e) { fsUpload(e.target.files); e.target.value = ''; });

  /* 大卡片编辑（v8） */
  function fsExpand() {
    if (!FS.cur) return;
    $('fs-big-name').textContent = FS.cur;
    setMeta(FS.size, FS.mtime, FS.mode, 'fs-big');
    $('fs-text-big').value = $('fs-text').value;
    $('fs-big-status').textContent = 'Ctrl+S 保存 · Esc 关闭';
    $('fs-modal').hidden = false;
    setTimeout(function () { try { $('fs-text-big').focus(); } catch (e) {} }, 40);
  }

  function fsBigClose(force) {
    var modal = $('fs-modal');
    if (modal.hidden) return;
    if (!force && $('fs-text-big').value !== $('fs-text').value) {
      if (!window.confirm('大窗口里的修改还没保存，关闭会丢弃，确定吗？')) return;
    }
    modal.hidden = true;
  }

  /* 列表交互：点目录进入，点按钮做动作 */
  $('fs-list').addEventListener('click', function (ev) {
    var row = ev.target.closest ? ev.target.closest('.fs-row') : null;
    if (!row) return;
    var path = row.dataset.path, name = row.dataset.name, isDir = row.dataset.dir === '1';
    var btn = ev.target.closest ? ev.target.closest('button[data-act]') : null;
    if (btn) {
      var act = btn.dataset.act;
      if (act === 'edit') fsOpen(path);
      else if (act === 'dl') window.location.href = '/api/fs/download?path=' + encodeURIComponent(path) + '&host=' + encodeURIComponent(S.hostId || 'local');
      else if (act === 'ren') fsRename(path, name);
      else if (act === 'del') fsDelete(path, name);
      return;
    }
    if (isDir) fsLoad(path);
    else fsOpen(path);
  });

  /* 拖拽上传 */
  var fsPanel = document.querySelector('.files-panel');
  if (fsPanel) {
    var dragDepth = 0;
    fsPanel.addEventListener('dragenter', function (e) {
      if (!e.dataTransfer || !e.dataTransfer.types) return;
      if (Array.prototype.indexOf.call(e.dataTransfer.types, 'Files') < 0) return;
      dragDepth++;
      $('fs-drop').hidden = false;
    });
    fsPanel.addEventListener('dragover', function (e) { e.preventDefault(); });
    fsPanel.addEventListener('dragleave', function () {
      dragDepth = Math.max(0, dragDepth - 1);
      if (!dragDepth) $('fs-drop').hidden = true;
    });
    fsPanel.addEventListener('drop', function (e) {
      e.preventDefault();
      dragDepth = 0;
      $('fs-drop').hidden = true;
      if (e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files.length) fsUpload(e.dataTransfer.files);
    });
  }

  /* 编辑器交互 */
  $('fs-text').addEventListener('input', function () {
    FS.dirty = true;
    setStatus('未保存的修改 · Ctrl+S 保存');
  });
  $('fs-text').addEventListener('keydown', function (e) {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') { e.preventDefault(); fsSave(); return; }
    if (e.key === 'Tab') {
      e.preventDefault();
      var ta = e.target, st = ta.selectionStart, en = ta.selectionEnd;
      ta.value = ta.value.slice(0, st) + '  ' + ta.value.slice(en);
      ta.selectionStart = ta.selectionEnd = st + 2;
      FS.dirty = true;
    }
  });
  $('fs-save').addEventListener('click', function () { fsSave(); });
  $('fs-expand').addEventListener('click', fsExpand);
  $('fs-big-save').addEventListener('click', function () { fsSave(false, true); });
  $('fs-big-close').addEventListener('click', function () { fsBigClose(); });
  $('fs-modal').addEventListener('mousedown', function (e) { if (e.target === $('fs-modal')) fsBigClose(); });
  $('fs-text-big').addEventListener('input', function () {
    FS.dirty = true;
    $('fs-big-status').textContent = '未保存的修改 · Ctrl+S 保存';
  });
  $('fs-text-big').addEventListener('keydown', function (e) {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') { e.preventDefault(); fsSave(false, true); return; }
    if (e.key === 'Tab') {
      e.preventDefault();
      var ta = e.target, st = ta.selectionStart, en = ta.selectionEnd;
      ta.value = ta.value.slice(0, st) + '  ' + ta.value.slice(en);
      ta.selectionStart = ta.selectionEnd = st + 2;
      FS.dirty = true;
    }
  });
  $('fs-close').addEventListener('click', function () {
    if (FS.dirty && !window.confirm('还有未保存的修改，确定关闭吗？')) return;
    FS.dirty = false;
    FS.cur = null;
    $('fs-editor').hidden = true;
  });

  window.addEventListener('beforeunload', function (e) {
    if (FS.dirty) { e.preventDefault(); e.returnValue = ''; }
  });

  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape') {
      fsBigClose();
      $('log-modal').hidden = true;
      $('confirm-modal').hidden = true;
      S.confirmCb = null;
    }
  });

  /* ---------------- 主题绑定 ---------------- */
  ['btn-theme', 'btn-theme-login'].forEach((id) => {
    const b = $(id);
    if (b) b.addEventListener('click', toggleTheme);
  });
  applyTheme(currentTheme());

  /* ---------------- 启动 ---------------- */
  (async function boot() {
    let ok = false;
    try {
      ok = await ping();
    } catch (e) {
      $('lg-err').textContent = '连不上后端：' + ((e && e.message) || '网络错误');
    }
    if (ok) enterApp();
    else $('lg-pass').focus();
    setInterval(() => {
      $('h-clock').textContent = new Date().toLocaleTimeString('zh-CN', { hour12: false });
    }, 1000);
    window.addEventListener('resize', () => {
      S.hist.cpu.length && spark($('c-cpu-spark'), S.hist.cpu, 100);
    });
  })();
/* ---------------- 服务器列表（v14） ---------------- */
S.hostId = 'local';
S.hosts = [];
S.remoteTimer = 0;

function stopRemote() {
  if (S.remoteTimer) { clearInterval(S.remoteTimer); S.remoteTimer = 0; }
}

function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) {
    return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c];
  });
}

function srvRowHtml(h) {
  const mem = h.mem || {};
  const disk = h.disk || {};
  const memPct = mem.total ? Math.round((mem.used / mem.total) * 100) : 0;
  const diskPct = Math.round(Number(disk.pct) || 0);
  const ok = h.ok !== false;
  const kind = h.kind === 'local' ? '本机' : 'SSH';
  const addr = h.host + (h.port ? ':' + h.port : '');
  const del = h.kind === 'local'
    ? ''
    : '<button class="ico-btn sc-del" data-del="' + h.id + '" data-tip="移除" aria-label="移除">' +
      '<svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><path d="M3 4.5h10M6.4 4.5V3h3.2v1.5M5 4.5l.6 8.5h4.8l.6-8.5"/></svg>' +
      '</button>';

  if (!ok) {
    return '<article class="srv-row is-bad" data-id="' + h.id + '" tabindex="0" role="button">' +
      '<div class="sr-name"><i class="sc-dot off"></i><b>' + esc(h.name || addr) + '</b><em>' + kind + '</em></div>' +
      '<div class="sr-addr">' + esc(addr) + (h.kind === 'local' ? '' : ' · ' + esc(h.user || 'root')) + '</div>' +
      '<div class="sr-err" title="' + esc(h.err || '连接失败') + '">' + esc(h.err || '连接失败') + '</div>' +
      '<div class="sr-act">' + del + '</div>' +
      '</article>';
  }
  return '<article class="srv-row" data-id="' + h.id + '" tabindex="0" role="button">' +
    '<div class="sr-name"><i class="sc-dot"></i><b>' + esc(h.name || addr) + '</b><em>' + kind + '</em></div>' +
    '<div class="sr-addr">' + esc(addr) + (h.kind === 'local' ? '' : ' · ' + esc(h.user || 'root')) + '</div>' +
    '<div class="sr-metric"><b>' + memPct + '%</b><i class="sc-bar"><u style="width:' + Math.min(100, memPct) + '%"></u></i></div>' +
    '<div class="sr-metric"><b>' + diskPct + '%</b><i class="sc-bar"><u style="width:' + Math.min(100, diskPct) + '%"></u></i></div>' +
    '<div class="sr-act">' + del + '</div>' +
    '</article>';
}

async function loadHosts() {
  const box = $('srv-list');
  if (!box) return;
  if (!box.children.length) box.innerHTML = '<article class="srv-row is-ghost">正在读取服务器…</article>';
  try {
    const r = await api('/api/hosts');
    S.hosts = r.hosts || [];
    box.innerHTML = S.hosts.map(srvRowHtml).join('') ||
      '<article class="srv-row is-ghost">还没有服务器，点右上角「添加服务器」</article>';
  } catch (e) {
    box.innerHTML = '<article class="srv-row is-ghost">读取失败：' + esc(e.message) + '</article>';
  }
}

function showServers() {
  stopRemote();
  S.hostId = 'local';
  $('srv-view').hidden = false;
  $('dash-view').hidden = true;
  $('btn-back').hidden = true;
  $('h-host').textContent = '服务器列表';
  $('h-os').textContent = '';
  $('h-uptime').textContent = '—';
  $('h-load').textContent = '—';
  loadHosts();
}

function openHost(id) {
  const list = S.hosts || [];
  let h = null;
  for (let i = 0; i < list.length; i++) if (list[i].id === id) h = list[i];
  S.hostId = id;
  $('srv-view').hidden = true;
  $('dash-view').hidden = false;
  $('btn-back').hidden = false;
  const remote = !!(h && h.kind === 'ssh');
  $('dash-view').setAttribute('data-remote', remote ? '1' : '0');
  $('h-host').textContent = h ? h.name : id;
  $('h-os').textContent = h ? (h.host + (h.port ? ':' + h.port : '')) : '';
  if (remote) {
    startRemote(id);
  } else {
    stopRemote();
    fsLoad('/', true);
  }
}

function startRemote(id) {
  stopRemote();
  const tick = function () {
    api('/api/state?host=' + encodeURIComponent(id)).then(function (d) {
      if (S.hostId === id) render(d);
    }).catch(function (e) {
      toast('远程状态读取失败：' + e.message, true);
    });
  };
  tick();
  S.remoteTimer = setInterval(tick, 3000);
}

/* ---------------- 添加服务器 ---------------- */
function authSync() {
  const isKey = $('hm-auth').value === 'key';
  $('hm-pass-wrap').hidden = isKey;
  $('hm-key-wrap').hidden = !isKey;
}

function openHostModal() {
  $('hm-err').textContent = '';
  $('hm-name').value = '';
  $('hm-host').value = '';
  $('hm-port').value = '22';
  $('hm-user').value = 'root';
  $('hm-pass').value = '';
  $('hm-key').value = '';
  $('hm-auth').value = 'password';
  authSync();
  $('host-modal').hidden = false;
  setTimeout(function () { $('hm-name').focus(); }, 30);
}

function closeHostModal() { $('host-modal').hidden = true; }

async function submitHost() {
  const btn = $('hm-ok');
  const body = {
    name: $('hm-name').value.trim(),
    host: $('hm-host').value.trim(),
    port: Number($('hm-port').value || 22),
    user: $('hm-user').value.trim(),
    authType: $('hm-auth').value,
    password: $('hm-pass').value,
    keyPath: $('hm-key').value.trim(),
  };
  if (!body.name || !body.host) { $('hm-err').textContent = '名称和地址都要填'; return; }
  btn.disabled = true;
  const old = btn.textContent;
  btn.textContent = '连接中…';
  try {
    await api('/api/hosts/add', body);
    closeHostModal();
    toast('已添加「' + body.name + '」');
    loadHosts();
  } catch (e) {
    $('hm-err').textContent = e.message;
  } finally {
    btn.disabled = false;
    btn.textContent = old;
  }
}

function delHost(id) {
  const list = S.hosts || [];
  let h = null;
  for (let i = 0; i < list.length; i++) if (list[i].id === id) h = list[i];
  askConfirm('移除服务器',
    '从列表里移除「' + (h ? h.name : id) + '」？只删除面板里的连接记录，不会影响那台服务器。',
    async function () {
      try {
        await api('/api/hosts/delete', { id: id });
        toast('已移除');
        loadHosts();
      } catch (e) {
        toast(e.message, true);
      }
    }, true);
}

$('btn-back').addEventListener('click', showServers);
$('btn-add-host').addEventListener('click', openHostModal);
$('hm-cancel').addEventListener('click', closeHostModal);
$('hm-close-x').addEventListener('click', closeHostModal);
$('hm-auth').addEventListener('change', authSync);
$('hm-ok').addEventListener('click', submitHost);
$('host-modal').addEventListener('click', function (ev) {
  if (ev.target === $('host-modal')) closeHostModal();
});
$('srv-list').addEventListener('click', function (ev) {
  const del = ev.target.closest('[data-del]');
  if (del) { ev.stopPropagation(); delHost(del.getAttribute('data-del')); return; }
  const card = ev.target.closest('.srv-row[data-id]');
  if (card) openHost(card.getAttribute('data-id'));
});
$('srv-list').addEventListener('keydown', function (ev) {
  if (ev.key !== 'Enter') return;
  const card = ev.target.closest('.srv-row[data-id]');
  if (card) openHost(card.getAttribute('data-id'));
});

})();
