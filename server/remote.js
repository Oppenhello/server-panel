/**
 * 远程文件管理（SFTP）
 * ------------------------------------------------------------------
 * 面板对「本机」走 fs.readFile 等原生调用；对 SSH 主机走这里：
 * ssh2 的 SFTP 子系统，走的是 SSH 通道里的 sftp 协议，不需要目标机装任何东西。
 *
 * 统一返回 { ok, ... } / 抛 Error，错误信息会原样显示在面板上。
 */
'use strict';

const fs = require('fs');
const path = require('path');

const DENY = ['/proc', '/sys', '/dev', '/run'];
const MAX_READ = 2 * 1024 * 1024;
const MAX_WRITE = 8 * 1024 * 1024;
const BACKUP_DIR = '/var/backups/server-panel';

let Client;
function ssh2() {
  if (Client === undefined) {
    try { Client = require('ssh2').Client; } catch (e) { Client = null; }
  }
  return Client;
}

function errText(e) {
  const raw = String((e && e.message) || e || '');
  if (/authentication methods failed|All configured/i.test(raw)) return '认证失败（账号或密码错误）';
  if (/ECONNREFUSED/i.test(raw)) return '端口拒绝连接';
  if (/ETIMEDOUT|timed out|Timeout/i.test(raw)) return '连接超时（检查端口与防火墙）';
  if (/ENOTFOUND|getaddrinfo/i.test(raw)) return '域名解析失败';
  if (/EHOSTUNREACH|ENETUNREACH/i.test(raw)) return '无法到达该主机';
  if (/ENOENT/i.test(raw)) return '私钥文件不存在';
  if (/Permission denied/i.test(raw)) return '权限不足（该账号不能写这个位置）';
  if (/No such file/i.test(raw)) return '路径不存在';
  return raw.slice(0, 160) || 'SSH 操作失败';
}

function guard(p) {
  if (!p || typeof p !== 'string') throw new Error('路径不能为空');
  if (p[0] !== '/') throw new Error('请使用绝对路径');
  const norm = path.posix.normalize(p);
  for (const d of DENY) {
    if (norm === d || norm.startsWith(d + '/')) throw new Error('该目录不允许访问（' + d + '）');
  }
  return norm;
}

function cfgOf(h, timeout) {
  const cfg = {
    host: h.host,
    port: Number(h.port) || 22,
    username: h.user,
    readyTimeout: Math.min(10000, timeout || 9000),
  };
  const auth = h.auth || {};
  if (auth.type === 'password') { cfg.password = auth.password || ''; cfg.tryKeyboard = true; }
  else if (auth.type === 'key' && auth.keyPath) { cfg.privateKey = fs.readFileSync(auth.keyPath); }
  else throw new Error('该主机没有可用的登录凭据');
  return cfg;
}

/* 打开一个 SFTP 会话执行 fn(sftp)，结束后自动断开 */
function withSftp(h, fn, timeout) {
  const C = ssh2();
  if (!C) return Promise.reject(new Error('服务器缺少 ssh2 依赖，无法使用远程文件管理'));
  return new Promise((resolve, reject) => {
    let conn;
    try { conn = new C(); } catch (e) { return reject(new Error(errText(e))); }
    let done = false;
    const finish = (err, val) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try { conn.end(); } catch (e) { /* ignore */ }
      if (err) reject(err instanceof Error ? err : new Error(String(err)));
      else resolve(val);
    };
    const timer = setTimeout(() => finish(new Error('SFTP 超时')), timeout || 20000);
    conn.on('ready', () => {
      conn.sftp((err, sftp) => {
        if (err) return finish(new Error('对端 SFTP 不可用：' + errText(err)));
        Promise.resolve(fn(sftp)).then((v) => finish(null, v), (e) => finish(e));
      });
    });
    conn.on('error', (e) => finish(new Error(errText(e))));
    try { conn.connect(cfgOf(h, timeout)); } catch (e) { finish(new Error(errText(e))); }
  });
}

const call = (sftp, method, ...args) => new Promise((res, rej) => {
  sftp[method](...args, (err, v) => (err ? rej(new Error(errText(err))) : res(v)));
});

const statOrNull = (sftp, p) => new Promise((res) => {
  sftp.stat(p, (err, st) => res(err ? null : st));
});

