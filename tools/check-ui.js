// 没有浏览器的环境下，用最小 DOM 打桩把 web/app.js 真跑一遍：
// 登录 → 收 state → 渲染 → 筛选服务 → 发命令 → 断线提示。
// 目的不是测样式，而是保证重构后没有运行时异常、关键 DOM 状态正确。
const fs = require('fs');
const vm = require('vm');
const path = require('path');

const WEB = path.join(__dirname, '..', 'web');
const html = fs.readFileSync(path.join(WEB, 'index.html'), 'utf8');

/* ---------- 从 index.html 里抽出所有 id，保证打桩元素和真实页面一致 ---------- */
const ids = new Set();
for (const m of html.matchAll(/\sid="([^"]+)"/g)) ids.add(m[1]);

/* ---------- 极简元素 ---------- */
function el(id) {
  const handlers = {};
  const e = {
    id,
    hidden: false,
    textContent: '',
    _html: '',
    value: '',
    className: '',
    checked: false,
    style: {},
    dataset: {},
    children: [],
    _attrs: {},
    getAttribute(k) { return k in this._attrs ? this._attrs[k] : null; },
    setAttribute(k, v) { this._attrs[k] = String(v); },
    removeAttribute(k) { delete this._attrs[k]; },
    width: 0,
    height: 0,
    clientWidth: 300,
    clientHeight: 44,
    scrollTop: 0,
    scrollHeight: 100,
    classList: {
      _s: new Set(),
      add(c) { this._s.add(c); },
      remove(c) { this._s.delete(c); },
      toggle(c, on) { on ? this._s.add(c) : this._s.delete(c); },
      contains(c) { return this._s.has(c); },
    },
    addEventListener(t, fn) { (handlers[t] = handlers[t] || []).push(fn); },
    removeEventListener() {},
    dispatch(t, ev) { (handlers[t] || []).forEach((f) => f(ev || { preventDefault() {}, target: e })); },
    _handlers: handlers,
    appendChild(c) { e.children.push(c); e.innerHTML += c.innerHTML || c.textContent || ''; return c; },
    querySelector(sel) {
      if (id === 'proc-table' && sel === 'tbody') return tbodies['proc-table'];
      return null;
    },
    querySelectorAll() { return []; },
    setSelectionRange() {},
    select() {},
    focus() {},
    getContext() {
      return new Proxy({}, {
        get(t, k) {
          if (k === 'createLinearGradient') return () => ({ addColorStop() {} });
          if (k === 'canvas') return e;
          return typeof k === 'string' ? () => {} : undefined;
        },
        set() { return true; },
      });
    },
    getBoundingClientRect() { return { width: 300, height: 44, top: 0, left: 0 }; },
  };
  Object.defineProperty(e, 'innerHTML', {
    get() { return e._html; },
    set(v) { e._html = String(v); },
  });
  return e;
}

const els = {};
for (const id of ids) els[id] = el(id);
const tbodies = { 'proc-table': el('proc-table-tbody') };

/* 快捷命令按钮（document.querySelectorAll('.chip[data-cmd]')） */
const chips = ['uptime', 'df -h'].map((cmd) => {
  const b = el('chip-' + cmd);
  b.dataset.cmd = cmd;
  return b;
});

/* ---------- document / window ---------- */
const metaNodes = {};
const dHandlers = {};
const document = {
  getElementById: (id) => els[id] || (els[id] = el(id)),
  querySelectorAll: (sel) => (sel === '.chip[data-cmd]' ? chips : []),
  querySelector: (sel) => {
    if (sel.startsWith('meta[')) {
      if (!metaNodes[sel]) metaNodes[sel] = { attrs: {}, setAttribute(k, v) { this.attrs[k] = v; } };
      return metaNodes[sel];
    }
    return null;
  },
  createElement: (tag) => el('created-' + tag),
  addEventListener(t, fn) { (dHandlers[t] = dHandlers[t] || []).push(fn); },
  dispatch(t, ev) { (dHandlers[t] || []).forEach((f) => f(ev || {})); },
  body: el('body'),
  documentElement: {
    _a: {},
    getAttribute(k) { return k in this._a ? this._a[k] : null; },
    setAttribute(k, v) { this._a[k] = v; },
  },
};

