/* v18 远程文件管理 + 远程网卡速率 的线上验收 */
const http = require('http');

const BASE = process.argv[2] || 'http://127.0.0.1';
const USER = process.argv[3] || 'admin';
const PASS = process.argv[4] || '';
const KEYPATH = process.argv[5] || '/tmp/spk';

let cookie = '';
let pass = 0, fail = 0;

function req(method, path, body, raw) {
  return new Promise((resolve, reject) => {
    const u = new URL(BASE + path);
    const data = body === undefined ? null : (raw ? body : Buffer.from(JSON.stringify(body)));
    const opt = {
      method, hostname: u.hostname, port: u.port, path: u.pathname + u.search,
      headers: Object.assign({}, cookie ? { Cookie: cookie } : {}, data ? { 'Content-Type': raw ? 'application/octet-stream' : 'application/json', 'Content-Length': data.length } : {}),
    };
    const r = http.request(opt, (res) => {
      const sc = res.headers['set-cookie'];
      if (sc) cookie = sc.map((s) => s.split(';')[0]).join('; ');
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const buf = Buffer.concat(chunks);
        let j = null;
        try { j = JSON.parse(buf.toString('utf8')); } catch (e) { j = { _raw: buf.toString('utf8').slice(0, 200) }; }
        resolve({ code: res.statusCode, body: j, headers: res.headers, buf });
      });
    });
    r.on('error', reject);
    if (data) r.write(data);
    r.end();
  });
}

const ok = (name, cond, extra) => {
  if (cond) { pass++; console.log('  ✅ ' + name); }
  else { fail++; console.log('  ❌ ' + name + (extra ? ' → ' + JSON.stringify(extra) : '')); }
};

(async () => {
  console.log('== 远程文件管理 / 网卡速率 ==');

  let r = await req('POST', '/api/login', { user: USER, pass: PASS });
  ok('登录', r.code === 200 && r.body.ok);

  /* 临时自检主机（127.0.0.1，密钥登录） */
  r = await req('POST', '/api/hosts/add', {
    name: 'SFTP 自检', host: '127.0.0.1', port: 22, user: 'root',
    authType: 'key', keyPath: KEYPATH,
  });
  ok('添加自检主机（含 SSH 试连）', r.code === 200 && r.body.ok, r.body);
  const hid = r.body.id || (r.body.host && r.body.host.id);
  if (!hid) { console.log('无法拿到主机 id，中止'); process.exit(1); }

  r = await req('GET', '/api/state?host=' + encodeURIComponent(hid));
  const st = r.body || {};
  ok('远程 state 有网卡速率字段', st.net && st.net.rate && typeof st.net.rate.rx === 'number' && typeof st.net.total.tx === 'number', st.net);
  ok('远程 state 有进程/服务', Array.isArray(st.procs) && st.procs.length > 0 && Array.isArray(st.services) && st.services.length > 0,
     { procs: (st.procs || []).length, svc: (st.services || []).length });

  /* 等一轮，验证速率差分能出非零或至少不 NaN */
  await new Promise((s) => setTimeout(s, 2500));
  r = await req('GET', '/api/state?host=' + encodeURIComponent(hid));
  const rate2 = (r.body.net && r.body.net.rate) || {};
  ok('网卡速率数值有效（非 NaN）', Number.isFinite(rate2.rx) && Number.isFinite(rate2.tx), rate2);

  /* 文件管理 */
  const dir = '/tmp/panel-sftp-test';
  r = await req('GET', '/api/fs/list?dir=/etc&host=' + encodeURIComponent(hid));
  ok('远程列目录 /etc', r.code === 200 && r.body.ok && r.body.entries.length > 50, { code: r.code, n: (r.body.entries || []).length, err: r.body.err });

  r = await req('GET', '/api/fs/read?path=/etc/hostname&host=' + encodeURIComponent(hid));
  ok('远程读文件 /etc/hostname', r.code === 200 && r.body.ok && /^iZ|^[a-zA-Z0-9-]+/.test(String(r.body.content).trim()), { code: r.code, err: r.body.err });

  r = await req('GET', '/api/fs/list?dir=/proc&host=' + encodeURIComponent(hid));
  ok('远程 /proc 被拒', r.code === 400 && /不允许访问/.test(String(r.body.err)), { code: r.code, err: r.body.err });

  r = await req('POST', '/api/fs/mkdir', { path: dir, host: hid });
  ok('远程新建目录', r.code === 200 && r.body.ok, r.body);

  r = await req('POST', '/api/fs/create', { path: dir + '/note.txt', host: hid });
  ok('远程新建文件', r.code === 200 && r.body.ok, r.body);

  r = await req('POST', '/api/fs/write', { path: dir + '/note.txt', content: 'hello sftp\n第二行\n', host: hid });
  ok('远程写入文本', r.code === 200 && r.body.ok, r.body);
  const mtime = r.body.mtime;

  r = await req('GET', '/api/fs/read?path=' + encodeURIComponent(dir + '/note.txt') + '&host=' + encodeURIComponent(hid));
  ok('远程读回内容一致', r.code === 200 && String(r.body.content).includes('第二行'), { code: r.code, c: r.body.content, err: r.body.err });
  ok('远程权限为符号位', /^-[r-][w-][x-]/.test(String(r.body.mode)), r.body.mode);

  r = await req('POST', '/api/fs/write', { path: dir + '/note.txt', content: 'stale\n', mtime: (mtime || 1) - 5000, host: hid });
  ok('远程旧 mtime → 409', r.code === 409 && r.body.conflict === true, { code: r.code, err: r.body.err });

  r = await req('POST', '/api/fs/rename', { from: dir + '/note.txt', to: dir + '/note2.txt', host: hid });
  ok('远程改名', r.code === 200 && r.body.ok, r.body);

  const payload = Buffer.from('binary-payload-' + Date.now());
  r = await req('POST', '/api/fs/upload?dir=' + encodeURIComponent(dir) + '&name=blob.bin&host=' + encodeURIComponent(hid), payload, true);
  ok('远程上传二进制', r.code === 200 && r.body.ok, r.body);

  r = await req('GET', '/api/fs/download?path=' + encodeURIComponent(dir + '/blob.bin') + '&host=' + encodeURIComponent(hid));
  ok('远程下载内容一致', r.code === 200 && r.buf.equals(payload), { code: r.code, len: r.buf.length, err: r.body.err });
  ok('下载带 attachment 头', /attachment/.test(String(r.headers['content-disposition'] || '')));

  r = await req('POST', '/api/fs/delete', { path: dir + '/note2.txt', host: hid });
  ok('远程删除文件', r.code === 200 && r.body.ok, r.body);

  r = await req('POST', '/api/fs/delete', { path: dir, recursive: true, host: hid });
  ok('远程递归删除目录', r.code === 200 && r.body.ok, r.body);

  /* 清理 */
  r = await req('POST', '/api/hosts/delete', { id: hid });
  ok('删除自检主机', r.code === 200 && r.body.ok, r.body);

  console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('异常:', e && e.message); process.exit(1); });