function join(dir, name) {
  return (dir === '/' ? '' : dir.replace(/\/+$/, '')) + '/' + name;
}

function parentOf(p) {
  if (p === '/') return '/';
  const i = p.replace(/\/+$/, '').lastIndexOf('/');
  return i <= 0 ? '/' : p.slice(0, i);
}

/* ---------------- 列表 ---------------- */
async function list(h, dir) {
  const d = guard(dir || '/');
  return withSftp(h, async (sftp) => {
    const list = await call(sftp, 'readdir', d);
    const entries = list
      .filter((it) => it.filename !== '.' && it.filename !== '..')
      .map((it) => ({
        name: it.filename,
        path: join(d, it.filename),
        dir: it.attrs.isDirectory(),
        size: it.attrs.size,
        mtime: (it.attrs.mtime || 0) * 1000,
        mode: modeString(it.attrs.mode, it.attrs.isDirectory(), it.attrs.isSymbolicLink()),
        link: it.attrs.isSymbolicLink(),
        hidden: it.filename[0] === '.',
      }))
      .sort((a, b) => (a.dir === b.dir ? a.name.localeCompare(b.name) : a.dir ? -1 : 1));
    return { ok: true, dir: d, parent: parentOf(d), entries, count: entries.length, remote: true };
  });
}

/* 权限位：与 Linux ls -l 一致 */
function modeString(mode, isDir, isLink) {
  if (!mode) return isDir ? 'drwxr-xr-x' : '-rw-r--r--';
  const t = isDir ? 'd' : isLink ? 'l' : '-';
  const bits = ['r', 'w', 'x'];
  let s = t;
  for (let shift = 6; shift >= 0; shift -= 3) {
    const v = (mode >> shift) & 7;
    s += (v & 4 ? 'r' : '-') + (v & 2 ? 'w' : '-') + (v & 1 ? 'x' : '-');
  }
  return s;
}

/* ---------------- 读取 ---------------- */
async function read(h, file) {
  const p = guard(file);
  return withSftp(h, async (sftp) => {
    const st = await statOrNull(sftp, p);
    if (!st) throw new Error('文件不存在');
    if (st.isDirectory()) throw new Error('这是一个目录');
    if (st.size > MAX_READ) throw new Error('文件太大（' + (st.size / 1048576).toFixed(1) + ' MB），超过 2 MB 限制，请下载后查看');
    const buf = await call(sftp, 'readFile', p);
    if (buf.includes(0)) throw new Error('这是一个二进制文件，无法在页面中编辑');
    return {
      ok: true, path: p, size: buf.length, mtime: (st.mtime || 0) * 1000,
      mode: modeString(st.mode, false, false), content: buf.toString('utf8'), remote: true,
    };
  });
}