const getComputedStyle = () => ({ getPropertyValue: () => '' });

const store = {};
const localStorage = {
  getItem: (k) => (k in store ? store[k] : null),
  setItem: (k, v) => { store[k] = String(v); },
  removeItem: (k) => { delete store[k]; },
};

let wsInst = null;
class WebSocketStub {
  constructor(url) { this.url = url; this.readyState = 1; wsInst = this; }
  send(payload) { this.sent = this.sent || []; this.sent.push(payload); }
  close() { this.readyState = 3; if (this.onclose) this.onclose(); }
}

const calls = [];
async function fetchStub(url, opt) {
  calls.push({ url, opt });
  if (url === '/api/ping') return { status: 200, json: async () => ({ ok: true, auth: false, host: 'test-host' }) };
  if (url === '/api/login') return { status: 200, json: async () => ({ ok: true, user: 'admin' }) };
  if (url.startsWith('/api/hosts')) {
    // v14：登录后先拿服务器列表（本机 + 一台连不上的远程机）
    return {
      status: 200, json: async () => ({
        ok: true,
        hosts: [
          {
            id: 'local', kind: 'local', name: 'local-box', host: '10.0.0.5', port: 0, user: 'root',
            ok: true, cores: 2, uptime: 93784, load: [0.1, 0.2, 0.3],
            mem: { total: 8e8, used: 4e8, avail: 4e8 }, disk: { total: 3e10, used: 5.4e9, pct: 18, mount: '/' },
          },
          {
            id: 'hremote1', kind: 'ssh', name: 'remote-box', host: '10.0.0.9', port: 22, user: 'root',
            ok: false, err: '认证失败（账号或密码错误）',
          },
        ],
      }),
    };
  }
  if (url.startsWith('/api/fs/list')) {
    return {
      status: 200, json: async () => ({
        ok: true, dir: '/var/www', parent: '/var',
        count: 3,
        entries: [
          { name: 'site', path: '/var/www/site', dir: true, size: 0, mtime: Date.now(), mode: 'drwxr-xr-x', link: null, hidden: false },
          { name: 'index.html', path: '/var/www/index.html', dir: false, size: 2048, mtime: Date.now(), mode: '-rw-r--r--', link: null, hidden: false },
          { name: '.env', path: '/var/www/.env', dir: false, size: 12, mtime: Date.now(), mode: '-rw-------', link: null, hidden: true },
        ],
      }),
    };
  }
  if (url.startsWith('/api/fs/read')) {
    return {
      status: 200, json: async () => ({
        ok: true, path: '/var/www/nginx.conf', size: 32, mtime: 1700000000000, mode: '-rw-r--r--',
        content: 'server {\n  listen 80;\n}\n',
      }),
    };
  }
  if (url.startsWith('/api/fs/write')) {
    const body = opt && opt.body ? JSON.parse(opt.body) : {};
    lastWrite = body;
    return { status: 200, json: async () => ({ ok: true, path: body.path, size: (body.content || '').length, mtime: 1700000009999, backup: '/var/backups/server-panel/x' }) };
  }
  if (url.startsWith('/api/fs/rename')) {
    lastRename = opt && opt.body ? JSON.parse(opt.body) : null;
    return { status: 200, json: async () => ({ ok: true }) };
  }
  if (url.startsWith('/api/proc/kill')) {
    lastKill = opt && opt.body ? JSON.parse(opt.body) : null;
    return { status: 200, json: async () => ({ ok: true, pid: lastKill && lastKill.pid, signal: 'SIGTERM' }) };
  }
  return { status: 200, json: async () => ({ ok: true }) };
}
let lastWrite = null;
let lastRename = null;
let lastKill = null;

const win = {
  devicePixelRatio: 2,
  innerWidth: 1440,
  innerHeight: 900,
  addEventListener() {},
  requestAnimationFrame: (fn) => setTimeout(fn, 0),
  localStorage,
  location: { protocol: 'http:', host: 'test-host' },
  WebSocket: WebSocketStub,
  fetch: fetchStub,
  setTimeout,
  clearTimeout,
  setInterval: () => 0,
  clearInterval: () => {},
  console,
};

