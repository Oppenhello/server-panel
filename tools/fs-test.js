// 文件管理接口的线上验收：登录 → 列表 → 读 → 写 → 冲突 → 上传 → 下载 → 删除
// 用法: node tools/fs-test.js http://127.0.0.1:3100 admin <PASS>
const BASE = process.argv[2] || 'http://127.0.0.1';
const USER = process.argv[3] || 'admin';
const PASS = process.argv[4] || '';
const TMP = '/tmp/sp-fs-test';
let cookie = '';

const fails = [];
function ok(cond, msg) { if (!cond) fails.push(msg); console.log((cond ? '  ✅ ' : '  ❌ ') + msg); }

async function api(path, opt) {
  const o = Object.assign({ headers: {} }, opt || {});
  if (cookie) o.headers.Cookie = cookie;
  if (o.json !== undefined) {
    o.headers['Content-Type'] = 'application/json';
    o.body = JSON.stringify(o.json);
    o.method = o.method || 'POST';
    delete o.json;
  }
  const r = await fetch(BASE + path, o);
  const sc = r.headers.get('set-cookie');
  if (sc) cookie = sc.split(';')[0];
  let j = null;
  try { j = await r.json(); } catch (e) { j = null; }
  return { status: r.status, j, r };
}

(async () => {
  console.log('==> ' + BASE);

  let r = await api('/api/login', { json: { user: USER, pass: PASS } });
  ok(r.status === 200 && r.j && r.j.ok, '登录成功');
  if (!cookie) { console.log('登录失败，终止'); process.exit(1); }

  // 列表
  r = await api('/api/fs/list?dir=/etc');
  ok(r.j && r.j.ok && r.j.count > 10, '列出 /etc（' + (r.j && r.j.count) + ' 项）');
  const hasHostname = r.j && r.j.entries.some((e) => e.name === 'hostname');
  ok(hasHostname, '/etc 里能看到 hostname');
  const hostEntry = r.j && r.j.entries.find((e) => e.name === 'hostname');
  ok(hostEntry && /^[-dlbcps][rwxsStT-]{9}$/.test(hostEntry.mode), '权限为符号位：' + (hostEntry && hostEntry.mode));
  const dirEntry = r.j && r.j.entries.find((e) => e.dir);
  ok(!dirEntry || /^d/.test(dirEntry.mode), '目录权限以 d 开头：' + (dirEntry && dirEntry.mode));

  // 读
  r = await api('/api/fs/read?path=/etc/hostname');
  ok(r.j && r.j.ok && r.j.content.length > 0, '读取 /etc/hostname（' + (r.j && r.j.size) + ' 字节）');

  // 越权目录
  r = await api('/api/fs/list?dir=/proc');
  ok(r.status === 400, '拒绝访问 /proc（HTTP ' + r.status + '）');

  // 新建 + 写 + 读回
  r = await api('/api/fs/create', { json: { path: TMP + '.conf' } });
  const created = r.j && r.j.ok;
  ok(created || (r.j && /已存在/.test(r.j.err || '')), '创建测试文件：' + (created ? '新建成功' : '已存在（沿用）'));

  r = await api('/api/fs/write', { json: { path: TMP + '.conf', content: 'a = 1\nb = 2\n' } });
  ok(r.j && r.j.ok, '写入 18 字节内容');
  const mtime1 = r.j && r.j.mtime;

  r = await api('/api/fs/read?path=' + encodeURIComponent(TMP + '.conf'));
  ok(r.j && r.j.content === 'a = 1\nb = 2\n', '读回内容一致');

  // 冲突检测：拿旧 mtime 再写
  r = await api('/api/fs/write', { json: { path: TMP + '.conf', content: 'x', mtime: (mtime1 || 0) - 5000 } });
  ok(r.status === 409 && r.j && r.j.conflict === true, '旧 mtime 写入被判定为冲突（409）');

  // 上传
  const up = await api('/api/fs/upload?dir=/tmp&name=sp-up-test.txt', { method: 'POST', body: 'hello upload' });
  ok(up.j && up.j.ok, '上传 12 字节文件');

  // 下载
  const dl = await fetch(BASE + '/api/fs/download?path=' + encodeURIComponent('/tmp/sp-up-test.txt'), { headers: cookie ? { Cookie: cookie } : {} });
  const text = await dl.text();
  ok(dl.status === 200 && text === 'hello upload', '下载内容与上传一致');
  ok((dl.headers.get('content-disposition') || '').includes('attachment'), '下载响应带 attachment');

  // 删
  r = await api('/api/fs/delete', { json: { path: TMP + '.conf' } });
  ok(r.j && r.j.ok, '删除测试文件');
  r = await api('/api/fs/delete', { json: { path: '/tmp/sp-up-test.txt' } });
  ok(r.j && r.j.ok, '删除上传文件');

  // 目录
  r = await api('/api/fs/mkdir', { json: { path: '/tmp/sp-dir-test' } });
  const mk = r.j && r.j.ok;
  ok(mk || /已存在/.test((r.j && r.j.err) || ''), '创建测试目录');
  r = await api('/api/fs/delete', { json: { path: '/tmp/sp-dir-test', recursive: true } });
  ok(r.j && r.j.ok, '删除测试目录');

  // 电源 / 命令接口应已消失
  r = await api('/api/power', { json: { action: 'reboot', confirm: 'x' } });
  ok(r.status === 404, '电源接口已移除（404）');

  console.log(fails.length ? '\n[fs] FAIL ❌\n  - ' + fails.join('\n  - ') : '\n[fs] PASS ✅');
  process.exit(fails.length ? 1 : 0);
})().catch((e) => { console.error('异常：', e); process.exit(1); });
