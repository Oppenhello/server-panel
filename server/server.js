'use strict';
/* 服务器监控 / 控制面板 —— 单文件后端（Node + ws，无其它依赖） */

const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { execFile } = require('child_process');
const remoteFs = require('./remote');
const WebSocket = require('ws');

/* ---------------- 配置 ---------------- */
const ENV_FILE = process.env.PANEL_ENV || '/etc/server-panel.env';
const env = {};
try {
  fs.readFileSync(ENV_FILE, 'utf8').split('\n').forEach((line) => {
    const m = line.match(/^\s*([A-Z_]+)\s*=\s*(.*)\s*$/);
    if (m) env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  });
} catch (e) { /* 没有配置文件就用环境变量 */ }

const CONF = {
  port: Number(process.env.PANEL_PORT || env.PANEL_PORT || 3100),
  host: process.env.PANEL_HOST || env.PANEL_HOST || '127.0.0.1',
  user: process.env.PANEL_USER || env.PANEL_USER || 'admin',
  pass: process.env.PANEL_PASS || env.PANEL_PASS || '',
  webDir: process.env.PANEL_WEB || env.PANEL_WEB || path.join(__dirname, '..', 'web'),
  sessionTtl: 12 * 3600 * 1000,
  maxExecMs: 60 * 1000,
  maxExecBytes: 128 * 1024,
  watch: (process.env.PANEL_WATCH || env.PANEL_WATCH || 'nginx.service,sshd.service,server-panel.service')
    .split(',').map((s) => s.trim()).filter(Boolean),
};

if (!CONF.pass) {
  console.error('[panel] 没有设置 PANEL_PASS（/etc/server-panel.env），拒绝启动');
  process.exit(1);
}

/* ---------------- 会话 ---------------- */
const sessions = new Map();          // token -> {ip, exp}
const loginFails = new Map();        // ip -> {n, until}

function newSession(ip) {
  const token = crypto.randomBytes(24).toString('hex');
  sessions.set(token, { ip, exp: Date.now() + CONF.sessionTtl });
  return token;
}
function sessionOf(req) {
  const raw = req.headers.cookie || '';
  const m = raw.match(/(?:^|;\s*)sp_sess=([a-f0-9]+)/);
  if (!m) return null;
  const s = sessions.get(m[1]);
  if (!s) return null;
  if (s.exp < Date.now()) { sessions.delete(m[1]); return null; }
  return m[1];
}
function safeEqual(a, b) {
  const ab = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ab.length !== bb.length) return false;
  return crypto.timingSafeEqual(ab, bb);
}