const ctx = vm.createContext({
  window: win,
  document,
  localStorage,
  location: win.location,
  WebSocket: WebSocketStub,
  fetch: fetchStub,
  setTimeout,
  clearTimeout,
  setInterval: () => 0,
  clearInterval: () => {},
  requestAnimationFrame: win.requestAnimationFrame,
  getComputedStyle,
  console,
  JSON,
  Math,
  Date,
  String,
  Number,
  Object,
  Array,
  Promise,
});

/* ---------- 真正执行 app.js ---------- */
const src = fs.readFileSync(path.join(WEB, 'app.js'), 'utf8');
vm.runInContext(src, ctx, { filename: 'app.js' });

/* ---------- 断言 ---------- */
const fails = [];
const ok = (cond, msg) => { if (!cond) fails.push(msg); };

(async function run() {
  // 1) 登录：触发 submit
  els['lg-pass'].value = 'secret';
  els['lg-user'].value = 'admin';
  els['login-form'].dispatch('submit', { preventDefault() {}, target: els['login-form'] });
  await new Promise((r) => setTimeout(r, 30));
  ok(els['app'].hidden === false, '登录后 #app 应可见');
  ok(els['login-wrap'].hidden === true, '登录后登录层应隐藏');
  ok(!!wsInst, '登录后应建立 WebSocket');
  ok(calls.some((c) => c.url === '/api/login'), '应调用 /api/login');

  // 1.5) v14：先进服务器列表
  await new Promise((r) => setTimeout(r, 40));
  ok(calls.some((c) => c.url === '/api/hosts'), '登录后应拉取 /api/hosts');
  ok(els['srv-view'].hidden === false, '登录后应先显示服务器列表');
  ok(els['dash-view'].hidden === true, '登录后监控页应隐藏');
  ok(els['srv-list'].innerHTML.includes('local-box'), '服务器列表应渲染本机');
  ok(els['srv-list'].innerHTML.includes('remote-box'), '服务器列表应渲染远程机');
  ok(els['srv-list'].innerHTML.includes('18%'), '卡片应显示硬盘占用 18%');
  ok(els['srv-list'].innerHTML.includes('50%'), '卡片应显示内存占用 50%');
  ok(els['srv-list'].innerHTML.includes('认证失败'), '连不上的远程机应显示错误原因');
  ok(els['btn-back'].hidden === true, '列表页不应显示返回按钮');

  // 1.6) 点「本机」进入监控页
  const localCard = { dataset: { id: 'local' }, getAttribute: () => 'local' };
  els['srv-list'].dispatch('click', {
    target: { closest: (sel) => (sel === '.srv-row[data-id]' ? localCard : null) },
  });
  await new Promise((r) => setTimeout(r, 40));
  ok(els['srv-view'].hidden === true, '进入监控页后列表应隐藏');
  ok(els['dash-view'].hidden === false, '进入监控页后应显示监控内容');
  ok(els['btn-back'].hidden === false, '进入监控页后应出现返回按钮');
  ok(els['dash-view'].getAttribute('data-remote') === '0', '本机不应被标记为远程');

  // 2) 收一条 state
  const state = {
    t: Date.now(),
    load: [0.1, 0.2, 0.3],
    host: {
      hostname: 'test-host', platform: 'linux', release: '4.18', arch: 'x64',
      uptime: 93784, cores: 2, model: 'Intel Xeon', node: 'v20.20.2',
    },
    cpu: { pct: 12.5, cores: [10, 15] },
    mem: { total: 8e8, used: 4e8, avail: 4e8, swapTotal: 2e9, swapUsed: 1e8 },
    net: { rate: { rx: 2048, tx: 512 }, total: { rx: 1e8, tx: 5e7 } },
    disk: [{ mount: '/', size: 3e10, used: 5e9, pct: 18 }],
    procs: [{ pid: 1, name: 'systemd', cpu: 0.1, mem: 0.4, rss: 1e7 }],
    services: [
      { unit: 'nginx.service', active: 'active', sub: 'running', desc: 'The nginx HTTP server' },
      { unit: 'sshd.service', active: 'active', sub: 'running', desc: 'OpenSSH server' },
      { unit: 'cron.service', active: 'inactive', sub: 'dead', desc: 'snake' },
    ],
  };
  wsInst.onopen && wsInst.onopen();
  wsInst.onmessage({ data: JSON.stringify({ t: 'state', data: state }) });

  ok(els['c-cpu'].textContent === '12.5%', 'CPU 数值应渲染成 12.5%，实际 ' + els['c-cpu'].textContent);
  ok(els['c-mem'].textContent === '50%', '内存百分比应为 50%，实际 ' + els['c-mem'].textContent);
  ok(els['h-host'].textContent === 'test-host', '主机名应写入顶栏');
  ok(String(els['svc-count'].textContent) === '3', '服务总数应为 3，实际 ' + els['svc-count'].textContent);
  ok(els['svc-list'].innerHTML.includes('nginx.service'), '服务列表应包含 nginx');
  ok(els['svc-list'].innerHTML.includes('data-u="nginx.service"'), '服务行应带操作按钮');
  ok(tbodies['proc-table'].innerHTML.includes('systemd'), '进程表应渲染进程名');

  // 3) 筛选
  els['svc-filter'].value = 'ssh';
  els['svc-filter'].dispatch('input', { target: els['svc-filter'] });
  ok(els['svc-list'].innerHTML.includes('sshd.service'), '筛选 ssh 应保留 sshd');
  ok(!els['svc-list'].innerHTML.includes('nginx.service'), '筛选 ssh 应隐藏 nginx');
  ok(String(els['svc-count'].textContent) === '1 / 3', '筛选后计数应为 1 / 3，实际 ' + els['svc-count'].textContent);

  // 4) 文件列表
  await new Promise((r) => setTimeout(r, 40));
  ok(els['fs-list'].innerHTML.includes('index.html'), '文件列表应渲染出 index.html');
  ok(els['fs-list'].children.some((c) => String(c.className).includes('is-dir')), '目录行应带 is-dir 类');
  ok(els['fs-hint'].textContent.includes('3'), '表头应显示 3 项，实际 ' + els['fs-hint'].textContent);

  // 5) 打开文件 → 编辑器出现、内容正确
  const fileRow = { dataset: { path: '/var/www/nginx.conf', name: 'nginx.conf', dir: '0' } };
  els['fs-list'].dispatch('click', {
    target: { closest: (sel) => (sel === '.fs-row' ? fileRow : null) },
  });
  await new Promise((r) => setTimeout(r, 40));
  ok(els['fs-editor'].hidden === false, '打开文本文件后编辑器应显示');
  ok(els['fs-text'].value.includes('listen 80'), '编辑器应载入文件内容');
  ok(els['fs-ed-name'].textContent === '/var/www/nginx.conf', '编辑器标题应为文件路径');

  // 6) 编辑 + 保存
  els['fs-text'].value = 'server {\n  listen 8080;\n}\n';
  els['fs-text'].dispatch('input', { target: els['fs-text'] });
  els['fs-save'].dispatch('click');
  await new Promise((r) => setTimeout(r, 60));
  ok(lastWrite && lastWrite.path === '/var/www/nginx.conf', '保存应 POST 到 /api/fs/write');
  ok(lastWrite && lastWrite.content.includes('8080'), '保存内容应为编辑后的文本');
  ok(lastWrite && lastWrite.mtime === 1700000000000, '保存应带上原始 mtime 用于冲突检测');

  // 6.3) 编辑器三栏元信息
  ok(/B|K|M|G/.test(els['fs-ed-size'].textContent), '编辑器应显示大小：' + els['fs-ed-size'].textContent);
  ok(/\d{2}-\d{2} \d{2}:\d{2}/.test(els['fs-ed-time'].textContent), '编辑器应显示修改时间：' + els['fs-ed-time'].textContent);
  ok(/-rw-/.test(els['fs-ed-mode'].textContent), '权限应为符号位（如 -rw-r--r--）：' + els['fs-ed-mode'].textContent);

  // 6.4) 图标按钮：有 data-tip、无文字标签
  const rowHtml = els['fs-list'].innerHTML;
  ok(/class="ico-btn[^"]*"[^>]*data-tip="下载"/.test(rowHtml), '行动作按钮应为带 data-tip 的图标按钮');
  ok(!rowHtml.includes('>编辑<'), '动作按钮不应再出现文字标签');
  ok(!/data-act="edit"/.test(rowHtml), '文件行不应再有「编辑」按钮（点行即打开）');
  ok((rowHtml.match(/ico-btn/g) || []).length >= 3, '每行至少 3 个图标按钮（下载/重命名/删除）');

  // 6.5) 展开为大卡片 → 内容一致
  els['fs-expand'].dispatch('click');
  await new Promise((r) => setTimeout(r, 60));
  ok(els['fs-modal'].hidden === false, '点放大后大卡片应显示');
  ok(els['fs-big-name'].textContent === '/var/www/nginx.conf', '大卡片标题应是文件路径');
  ok(els['fs-text-big'].value.includes('8080'), '大卡片应带着当前编辑内容');

  // 6.6) 在大卡片里改并保存 → 弹窗关闭、内嵌预览同步
  lastWrite = null;
  els['fs-text-big'].value = 'server {\n  listen 9090;\n}\n';
  els['fs-text-big'].dispatch('input', { target: els['fs-text-big'] });
  els['fs-big-save'].dispatch('click');
  await new Promise((r) => setTimeout(r, 80));
  ok(lastWrite && lastWrite.content.includes('9090'), '大卡片保存应提交新内容');
  ok(els['fs-modal'].hidden === true, '保存后大卡片应关闭');
  ok(els['fs-text'].value.includes('9090'), '内嵌预览应同步成保存后的内容');

  // 6.7) Esc 关闭大卡片
  els['fs-expand'].dispatch('click');
  await new Promise((r) => setTimeout(r, 50));
  ok(els['fs-modal'].hidden === false, '再次展开应显示');
  document.dispatch('keydown', { key: 'Escape' });
  ok(els['fs-modal'].hidden === true, 'Esc 应关闭大卡片');

  // 6.9) v13：网络图例用色块，不再用「琥珀/绿」文字描述颜色
  const netInfo = els['c-net-info'].innerHTML;
  ok(netInfo.includes('sw-a') && netInfo.includes('sw-b'), '网络图例应有 sw-a / sw-b 两个色块');
  ok(!/琥珀/.test(netInfo), '图例不应再用「琥珀」文字描述颜色：' + netInfo);

  // 7) 断线提示
  wsInst.onclose && wsInst.onclose();
  ok(els['conn'].hidden === false, '断线后应显示提示条');

  // 8) 服务按钮点击（模拟事件冒泡到 #svc-list）
  const btn = {
    dataset: { u: 'nginx.service', a: 'restart' },
    disabled: false,
    closest: () => btn,
  };
  els['svc-list'].dispatch('click', { target: { closest: () => btn } });
  await new Promise((r) => setTimeout(r, 30));

  // 9) 主题切换：暗 → 亮 → 暗
  const root = document.documentElement;
  ok(root.getAttribute('data-theme') === 'dark', '默认主题应为 dark，实际 ' + root.getAttribute('data-theme'));
  ok(els['btn-theme'].getAttribute('aria-checked') === 'false', '暗色下 aria-checked 应为 false');
  ok(els['btn-theme-login'].hidden === true, '登录后角落开关应隐藏');

  els['btn-theme'].dispatch('click');
  ok(root.getAttribute('data-theme') === 'light', '点击后应切到 light，实际 ' + root.getAttribute('data-theme'));
  ok(localStorage.getItem('sp.theme') === 'light', '应把 sp.theme 存为 light');
  ok(els['btn-theme'].getAttribute('aria-checked') === 'true', '亮色下 aria-checked 应为 true');
  ok(els['btn-theme'].title === '切换到夜晚', '亮色下 title 应提示切到夜晚，实际 ' + els['btn-theme'].title);

  els['btn-theme-login'].dispatch('click');
  ok(root.getAttribute('data-theme') === 'dark', '再次点击应切回 dark，实际 ' + root.getAttribute('data-theme'));
  ok(localStorage.getItem('sp.theme') === 'dark', '应把 sp.theme 存为 dark');

  // 10) v10：进程结束 —— 确认小卡片（无输入框）→ /api/proc/kill
  ok(tbodies['proc-table'].innerHTML.includes('data-act="kill"'), '进程行应渲染「结束进程」图标按钮');
  const procRow = { dataset: { pid: '4242', name: 'nginx' } };
  const killBtn = {
    dataset: { act: 'kill' },
    _attrs: { 'data-tip': '结束进程' },
    getAttribute(k) { return k in this._attrs ? this._attrs[k] : null; },
  };
  killBtn.closest = (sel) => (sel === '.ico-btn[data-act="kill"]' ? killBtn : sel === 'tr' ? procRow : null);
  els['proc-table'].dispatch('click', { target: killBtn });
  ok(els['confirm-modal'].hidden === false, '点结束进程应弹出确认小卡片');
  ok(els['cf-input'].hidden === true, '结束进程的确认卡片不应显示输入框');
  ok(String(els['cf-text'].textContent).includes('4242'), '确认卡片应带 PID：' + els['cf-text'].textContent);
  els['cf-ok'].dispatch('click');
  await new Promise((r) => setTimeout(r, 40));
  ok(lastKill && lastKill.pid === 4242 && lastKill.name === 'nginx', '确认后应 POST /api/proc/kill {pid:4242,name:nginx}');

  // 11) v10：重命名改用输入小卡片（不再 window.prompt）
  const renRow = { dataset: { path: '/var/www/nginx.conf', name: 'nginx.conf', dir: '0' } };
  const renBtn = { dataset: { act: 'ren' } };
  renBtn.closest = (sel) => (sel === '.fs-row' ? renRow : sel === 'button[data-act]' ? renBtn : null);
  els['fs-list'].dispatch('click', { target: renBtn });
  ok(els['prompt-modal'].hidden === false, '点重命名应弹出输入小卡片');
  ok(els['pm-input'].value === 'nginx.conf', '小卡片应预填原名，实际 ' + els['pm-input'].value);
  ok(String(els['pm-title'].textContent).includes('重命名'), '小卡片标题应为重命名');
  els['pm-input'].value = 'nginx2.conf';
  els['pm-ok'].dispatch('click');
  await new Promise((r) => setTimeout(r, 50));
  ok(lastRename && lastRename.from === '/var/www/nginx.conf', '应 POST /api/fs/rename，from 正确');
  ok(lastRename && lastRename.to === '/var/www/nginx2.conf', 'rename 目标应是新名字，实际 ' + (lastRename && lastRename.to));
  ok(els['prompt-modal'].hidden === true, '确定后小卡片应关闭');

  // 12) 代码层面：不应再使用 window.prompt
  ok(!/window\.prompt\s*\(/.test(src), 'app.js 不应再使用 window.prompt');

  // 13) v11：悬停提示走全局 fixed 浮层（避免被表格 overflow 裁切）
  const tipHost = { closest: (sel) => (sel === '[data-tip]' ? killBtn : null) };
  document.dispatch('mouseover', { target: tipHost });
  ok(els['tip'].hidden === false, '悬停应显示 #tip 浮层');
  ok(els['tip'].textContent === '结束进程', '#tip 文案应取 data-tip，实际 ' + els['tip'].textContent);
  ok(/^\d+px$/.test(String(els['tip'].style.left)), '#tip 应有 left 定位，实际 ' + els['tip'].style.left);
  ok(/^\d+px$/.test(String(els['tip'].style.top)), '#tip 应有 top 定位，实际 ' + els['tip'].style.top);
  ok(els['tip'].classList.contains('on'), '#tip 应带 .on 类');
  document.dispatch('mouseout', { target: tipHost });
  ok(els['tip'].hidden === true, '移出后 #tip 应隐藏');
  ok(!/\.ico-btn\[data-tip\]::after\s*\{[^}]*content:\s*attr/.test(fs.readFileSync(path.join(WEB, 'style.css'), 'utf8')),
    'CSS 不应再用 ::after 画提示（会被 overflow 裁切）');

  // 13.1) v12：浮层必须惰性获取，不能在脚本顶层直接 $('tip')
  //       （节点若排在 <script> 之后，顶层取到的是 null，所有 hover 提示都会失效）
  ok(/function tipNode\(\)/.test(src), 'app.js 应惰性获取 #tip 节点');
  ok(!/var tipEl = \$\('tip'\);/.test(src), 'app.js 不应在顶层直接取 #tip（时序脆弱）');

  console.log(fails.length ? '[ui] FAIL ❌\n  - ' + fails.join('\n  - ') : '[ui] PASS ✅（登录/渲染/筛选/文件列表/打开/保存/大卡片/断线/主题/结束进程/输入小卡片 全部通过）');
  process.exit(fails.length ? 1 : 0);
})();