/* ---------------- 写入（带 mtime 冲突检测 + 备份） ---------------- */
async function write(h, file, content, expectMtime) {
  const p = guard(file);
  const text = String(content == null ? '' : content);
  if (Buffer.byteLength(text, 'utf8') > MAX_WRITE) throw new Error('内容超过 8 MB，拒绝写入');
  return withSftp(h, async (sftp) => {
    const st = await statOrNull(sftp, p);
    if (st && Number(expectMtime) > 0) {
      const cur = (st.mtime || 0) * 1000;
      if (Math.abs(cur - Number(expectMtime)) > 1000) {
        const e = new Error('文件已被别处修改，请重新打开再改');
        e.code = 'ECONFLICT';
        throw e;
      }
    }
    let backup = null;
    if (st && st.size > 0 && st.size <= MAX_READ) {
      try {
        const old = await call(sftp, 'readFile', p);
        if (!old.includes(0)) {
          const stamp = new Date().toISOString().replace(/[:.]/g, '-');
          const dir = BACKUP_DIR + '/' + stamp;
          await mkdirp(sftp, dir).catch(() => {});
          const bak = dir + '/' + p.replace(/\//g, '__');
          await call(sftp, 'writeFile', bak, old);
          backup = bak;
        }
      } catch (e) { /* 备份失败不阻塞写入 */ }
    }
    await call(sftp, 'writeFile', p, Buffer.from(text, 'utf8'));
    const st2 = await statOrNull(sftp, p);
    return { ok: true, path: p, size: Buffer.byteLength(text, 'utf8'), mtime: ((st2 && st2.mtime) || 0) * 1000, backup };
  });
}

async function mkdirp(sftp, dir) {
  const parts = dir.split('/').filter(Boolean);
  let cur = '';
  for (const seg of parts) {
    cur += '/' + seg;
    const st = await statOrNull(sftp, cur);
    if (!st) await call(sftp, 'mkdir', cur).catch(() => {});
  }
}

/* ---------------- 目录 / 新建 / 改名 / 删除 ---------------- */
async function mkdir(h, dir) {
  const p = guard(dir);
  return withSftp(h, async (sftp) => {
    if (await statOrNull(sftp, p)) throw new Error('同名文件或目录已存在');
    await call(sftp, 'mkdir', p);
    return { ok: true, path: p };
  });
}

async function create(h, file) {
  const p = guard(file);
  return withSftp(h, async (sftp) => {
    if (await statOrNull(sftp, p)) throw new Error('同名文件已存在');
    await call(sftp, 'writeFile', p, Buffer.alloc(0));
    return { ok: true, path: p };
  });
}

async function rename(h, from, to) {
  const a = guard(from);
  const b = guard(to);
  return withSftp(h, async (sftp) => {
    if (await statOrNull(sftp, b)) throw new Error('目标已存在：' + b);
    await call(sftp, 'rename', a, b);
    return { ok: true, from: a, to: b };
  });
}

async function remove(h, file, recursive) {
  const p = guard(file);
  if (p === '/') throw new Error('不能删除根目录');
  return withSftp(h, async (sftp) => {
    const st = await statOrNull(sftp, p);
    if (!st) throw new Error('路径不存在');
    if (!st.isDirectory()) { await call(sftp, 'unlink', p); return { ok: true, path: p }; }
    const kids = await call(sftp, 'readdir', p);
    const real = kids.filter((k) => k.filename !== '.' && k.filename !== '..');
    if (real.length && !recursive) throw new Error('目录非空，需要勾选递归删除');
    for (const k of real) {
      const child = join(p, k.filename);
      if (k.attrs.isDirectory()) await removeVia(sftp, child);
      else await call(sftp, 'unlink', child);
    }
    await call(sftp, 'rmdir', p);
    return { ok: true, path: p };
  });
}

async function removeVia(sftp, p) {
  const st = await statOrNull(sftp, p);
  if (!st) return;
  if (!st.isDirectory()) return call(sftp, 'unlink', p);
  const kids = await call(sftp, 'readdir', p);
  for (const k of kids) {
    if (k.filename === '.' || k.filename === '..') continue;
    await removeVia(sftp, join(p, k.filename));
  }
  await call(sftp, 'rmdir', p);
}

/* ---------------- 上传 / 下载 ---------------- */
async function upload(h, dir, name, buffer) {
  const d = guard(dir);
  if (!name || /[\\/]/.test(name)) throw new Error('文件名不合法');
  const p = join(d, name);
  if (buffer.length > 32 * 1024 * 1024) throw new Error('远程上传单文件上限 32 MB');
  return withSftp(h, async (sftp) => {
    const tmp = join(d, '.' + name + '.sp-' + Date.now());
    await call(sftp, 'writeFile', tmp, buffer);
    if (await statOrNull(sftp, p)) await call(sftp, 'unlink', p).catch(() => {});
    await call(sftp, 'rename', tmp, p);
    return { ok: true, path: p, size: buffer.length };
  }, 60000);
}

function download(h, file, res) {
  const p = guard(file);
  return withSftp(h, async (sftp) => {
    const st = await statOrNull(sftp, p);
    if (!st) throw new Error('文件不存在');
    if (st.isDirectory()) throw new Error('不能下载目录');
    const name = p.split('/').pop();
    res.writeHead(200, {
      'Content-Type': 'application/octet-stream',
      'Content-Length': st.size,
      'Content-Disposition': "attachment; filename*=UTF-8''" + encodeURIComponent(name),
    });
    await new Promise((resolve, reject) => {
      const rs = sftp.createReadStream(p);
      rs.on('error', reject);
      rs.on('end', resolve);
      rs.pipe(res);
    });
    return { ok: true };
  }, 60000);
}

module.exports = { list, read, write, mkdir, create, rename, remove, upload, download, modeString };