/* ---------------- HTTP 小工具 ---------------- */
function json(res, code, obj) {
  const body = Buffer.from(JSON.stringify(obj));
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': body.length,
    'Cache-Control': 'no-store',
  });
  res.end(body);
}
/* 收集原始二进制 body（远程上传用） */
function readRawBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > (limit || 8 * 1024 * 1024)) { reject(new Error('上传内容超过限制')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function readBody(req, limit = 256 * 1024) {
  return new Promise((resolve, reject) => {
    let n = 0;
    const chunks = [];
    req.on('data', (c) => {
      n += c.length;
      if (n > limit) { reject(new Error('body too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      const s = Buffer.concat(chunks).toString('utf8');
      if (!s) return resolve({});
      try { resolve(JSON.parse(s)); } catch (e) { reject(new Error('bad json')); }
    });
    req.on('error', reject);
  });
}

/* ---------------- 采集 ---------------- */
let cpuPrev = readCpu(); // 启动时先采一次，首个快照就有 CPU 数值
function readCpu() {
  if (!fs.existsSync('/proc/stat')) {
    // 非 Linux（本地调试）：用 os.cpus() 的累计时间拼一份同样结构的数据
    const out = [{ idx: -1, idle: 0, total: 0 }];
    os.cpus().forEach((c, i) => {
      const t = c.times;
      const total = t.user + t.nice + t.sys + t.idle + t.irq;
      out.push({ idx: i, idle: t.idle, total });
      out[0].idle += t.idle;
      out[0].total += total;
    });
    return out;
  }
  const lines = fs.readFileSync('/proc/stat', 'utf8').split('\n');
  const cpus = [];
  for (const line of lines) {
    const m = line.match(/^cpu(\d*)\s+(.*)$/);
    if (!m) continue;
    const v = m[2].trim().split(/\s+/).map(Number);
    const idle = v[3] + (v[4] || 0);
    const total = v.reduce((a, b) => a + b, 0);
    cpus.push({ idx: m[1] === '' ? -1 : Number(m[1]), idle, total });
  }
  return cpus;
}
function cpuUsage() {
  const now = readCpu();
  let pct = 0, cores = [];
  if (cpuPrev && cpuPrev.length === now.length) {
    for (let i = 0; i < now.length; i++) {
      const dt = now[i].total - cpuPrev[i].total;
      const di = now[i].idle - cpuPrev[i].idle;
      const u = dt > 0 ? Math.max(0, Math.min(100, (1 - di / dt) * 100)) : 0;
      if (now[i].idx === -1) pct = u; else cores.push(Math.round(u));
    }
  }
  cpuPrev = now;
  return { pct: Math.round(pct * 10) / 10, cores };
}
function readMem() {
  if (!fs.existsSync('/proc/meminfo')) {
    const total = os.totalmem();
    const free = os.freemem();
    return { total, used: total - free, avail: free, free, buffers: 0, cached: 0, swapTotal: 0, swapUsed: 0 };
  }
  const txt = fs.readFileSync('/proc/meminfo', 'utf8');
  const g = (k) => {
    const m = txt.match(new RegExp('^' + k + ':\\s+(\\d+)', 'm'));
    return m ? Number(m[1]) : 0;
  };
  const total = g('MemTotal'), avail = g('MemAvailable') || g('MemFree');
  const swapTotal = g('SwapTotal'), swapFree = g('SwapFree');
  return {
    total, used: total - avail, avail, free: g('MemFree'),
    buffers: g('Buffers'), cached: g('Cached'),
    swapTotal, swapUsed: swapTotal - swapFree,
  };
}
let netPrev = null;
function readNet() {
  if (!fs.existsSync('/proc/net/dev')) {
    const now = { rx: 0, tx: 0, t: Date.now() };
    if (!netPrev) { netPrev = now; return { total: { rx: 0, tx: 0 }, rate: { rx: 0, tx: 0 } }; }
    netPrev = now;
    return { total: { rx: 0, tx: 0 }, rate: { rx: 0, tx: 0 } };
  }
  const txt = fs.readFileSync('/proc/net/dev', 'utf8');
  const tot = { rx: 0, tx: 0 };
  for (const line of txt.split('\n')) {
    const m = line.match(/^\s*([a-z0-9@._-]+):\s*(.*)$/i);
    if (!m) continue;
    if (m[1] === 'lo') continue;
    const v = m[2].trim().split(/\s+/).map(Number);
    tot.rx += v[0]; tot.tx += v[8];
  }
  const now = { ...tot, t: Date.now() };
  let rate = { rx: 0, tx: 0 };
  if (netPrev) {
    const dt = (now.t - netPrev.t) / 1000;
    if (dt > 0.2) rate = { rx: (tot.rx - netPrev.rx) / dt, tx: (tot.tx - netPrev.tx) / dt };
  }
  netPrev = now;
  return { total: tot, rate };
}
function safeExec(file, args, opt, cb) {
  // 某些受限环境（沙箱 / 无 fork 权限）里 spawn 会同步抛 EPERM，这里兜住并回一个错误
  try {
    return execFile(file, args, opt, cb);
  } catch (e) {
    try { cb(e, '', ''); } catch (_) { /* ignore */ }
    return null;
  }
}

function dfDisk() {
  return new Promise((resolve) => {
    safeExec('df', ['-kP'], { timeout: 4000 }, (err, stdout) => {
      if (err) return resolve([]);
      const out = [];
      stdout.split('\n').slice(1).forEach((line) => {
        const p = line.trim().split(/\s+/);
        if (p.length < 6 || p[0] === 'tmpfs' || p[0] === 'devtmpfs') return;
        if (!p[5].startsWith('/')) return;
        out.push({
          fs: p[0], size: Number(p[1]) * 1024, used: Number(p[2]) * 1024,
          avail: Number(p[3]) * 1024, pct: Number(String(p[4]).replace('%', '')), mount: p[5],
        });
      });
      resolve(out);
    });
  });
}
let procCache = { at: 0, list: [] };
function topProcs() {
  if (Date.now() - procCache.at < 1500) return procCache.list;
  safeExec('ps', ['-eo', 'pid,comm,pcpu,pmem,rss', '--sort=-pcpu', '--no-headers'], { timeout: 4000 }, (err, stdout) => {
    if (err) return;
    const list = [];
    stdout.split('\n').forEach((line) => {
      const t = line.trim();
      if (!t) return;
      const m = t.match(/^(\d+)\s+(\S+)\s+([\d.]+)\s+([\d.]+)\s+(\d+)$/);
      if (!m) return;
      list.push({ pid: Number(m[1]), name: m[2], cpu: Number(m[3]), mem: Number(m[4]), rss: Number(m[5]) * 1024 });
    });
    procCache = { at: Date.now(), list: list.slice(0, 14) };
  });
  return procCache.list;
}

/* ---------------- 服务 ---------------- */
let svcCache = { at: 0, list: [] };
function listServices() {
  return new Promise((resolve) => {
    if (Date.now() - svcCache.at < 3000) return resolve(svcCache.list);

    const done = (list) => {
      list.sort((a, b) => (a.watched === b.watched ? a.unit.localeCompare(b.unit) : a.watched ? -1 : 1));
      svcCache = { at: Date.now(), list };
      resolve(list);
    };

    safeExec('systemctl', ['list-units', '--type=service', '--all', '--no-pager', '--no-legend', '--plain'], { timeout: 6000 }, (err, stdout) => {
      const list = [];
      if (!err && stdout) {
        stdout.split('\n').forEach((line) => {
          const t = line.replace(/^\W+/, '').trim();
          if (!t) return;
          const p = t.split(/\s+/);
          const unit = p[0];
          if (!unit || !unit.endsWith('.service')) return;
          const active = p[2] || '';
          const sub = p[3] || '';
          const desc = p.slice(4).join(' ');
          const watched = CONF.watch.includes(unit);
          if (!watched && active !== 'active' && active !== 'failed') return;
          list.push({ unit, active, sub, desc, watched });
        });
      }

      // 停用且已卸载的单元不会出现在 list-units 里，用 show 单独补回来
      const missing = CONF.watch.filter((u) => !list.some((x) => x.unit === u));
      if (!missing.length) return done(list);

      let left = missing.length;
      missing.forEach((u) => {
        safeExec('systemctl', ['show', '-p', 'ActiveState', '-p', 'SubState', '-p', 'Description', u], { timeout: 4000 }, (e2, out) => {
          const kv = {};
          String(out || '').split('\n').forEach((ln) => {
            const i = ln.indexOf('=');
            if (i > 0) kv[ln.slice(0, i).trim()] = ln.slice(i + 1).trim();
          });
          list.push({
            unit: u,
            active: kv.ActiveState || 'inactive',
            sub: kv.SubState || 'dead',
            desc: kv.Description || '',
            watched: true,
          });
          if (--left === 0) done(list);
        });
      });
    });
  });
}

/* ---------------- 执行命令 ---------------- */
const UNIT_RE = /^[A-Za-z0-9@._:-]+\.(service|socket|timer|target|mount)$/;

function runServiceAction(unit, action) {
  return new Promise((resolve) => {
    if (!UNIT_RE.test(unit)) return resolve({ ok: false, err: '非法的服务名' });
    if (!['start', 'stop', 'restart', 'reload', 'enable', 'disable', 'mask', 'unmask'].includes(action)) {
      return resolve({ ok: false, err: '非法操作' });
    }
    safeExec('systemctl', [action, unit, '--no-pager'], { timeout: 15000 }, (err, stdout, stderr) => {
      svcCache.at = 0;
      resolve({ ok: !err, out: (stdout || '') + (stderr || ''), err: err ? String(err.message) : null });
    });
  });
}

function runLogs(unit, lines) {
  return new Promise((resolve) => {
    const args = ['-u', unit, '-n', String(Math.max(10, Math.min(500, Number(lines) || 80))), '--no-pager', '-o', 'short-iso'];
    if (!UNIT_RE.test(unit)) return resolve({ ok: false, out: '非法的服务名' });
    safeExec('journalctl', args, { timeout: 8000, maxBuffer: 2 * 1024 * 1024 }, (err, stdout) => {
      resolve({ ok: !err, out: stdout || (err ? String(err.message) : '') });
    });
  });
}

/* ---------------- WS：指标推送 + 命令流 ---------------- */
const wss = new WebSocket.Server({ noServer: true });
const clients = new Set();

wss.on('connection', (ws, req) => {
  ws.isAlive = true;
  ws.ip = (req.socket.remoteAddress || '').replace('::ffff:', '');
  clients.add(ws);
  ws.on('pong', () => { ws.isAlive = true; });
  ws.on('message', (buf) => {
    let msg;
    try { msg = JSON.parse(buf.toString()); } catch (e) { return; }
    if (msg.t === 'ping') ws.send(JSON.stringify({ t: 'pong', ts: Date.now() }));
  });
  ws.on('close', () => clients.delete(ws));
  ws.on('error', () => clients.delete(ws));
  sendState(ws);
});

/* ---------------- 结束进程（v10） ---------------- */
const SAFE_SIGNALS = ['SIGTERM', 'SIGKILL', 'SIGINT', 'SIGHUP'];

/* 只允许结束真实存在、且 comm 与前端所见的进程名一致的 PID：
   PID 会被复用，名字对不上说明已经是另一个进程，直接拒绝。 */
function killProc(pid, name, sig) {
  if (!Number.isInteger(pid) || pid < 2) return { ok: false, err: '无效的 PID' };
  if (pid === process.pid) return { ok: false, err: '不能结束后台面板自身' };
  const signal = SAFE_SIGNALS.includes(sig) ? sig : 'SIGTERM';
  let comm = '';
  try { comm = fs.readFileSync('/proc/' + pid + '/comm', 'utf8').trim(); }
  catch (e) { return { ok: false, err: '进程不存在或无权读取' }; }
  if (name && comm && comm !== name) {
    return { ok: false, err: 'PID 已被复用（现在是 ' + comm + '），已拒绝' };
  }
  try {
    process.kill(pid, signal);
    return { ok: true, pid, name: comm, signal };
  } catch (e) {
    return { ok: false, err: e.code === 'EPERM' ? '权限不足' : String(e.message) };
  }
}

/* ---------------- 文件管理 ---------------- */
const FS_DENY = ['/proc', '/sys', '/dev', '/run'];
const FS_MAX_READ = 2 * 1024 * 1024;      // 在线编辑上限 2MB
const FS_MAX_WRITE = 8 * 1024 * 1024;
const FS_MAX_UPLOAD = 64 * 1024 * 1024;
const FS_BACKUP_DIR = '/var/backups/server-panel';

function fsSafe(p) {
  if (typeof p !== 'string' || !p) throw new Error('缺少路径');
  if (!p.startsWith('/')) throw new Error('必须是绝对路径');
  const abs = path.resolve(p);
  for (const d of FS_DENY) {
    if (abs === d || abs.startsWith(d + '/')) throw new Error('该目录不允许访问（' + d + '）');
  }
  return abs;
}

function fmtMode(m) {
  // 符号位：-rw-r--r-- / drwxr-xr-x / lrwxrwxrwx，附带 setuid/setgid/sticky
  const t = m & 0o170000;
  const type = t === 0o040000 ? 'd' : t === 0o120000 ? 'l' : t === 0o060000 ? 'b'
    : t === 0o020000 ? 'c' : t === 0o010000 ? 'p' : t === 0o140000 ? 's' : '-';
  const bits = [0o400, 0o200, 0o100, 0o040, 0o020, 0o010, 0o004, 0o002, 0o001];
  const chars = ['r', 'w', 'x', 'r', 'w', 'x', 'r', 'w', 'x'];
  const out = [type];
  for (let i = 0; i < 9; i++) out.push(m & bits[i] ? chars[i] : '-');
  if (m & 0o4000) out[3] = out[3] === 'x' ? 's' : 'S';
  if (m & 0o2000) out[6] = out[6] === 'x' ? 's' : 'S';
  if (m & 0o1000) out[9] = out[9] === 'x' ? 't' : 'T';
  return out.join('');
}

function fsList(dir) {
  const abs = fsSafe(dir);
  const st = fs.statSync(abs);
  if (!st.isDirectory()) throw new Error('不是目录');
  const names = fs.readdirSync(abs, { withFileTypes: true });
  const entries = [];
  for (const d of names) {
    const full = path.join(abs, d.name);
    let s, link = null;
    try {
      s = fs.lstatSync(full);
      if (s.isSymbolicLink()) {
        try { link = fs.readlinkSync(full); } catch (e) { link = '?'; }
        try { s = fs.statSync(full); } catch (e) { /* 断链保留 lstat */ }
      }
    } catch (e) { continue; }
    entries.push({
      name: d.name, path: full, dir: s.isDirectory(),
      size: s.isDirectory() ? 0 : s.size,
      mtime: s.mtimeMs, mode: fmtMode(s.mode),
      link, hidden: d.name.startsWith('.'),
    });
  }
  entries.sort((a, b) => (a.dir === b.dir ? a.name.localeCompare(b.name) : a.dir ? -1 : 1));
  const parent = abs === '/' ? null : path.dirname(abs);
  return { ok: true, dir: abs, parent, entries, count: entries.length };
}

function looksBinary(buf) {
  const n = Math.min(buf.length, 2048);
  for (let i = 0; i < n; i++) if (buf[i] === 0) return true;
  return false;
}

function fsRead(p) {
  const abs = fsSafe(p);
  const st = fs.statSync(abs);
  if (st.isDirectory()) throw new Error('这是一个目录');
  if (st.size > FS_MAX_READ) throw new Error('文件超过 2MB，请下载后编辑');
  const buf = fs.readFileSync(abs);
  if (looksBinary(buf)) throw new Error('二进制文件，不支持在线编辑');
  return {
    ok: true, path: abs, size: st.size, mtime: st.mtimeMs, mode: fmtMode(st.mode),
    content: buf.toString('utf8'), max: FS_MAX_READ,
  };
}

function backupFile(abs, buf) {
  try {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const dest = path.join(FS_BACKUP_DIR, stamp, abs.replace(/^\/+/, '').replace(/\//g, '__'));
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, buf);
    return dest;
  } catch (e) { return null; }
}

function fsWrite(p, content, expectMtime) {
  const abs = fsSafe(p);
  if (typeof content !== 'string') throw new Error('内容必须是文本');
  if (Buffer.byteLength(content) > FS_MAX_WRITE) throw new Error('内容超过 8MB');
  let st = null;
  try { st = fs.statSync(abs); } catch (e) { /* 新文件 */ }
  if (st) {
    if (st.isDirectory()) throw new Error('目标是一个目录');
    if (expectMtime && Math.abs(st.mtimeMs - Number(expectMtime)) > 1) {
      const err = new Error('文件已被其它程序修改，请重新打开后再保存');
      err.code = 'ECONFLICT';
      throw err;
    }
  }
  const dir = path.dirname(abs);
  if (!fs.existsSync(dir)) throw new Error('目录不存在：' + dir);
  let backup = null;
  if (st) backup = backupFile(abs, fs.readFileSync(abs));
  const tmp = path.join(dir, '.' + path.basename(abs) + '.sp-' + process.pid + '-' + Date.now());
  fs.writeFileSync(tmp, content, { encoding: 'utf8', mode: st ? st.mode & 0o7777 : 0o644 });
  if (st) { try { fs.chownSync(tmp, st.uid, st.gid); } catch (e) { /* 非 root 忽略 */ } }
  fs.renameSync(tmp, abs);
  const s2 = fs.statSync(abs);
  return { ok: true, path: abs, size: s2.size, mtime: s2.mtimeMs, backup };
}

function fsMkdir(p) {
  const abs = fsSafe(p);
  if (fs.existsSync(abs)) throw new Error('已存在同名文件或目录');
  fs.mkdirSync(abs, { recursive: false });
  return { ok: true, path: abs };
}

function fsCreate(p) {
  const abs = fsSafe(p);
  if (fs.existsSync(abs)) throw new Error('已存在同名文件');
  const dir = path.dirname(abs);
  if (!fs.existsSync(dir)) throw new Error('目录不存在：' + dir);
  fs.writeFileSync(abs, '', { mode: 0o644 });
  return { ok: true, path: abs };
}

function fsRename(from, to) {
  const a = fsSafe(from), b = fsSafe(to);
  if (!fs.existsSync(a)) throw new Error('源文件不存在');
  if (fs.existsSync(b)) throw new Error('目标已存在');
  fs.renameSync(a, b);
  return { ok: true, from: a, to: b };
}

function fsDelete(p, recursive) {
  const abs = fsSafe(p);
  if (abs === '/') throw new Error('不能删除根目录');
  const st = fs.lstatSync(abs);
  if (st.isDirectory()) {
    const kids = fs.readdirSync(abs);
    if (kids.length && !recursive) throw new Error('目录非空，需确认递归删除');
    fs.rmSync(abs, { recursive: true, force: false });
  } else {
    fs.unlinkSync(abs);
  }
  return { ok: true, path: abs };
}

function fsUpload(dir, name, req) {
  return new Promise((resolve, reject) => {
    let d;
    try { d = fsSafe(dir); } catch (e) { return reject(e); }
    if (!fs.existsSync(d) || !fs.statSync(d).isDirectory()) return reject(new Error('目标目录不存在'));
    const base = path.basename(String(name || '')).replace(/[/\\]/g, '');
    if (!base || base === '.' || base === '..') return reject(new Error('非法的文件名'));
    const dest = path.join(d, base);
    const tmp = path.join(d, '.' + base + '.sp-up-' + Date.now());
    let size = 0;
    const out = fs.createWriteStream(tmp, { mode: 0o644 });
    req.on('data', (c) => {
      size += c.length;
      if (size > FS_MAX_UPLOAD) { req.destroy(); out.destroy(); try { fs.unlinkSync(tmp); } catch (e) {} reject(new Error('文件超过 64MB')); }
    });
    req.pipe(out);
    out.on('finish', () => {
      try { fs.renameSync(tmp, dest); } catch (e) { return reject(e); }
      resolve({ ok: true, path: dest, size });
    });
    out.on('error', (e) => { try { fs.unlinkSync(tmp); } catch (_) {} reject(e); });
  });
}

function fsDownload(res, p) {
  const abs = fsSafe(p);
  const st = fs.statSync(abs);
  if (st.isDirectory()) throw new Error('目录不能直接下载');
  res.writeHead(200, {
    'Content-Type': 'application/octet-stream',
    'Content-Length': st.size,
    'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(path.basename(abs))}`,
    'Cache-Control': 'no-store',
  });
  fs.createReadStream(abs).pipe(res);
}


/* ---------------- 多服务器：主机清单 / SSH 探测 ---------------- */
const HOSTS_FILE = process.env.PANEL_HOSTS || '/etc/server-panel-hosts.json';

/* 远端探测脚本经 base64 传到目标机执行，彻底绕开多层引号转义 */
const PROBE_SCRIPT = [
  'echo "HOST=$(hostname 2>/dev/null)"',
  'echo "CORES=$(nproc 2>/dev/null || echo 1)"',
  'echo "UPTIME=$(cut -d. -f1 /proc/uptime 2>/dev/null || echo 0)"',
  'echo "LOAD=$(cut -d\' \' -f1-3 /proc/loadavg 2>/dev/null)"',
  'echo "CPU=$(head -1 /proc/stat 2>/dev/null)"',
  'echo "MEM=$(awk \'/^MemTotal:/{t=$2} /^MemAvailable:/{a=$2} /^SwapTotal:/{s=$2} /^SwapFree:/{f=$2} END{print t, a, s, f}\' /proc/meminfo 2>/dev/null)"',
  'echo "DISK=$(df -kP / 2>/dev/null | awk \'NR==2{gsub(/%/,"",$5); print $2, $3, $5}\')"',
  'echo "PROCS"',
  'ps -eo pid=,comm=,pcpu=,pmem=,rss= --sort=-pcpu 2>/dev/null | head -n 24',
  'echo "SVC"',
  'systemctl list-units --type=service --all --no-pager --no-legend --plain 2>/dev/null | head -n 120',
  'echo "NETDEV"',
  'cat /proc/net/dev 2>/dev/null',
  'echo "END"',
].join('\n');
const PROBE_CMD = 'echo ' + Buffer.from(PROBE_SCRIPT).toString('base64') + ' | base64 -d | sh';

let hostsCache = null;

function loadHosts() {
  if (hostsCache) return hostsCache;
  let list = [];
  try {
    list = JSON.parse(fs.readFileSync(HOSTS_FILE, 'utf8'));
  } catch (e) {
    list = [];
  }
  if (!Array.isArray(list)) list = [];
  hostsCache = list.filter((h) => h && h.id && h.host);
  return hostsCache;
}

function saveHosts(list) {
  hostsCache = list;
  try {
    fs.mkdirSync(path.dirname(HOSTS_FILE), { recursive: true });
    fs.writeFileSync(HOSTS_FILE, JSON.stringify(list, null, 2), { mode: 0o600 });
    fs.chmodSync(HOSTS_FILE, 0o600);
  } catch (e) {
    console.error('[panel] 写入主机清单失败：' + e.message);
  }
}

function localIp() {
  const ifs = os.networkInterfaces();
  for (const k of Object.keys(ifs)) {
    for (const a of ifs[k] || []) {
      if (a.family === 'IPv4' && !a.internal) return a.address;
    }
  }
  return '127.0.0.1';
}

function localHost() {
  return {
    id: 'local', name: os.hostname(), host: process.env.PANEL_PUBLIC_IP || localIp(), port: 0,
    user: 'root', kind: 'local', auth: { type: 'local' },
  };
}

function findHost(id) {
  if (!id || id === 'local') return localHost();
  return loadHosts().find((h) => h.id === id) || null;
}

/* 对外输出时抹掉密码 / 私钥 */
function maskHost(h) {
  const o = { id: h.id, name: h.name, host: h.host, port: h.port, user: h.user, kind: h.kind || 'ssh' };
  o.authType = (h.auth && h.auth.type) || 'password';
  if (o.authType === 'key') o.keyPath = (h.auth && h.auth.keyPath) || '';
  return o;
}

let SshClient;
function sshClient() {
  if (SshClient === undefined) {
    try {
      SshClient = require('ssh2').Client;
    } catch (e) {
      SshClient = null;
      console.error('[panel] 未安装 ssh2（npm i ssh2），远程主机只能用私钥 + 系统 ssh 连接');
    }
  }
  return SshClient;
}

function sshErr(e) {
  const raw = String((e && e.message) || e || '');
  if (/authentication methods failed|All configured/i.test(raw)) return '认证失败（账号或密码错误）';
  if (/ECONNREFUSED/i.test(raw)) return '端口拒绝连接';
  if (/ETIMEDOUT|timed out|Timeout/i.test(raw)) return '连接超时（检查端口与防火墙）';
  if (/ENOTFOUND|getaddrinfo/i.test(raw)) return '域名解析失败';
  if (/EHOSTUNREACH|ENETUNREACH/i.test(raw)) return '无法到达该主机';
  if (/ENOENT/i.test(raw)) return '私钥文件不存在';
  return raw.slice(0, 160) || 'SSH 失败';
}

function sshExec(h, cmd, timeout) {
  const Client = sshClient();
  if (!Client) {
    /* 没有 ssh2 时退回系统 ssh（只支持私钥） */
    if (h.auth && h.auth.type === 'key' && h.auth.keyPath) {
      return new Promise((resolve) => {
        const args = ['-i', h.auth.keyPath, '-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=no',
          '-o', 'LogLevel=ERROR', '-o', 'ConnectTimeout=6', '-p', String(h.port || 22),
          h.user + '@' + h.host, cmd];
        safeExec('ssh', args, { timeout: timeout || 9000, maxBuffer: 512 * 1024 }, (err, stdout, stderr) => {
          if (err) return resolve({ ok: false, err: sshErr({ message: String(stderr || err.message) }) });
          resolve({ ok: true, out: stdout || '' });
        });
      });
    }
    return Promise.resolve({ ok: false, err: '服务器缺少 ssh2 依赖，无法用密码登录远程主机' });
  }

  return new Promise((resolve) => {
    const conn = new Client();
    let done = false;
    const finish = (r) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try { conn.end(); } catch (e) { /* ignore */ }
      resolve(r);
    };
    const timer = setTimeout(() => finish({ ok: false, err: '连接超时（检查端口与防火墙）' }), timeout || 12000);

    conn.on('ready', () => {
      conn.exec(cmd, (err, stream) => {
        if (err) return finish({ ok: false, err: '执行命令失败：' + sshErr(err) });
        let out = '';
        stream.on('data', (d) => { out += d.toString('utf8'); });
        stream.stderr.on('data', () => { /* 探测脚本不该有 stderr，忽略 */ });
        stream.on('close', () => finish({ ok: true, out }));
        stream.on('error', (e) => finish({ ok: false, err: sshErr(e) }));
      });
    });
    conn.on('error', (e) => finish({ ok: false, err: sshErr(e) }));

    const cfg = {
      host: h.host,
      port: Number(h.port) || 22,
      username: h.user,
      readyTimeout: Math.min(10000, timeout || 9000),
      keepaliveInterval: 0,
    };
    const auth = h.auth || {};
    if (auth.type === 'password') {
      cfg.password = auth.password || '';
      cfg.tryKeyboard = true;
    } else if (auth.type === 'key' && auth.keyPath) {
      try {
        cfg.privateKey = fs.readFileSync(auth.keyPath);
      } catch (e) {
        return finish({ ok: false, err: '私钥文件读不到：' + auth.keyPath });
      }
    } else {
      return finish({ ok: false, err: '该主机没有可用的登录凭据' });
    }
    try {
      conn.connect(cfg);
    } catch (e) {
      finish({ ok: false, err: sshErr(e) });
    }
  });
}

function parseProbe(out) {
  const kv = {};
  out.split('\n').forEach((line) => {
    const i = line.indexOf('=');
    if (i > 0) kv[line.slice(0, i).trim()] = line.slice(i + 1).trim();
  });
  return kv;
}

const remotePrev = new Map();
const remoteNetPrev = new Map();

function splitNum(s, n) {
  const a = String(s || '').trim().split(/\s+/).map(Number);
  const o = [];
  for (let i = 0; i < n; i++) o.push(Number.isFinite(a[i]) ? a[i] : 0);
  return o;
}

function cpuFromLine(line) {
  const a = String(line || '').replace(/^cpu\s+/, '').trim().split(/\s+/).map(Number);
  if (a.length < 4) return null;
  const total = a.reduce((x, y) => x + (Number.isFinite(y) ? y : 0), 0);
  const idle = (a[3] || 0) + (a[4] || 0);
  return { total, idle };
}

/* 把探测输出里 PROCS / SVC 两段拆出来 */
function parseProbeSections(out) {
  const lines = String(out || '').split('\n');
  const procs = [];
  const services = [];
  const netLines = [];
  let mode = '';
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].replace(/\r$/, '');
    if (line === 'PROCS') { mode = 'procs'; continue; }
    if (line === 'SVC') { mode = 'svc'; continue; }
    if (line === 'NETDEV') { mode = 'net'; continue; }
    if (line === 'END') { mode = ''; continue; }
    if (!line.trim()) continue;
    if (mode === 'procs') {
      const a = line.trim().split(/\s+/);
      if (a.length < 5) continue;
      procs.push({ pid: Number(a[0]) || 0, name: a[1], cpu: Number(a[2]) || 0, mem: Number(a[3]) || 0, rss: (Number(a[4]) || 0) * 1024 });
    } else if (mode === 'net') {
      netLines.push(line);
    } else if (mode === 'svc') {
      const a = line.trim().split(/\s+/);
      if (a.length < 4 || !/\.(service|socket|timer|target|mount)$/.test(a[0])) continue;
      services.push({ unit: a[0], load: a[1], active: a[2], sub: a[3], desc: a.slice(4).join(' ') });
    }
  }
  return { procs, services, net: netTotals(netLines) };
}

/* /proc/net/dev：第 1 列是接口名，第 2 列起 rx bytes … 第 10 列 tx bytes */
function netTotals(lines) {
  let rx = 0;
  let tx = 0;
  for (const line of lines) {
    const m = /^\s*([^:]+):\s*(.+)$/.exec(line);
    if (!m) continue;
    if (m[1].trim() === 'lo') continue;
    const a = m[2].trim().split(/\s+/).map(Number);
    if (a.length < 9) continue;
    if (Number.isFinite(a[0])) rx += a[0];
    if (Number.isFinite(a[8])) tx += a[8];
  }
  return { rx, tx };
}

async function probeHost(h) {
  const r = await sshExec(h, PROBE_CMD, 9000);
  if (!r.ok) return { ok: false, err: r.err };
  const kv = parseProbe(r.out);
  const sec = parseProbeSections(r.out);
  const mem = splitNum(kv.MEM, 4);   // MemTotal, MemAvailable, SwapTotal, SwapFree (kB)
  const disk = splitNum(kv.DISK, 3); // 1K-blocks total, used, pct%
  const total = mem[0] * 1024;
  const avail = mem[1] * 1024;
  const cur = cpuFromLine(kv.CPU);
  const prev = remotePrev.get(h.id);
  let pct = 0;
  if (cur && prev) {
    const dt = cur.total - prev.total;
    const di = cur.idle - prev.idle;
    if (dt > 0) pct = Math.max(0, Math.min(100, (1 - di / dt) * 100));
  }
  if (cur) remotePrev.set(h.id, cur);

  /* 网卡速率：与上一次采样做差分 */
  const net = sec.net || { rx: 0, tx: 0 };
  const netPrev = remoteNetPrev.get(h.id);
  const now = Date.now();
  let netRate = { rx: 0, tx: 0 };
  if (netPrev && now - netPrev.at > 300) {
    const dt = (now - netPrev.at) / 1000;
    netRate = {
      rx: Math.max(0, Math.round((net.rx - netPrev.rx) / dt)),
      tx: Math.max(0, Math.round((net.tx - netPrev.tx) / dt)),
    };
  }
  remoteNetPrev.set(h.id, { at: now, rx: net.rx, tx: net.tx });
  return {
    ok: true,
    hostname: kv.HOST || h.host,
    cores: Number(kv.CORES) || 1,
    uptime: Number(kv.UPTIME) || 0,
    load: splitNum(kv.LOAD, 3),
    cpu: Math.round(pct * 10) / 10,
    mem: {
      total,
      used: Math.max(0, total - avail),
      avail,
      swapTotal: mem[2] * 1024,
      swapUsed: Math.max(0, (mem[2] - mem[3]) * 1024),
    },
    disk: {
      total: disk[0] * 1024,
      used: disk[1] * 1024,
      pct: disk[2] || 0,
      mount: '/',
    },
    net: { rate: netRate, total: net },
    procs: sec.procs,
    services: sec.services,
  };
}

const hostCache = new Map(); // id -> {at, data}

async function hostSummary(h) {
  const cached = hostCache.get(h.id);
  if (cached && Date.now() - cached.at < 4000) return cached.data;
  let data;
  if (h.kind === 'local' || h.id === 'local') {
    const mem = readMem();
    const disks = await dfDisk();
    const root = disks.find((d) => d.mount === '/') || disks[0] || {};
    const cpu = cpuUsage();
    data = {
      ok: true, kind: 'local', name: h.name, host: h.host, id: h.id,
      hostname: os.hostname(), cores: os.cpus().length, uptime: os.uptime(),
      load: os.loadavg(), cpu,
      mem: { total: mem.total, used: mem.used, avail: mem.avail },
      disk: { total: root.size || 0, used: root.used || 0, pct: root.pct || 0, mount: root.mount || '/' },
      ts: Date.now(),
    };
  } else {
    const p = await probeHost(h);
    if (!p.ok) {
      data = {
        ok: false, kind: 'ssh', id: h.id, name: h.name, host: h.host, port: h.port,
        user: h.user, err: p.err, ts: Date.now(),
      };
    } else {
      data = Object.assign({ kind: 'ssh', id: h.id, name: h.name, host: h.host, port: h.port, user: h.user, ts: Date.now() }, p);
    }
  }
  hostCache.set(h.id, { at: Date.now(), data });
  return data;
}

async function hostList() {
  const list = [localHost()].concat(loadHosts());
  const out = await Promise.all(list.map((h) => hostSummary(h)));
  return out;
}

async function remoteSnapshot(h) {
  const p = await probeHost(h);
  if (!p.ok) throw new Error(p.err);
  return {
    t: Date.now(),
    remote: true,
    host: {
      hostname: p.hostname, platform: 'linux', release: '', arch: '—',
      node: '—', uptime: p.uptime, boot: Date.now() - p.uptime * 1000,
      cores: p.cores, model: h.user + '@' + h.host, time: new Date().toString(),
    },
    load: p.load,
    cpu: { pct: p.cpu, cores: [] },
    mem: p.mem,
    net: p.net || { rate: { rx: 0, tx: 0 }, total: { rx: 0, tx: 0 } },
    disk: [{ fs: '/', size: p.disk.total, used: p.disk.used, avail: p.disk.total - p.disk.used, pct: p.disk.pct, mount: p.disk.mount }],
    procs: p.procs || [],
    services: p.services || [],
  };
}

/* ---------- 远程操作：服务 / 进程 / 日志 ---------- */
function unitOk(u) { return /^[A-Za-z0-9@._:-]+\.(service|socket|timer|target|mount)$/.test(u); }
const SVC_ACTIONS = ['start', 'stop', 'restart', 'reload', 'enable', 'disable', 'mask', 'unmask'];

async function remoteService(h, unit, action) {
  if (!unitOk(unit)) return { ok: false, err: '服务名不合法' };
  if (SVC_ACTIONS.indexOf(action) < 0) return { ok: false, err: '不支持的操作' };
  const r = await sshExec(h, 'systemctl ' + action + ' ' + unit + ' 2>&1; echo "RC=$?"', 15000);
  if (!r.ok) return { ok: false, err: r.err };
  const m = /RC=(\d+)\s*$/.exec(r.out || '');
  const code = m ? Number(m[1]) : 0;
  const out = String(r.out || '').replace(/RC=\d+\s*$/, '').trim();
  return code === 0 ? { ok: true, out: out || (unit + ' ' + action + ' 完成') } : { ok: false, err: out || ('systemctl 返回 ' + code) };
}

async function remoteKill(h, pid, name, sig) {
  if (!Number.isInteger(pid) || pid < 2) return { ok: false, err: '无效的 PID' };
  const s2 = SAFE_SIGNALS.indexOf(sig) >= 0 ? sig : 'SIGTERM';
  const r = await sshExec(h, 'ps -o comm= -p ' + pid + ' 2>/dev/null', 8000);
  if (!r.ok) return { ok: false, err: r.err };
  const comm = String(r.out || '').trim().split('\n')[0].trim();
  if (!comm) return { ok: false, err: '进程不存在（可能已退出）' };
  if (name && comm !== name) return { ok: false, err: 'PID 已被复用（现在是 ' + comm + '），已拒绝' };
  const k = await sshExec(h, 'kill -' + s2 + ' ' + pid + ' 2>&1; echo "RC=$?"', 8000);
  if (!k.ok) return { ok: false, err: k.err };
  const m = /RC=(\d+)/.exec(k.out || '');
  const code = m ? Number(m[1]) : 0;
  if (code === 0) return { ok: true, out: '已向 ' + comm + '(' + pid + ') 发送 ' + s2 };
  return { ok: false, err: String(k.out || '').replace(/RC=\d+/, '').trim() || '结束进程失败' };
}

async function remoteLogs(h, unit, lines) {
  if (!unitOk(unit)) return { ok: false, err: '服务名不合法' };
  const n = Math.max(10, Math.min(500, Number(lines) || 120));
  const r = await sshExec(h, 'journalctl -u ' + unit + ' -n ' + n + ' --no-pager 2>&1', 15000);
  if (!r.ok) return { ok: false, err: r.err };
  return { ok: true, out: r.out || '' };
}

async function stateFor(id) {
  if (!id || id === 'local') return snapshot();
  const h = findHost(id);
  if (!h) throw new Error('主机不存在');
  return remoteSnapshot(h);
}


/* ---------------- 状态快照 ---------------- */
async function snapshot() {
  const cpu = cpuUsage();
  const mem = readMem();
  const net = readNet();
  const disk = await dfDisk();
  const services = await listServices();
  return {
    t: Date.now(),
    host: {
      hostname: os.hostname(), platform: os.platform(), release: os.release(), arch: os.arch(),
      node: process.version, uptime: os.uptime(), boot: Date.now() - os.uptime() * 1000,
      cores: os.cpus().length, model: (os.cpus()[0] || {}).model || 'unknown',
      time: new Date().toString(),
    },
    load: os.loadavg(),
    cpu, mem, net, disk,
    procs: topProcs(),
    services,
  };
}

async function sendState(ws) {
  try {
    const s = await snapshot();
    if (ws.readyState === 1) ws.send(JSON.stringify({ t: 'state', data: s }));
  } catch (e) { /* ignore */ }
}

setInterval(async () => {
  if (!clients.size) return;
  const s = await snapshot();
  const payload = JSON.stringify({ t: 'state', data: s });
  for (const ws of clients) {
    if (ws.readyState === 1) ws.send(payload);
  }
}, 2000);

setInterval(() => {
  for (const ws of clients) {
    if (!ws.isAlive) { ws.terminate(); clients.delete(ws); continue; }
    ws.isAlive = false;
    try { ws.ping(); } catch (e) {}
  }
}, 30000);

/* ---------------- 静态文件 ---------------- */
const MIME = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.txt': 'text/plain; charset=utf-8',
};
function serveStatic(req, res, pathname) {
  let rel = decodeURIComponent(pathname);
  if (rel === '/' ) rel = '/index.html';
  const file = path.normalize(path.join(CONF.webDir, rel));
  if (!file.startsWith(path.normalize(CONF.webDir))) { res.writeHead(403); res.end('forbidden'); return; }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }); res.end('not found'); return; }
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream',
      'Cache-Control': path.extname(file) === '.html' ? 'no-store' : 'public, max-age=60',
    });
    res.end(data);
  });
}

/* ---------------- 路由 ---------------- */
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const p = url.pathname;
  const ip = (req.headers['x-real-ip'] || req.socket.remoteAddress || '').replace('::ffff:', '');

  try {
    if (p === '/api/ping') {
      return json(res, 200, { ok: true, auth: !!sessionOf(req), host: os.hostname() });
    }

    if (p === '/api/login' && req.method === 'POST') {
      const rec = loginFails.get(ip) || { n: 0, until: 0 };
      if (rec.n >= 6 && Date.now() < rec.until) {
        return json(res, 429, { ok: false, err: '尝试次数过多，请 5 分钟后再试' });
      }
      const body = await readBody(req);
      const okUser = safeEqual(body.user || '', CONF.user);
      const okPass = safeEqual(body.pass || '', CONF.pass);
      if (!okUser || !okPass) {
        rec.n += 1;
        rec.until = Date.now() + 5 * 60 * 1000;
        loginFails.set(ip, rec);
        return json(res, 401, { ok: false, err: '账号或密码错误' });
      }
      loginFails.delete(ip);
      const token = newSession(ip);
      res.setHeader('Set-Cookie', `sp_sess=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${CONF.sessionTtl / 1000}`);
      return json(res, 200, { ok: true });
    }

    if (p === '/api/logout') {
      const tok = sessionOf(req);
      if (tok) sessions.delete(tok);
      res.setHeader('Set-Cookie', 'sp_sess=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0');
      return json(res, 200, { ok: true });
    }

    /* 以下都需要登录 */
    const authed = !!sessionOf(req);
    if (p.startsWith('/api/')) {
      if (!authed) return json(res, 401, { ok: false, err: '未登录' });

      if (p === '/api/state') return json(res, 200, await stateFor(url.searchParams.get('host')));

      if (p === '/api/service' && req.method === 'POST') {
        const b = await readBody(req);
        let r;
        if (b.host && b.host !== 'local') {
          const h = findHost(String(b.host));
          r = h ? await remoteService(h, String(b.unit || ''), String(b.action || '')) : { ok: false, err: '主机不存在' };
        } else {
          r = await runServiceAction(String(b.unit || ''), String(b.action || ''));
        }
        return json(res, r.ok ? 200 : 400, r);
      }

      if (p === '/api/logs' && req.method === 'POST') {
        const b = await readBody(req);
        let r;
        if (b.host && b.host !== 'local') {
          const h = findHost(String(b.host));
          r = h ? await remoteLogs(h, String(b.unit || ''), b.lines) : { ok: false, err: '主机不存在' };
        } else {
          r = await runLogs(String(b.unit || ''), b.lines);
        }
        return json(res, 200, r);
      }

      /* ---------- 进程：结束指定 PID（v10） ---------- */
      if (p === '/api/proc/kill' && req.method === 'POST') {
        const b = await readBody(req);
        let r;
        if (b.host && b.host !== 'local') {
          const h = findHost(String(b.host));
          r = h ? await remoteKill(h, Number(b.pid), String(b.name || ''), String(b.sig || 'SIGTERM')) : { ok: false, err: '主机不存在' };
        } else {
          r = killProc(Number(b.pid), String(b.name || ''));
        }
        return json(res, r.ok ? 200 : 400, r);
      }

      /* ---------- 文件管理 ---------- */
      if (p === '/api/fs/list') {
        const rh = url.searchParams.get('host');
        try {
          if (rh && rh !== 'local') {
            const h = findHost(rh);
            if (!h) return json(res, 400, { ok: false, err: '主机不存在' });
            return json(res, 200, await remoteFs.list(h, url.searchParams.get('dir') || '/'));
          }
          return json(res, 200, fsList(url.searchParams.get('dir') || '/'));
        } catch (e) { return json(res, 400, { ok: false, err: String(e.message) }); }
      }

      if (p === '/api/fs/read') {
        const rh = url.searchParams.get('host');
        try {
          if (rh && rh !== 'local') {
            const h = findHost(rh);
            if (!h) return json(res, 400, { ok: false, err: '主机不存在' });
            return json(res, 200, await remoteFs.read(h, url.searchParams.get('path') || ''));
          }
          return json(res, 200, fsRead(url.searchParams.get('path') || ''));
        } catch (e) { return json(res, 400, { ok: false, err: String(e.message) }); }
      }

      if (p === '/api/fs/download') {
        const rh = url.searchParams.get('host');
        try {
          if (rh && rh !== 'local') {
            const h = findHost(rh);
            if (!h) return json(res, 404, { ok: false, err: '主机不存在' });
            return void (await remoteFs.download(h, url.searchParams.get('path') || '', res));
          }
          return fsDownload(res, url.searchParams.get('path') || '');
        } catch (e) { if (!res.headersSent) return json(res, 404, { ok: false, err: String(e.message) }); }
      }

      if (p === '/api/fs/write' && req.method === 'POST') {
        const b = await readBody(req, 12 * 1024 * 1024);
        try {
          if (b.host && b.host !== 'local') {
            const h = findHost(String(b.host));
            if (!h) throw new Error('主机不存在');
            return json(res, 200, await remoteFs.write(h, String(b.path || ''), b.content, b.mtime));
          }
          return json(res, 200, fsWrite(String(b.path || ''), b.content, b.mtime));
        } catch (e) { return json(res, e.code === 'ECONFLICT' ? 409 : 400, { ok: false, err: String(e.message), conflict: e.code === 'ECONFLICT' }); }
      }

      if (p === '/api/fs/mkdir' && req.method === 'POST') {
        const b = await readBody(req);
        try {
          if (b.host && b.host !== 'local') {
            const h = findHost(String(b.host));
            if (!h) throw new Error('主机不存在');
            return json(res, 200, await remoteFs.mkdir(h, String(b.path || '')));
          }
          return json(res, 200, fsMkdir(String(b.path || '')));
        } catch (e) { return json(res, 400, { ok: false, err: String(e.message) }); }
      }

      if (p === '/api/fs/create' && req.method === 'POST') {
        const b = await readBody(req);
        try {
          if (b.host && b.host !== 'local') {
            const h = findHost(String(b.host));
            if (!h) throw new Error('主机不存在');
            return json(res, 200, await remoteFs.create(h, String(b.path || '')));
          }
          return json(res, 200, fsCreate(String(b.path || '')));
        } catch (e) { return json(res, 400, { ok: false, err: String(e.message) }); }
      }

      if (p === '/api/fs/rename' && req.method === 'POST') {
        const b = await readBody(req);
        try {
          if (b.host && b.host !== 'local') {
            const h = findHost(String(b.host));
            if (!h) throw new Error('主机不存在');
            return json(res, 200, await remoteFs.rename(h, String(b.from || ''), String(b.to || '')));
          }
          return json(res, 200, fsRename(String(b.from || ''), String(b.to || '')));
        } catch (e) { return json(res, 400, { ok: false, err: String(e.message) }); }
      }

      if (p === '/api/fs/delete' && req.method === 'POST') {
        const b = await readBody(req);
        try {
          if (b.host && b.host !== 'local') {
            const h = findHost(String(b.host));
            if (!h) throw new Error('主机不存在');
            return json(res, 200, await remoteFs.remove(h, String(b.path || ''), !!b.recursive));
          }
          return json(res, 200, fsDelete(String(b.path || ''), !!b.recursive));
        }
        catch (e) { return json(res, 400, { ok: false, err: String(e.message) }); }
      }

      if (p === '/api/fs/upload' && req.method === 'POST') {
        if (!sessionOf(req)) return json(res, 401, { ok: false, err: '未登录' });
        try {
          const rh = url.searchParams.get('host');
          if (rh && rh !== 'local') {
            const h = findHost(rh);
            if (!h) throw new Error('主机不存在');
            const buf = await readRawBody(req, 32 * 1024 * 1024);
            const r = await remoteFs.upload(h, url.searchParams.get('dir') || '/', url.searchParams.get('name') || '', buf);
            return json(res, 200, r);
          }
          const r = await fsUpload(url.searchParams.get('dir') || '/', url.searchParams.get('name') || '', req);
          return json(res, 200, r);
        } catch (e) { return json(res, 400, { ok: false, err: String(e.message) }); }
      }

      if (p === '/api/hosts') {
    return json(res, 200, { ok: true, hosts: await hostList() });
  }
  if (p === '/api/hosts/add' && req.method === 'POST') {
    const b = await readBody(req);
    const name = String(b.name || '').trim();
    const host = String(b.host || '').trim();
    const user = String(b.user || '').trim();
    const port = Number(b.port || 22);
    const authType = String(b.authType || 'password');
    if (!name || name.length > 32) return json(res, 400, { error: '名称需为 1~32 个字符' });
    if (!/^[A-Za-z0-9._:-]{1,64}$/.test(host)) return json(res, 400, { error: '主机地址不合法' });
    if (!/^[A-Za-z0-9._-]{1,32}$/.test(user)) return json(res, 400, { error: '用户名不合法' });
    if (!(port >= 1 && port <= 65535)) return json(res, 400, { error: '端口需在 1~65535' });
    if (authType !== 'password' && authType !== 'key') return json(res, 400, { error: '认证方式只支持密码或私钥' });
    const list = loadHosts().slice();
    if (list.some((h) => h.host === host && Number(h.port || 22) === port && h.user === user)) {
      return json(res, 400, { error: '这台主机已经在列表里了' });
    }
    const entry = {
      id: 'h' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
      name, host, port, user, kind: 'ssh',
      auth: authType === 'password'
        ? { type: 'password', password: String(b.password || '') }
        : { type: 'key', keyPath: String(b.keyPath || '') },
      createdAt: Date.now(),
    };
    if (authType === 'password' && !entry.auth.password) return json(res, 400, { error: '请填写密码' });
    if (authType === 'key' && !entry.auth.keyPath) return json(res, 400, { error: '请填写私钥路径' });
    const probe = await probeHost(entry);
    if (!probe.ok) return json(res, 400, { error: '连接失败：' + probe.err });
    list.push(entry);
    saveHosts(list);
    hostCache.delete(entry.id);
    return json(res, 200, { ok: true, host: maskHost(entry) });
  }
  if (p === '/api/hosts/delete' && req.method === 'POST') {
    const b = await readBody(req);
    const id = String(b.id || '');
    if (!id || id === 'local') return json(res, 400, { error: '本机不能从列表里删除' });
    const list = loadHosts().filter((h) => h.id !== id);
    saveHosts(list);
    hostCache.delete(id);
    remotePrev.delete(id);
    return json(res, 200, { ok: true });
  }
  if (p === '/api/hosts/test' && req.method === 'POST') {
    const b = await readBody(req);
    const h = findHost(String(b.id || ''));
    if (!h) return json(res, 404, { error: '主机不存在' });
    const r = await hostSummary(h);
    return json(res, 200, r);
  }
  if (p === '/api/hertz') return json(res, 200, { ok: true });

      return json(res, 404, { ok: false, err: '未知接口' });
    }

    serveStatic(req, res, p);
  } catch (e) {
    console.error('[panel] handler error:', e && e.stack ? e.stack : e);
    if (!res.headersSent) json(res, 500, { ok: false, err: String((e && e.message) || e) });
    else try { res.end(); } catch (_) {}
  }
});

server.on('upgrade', (req, socket, head) => {
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname !== '/ws') { socket.destroy(); return; }
  if (!sessionOf(req)) {
    socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
    socket.destroy();
    return;
  }
  wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
});

// 预热采集（让第一帧就有进程/服务/磁盘数据）
setTimeout(() => {
  try { topProcs(); dfDisk(); listServices(); } catch (e) { /* ignore */ }
}, 200);

server.listen(CONF.port, CONF.host, () => {
  console.log(`[panel] listening on ${CONF.host}:${CONF.port}  user=${CONF.user}  web=${CONF.webDir}`);
});
