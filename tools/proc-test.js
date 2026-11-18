// 进程结束接口验收：node tools/proc-test.js http://203.0.113.10 admin <PASS> <PID> <进程名>
const base = process.argv[2];
const user = process.argv[3];
const pass = process.argv[4];
const pid = Number(process.argv[5]);
const name = process.argv[6];

let cookie = '';
async function api(p, body) {
  const r = await fetch(base + p, {
    method: body === undefined ? 'GET' : 'POST',
    headers: Object.assign({ 'content-type': 'application/json' }, cookie ? { cookie } : {}),
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const sc = r.headers.get('set-cookie');
  if (sc) cookie = sc.split(';')[0];
  let j = null;
  try { j = await r.json(); } catch (e) { j = { err: 'non-json' }; }
  return { status: r.status, j };
}

const out = [];
const check = (cond, label, extra) => {
  out.push((cond ? '✅ ' : '❌ ') + label + (extra ? '  → ' + extra : ''));
  if (!cond) process.exitCode = 1;
};

(async function () {
  let r = await api('/api/login', { user, pass });
  check(r.j.ok, '登录成功');

  r = await api('/api/proc/kill', { pid: 1, name: 'systemd' });
  check(!r.j.ok && /无效/.test(r.j.err || ''), 'PID 1 应被拒绝', r.j.err);

  r = await api('/api/proc/kill', { pid: 999999, name: 'nope' });
  check(!r.j.ok && /不存在|无权/.test(r.j.err || ''), '不存在的 PID 应被拒绝', r.j.err);

  r = await api('/api/proc/kill', { pid: pid, name: 'definitely-wrong-name' });
  check(!r.j.ok && /复用/.test(r.j.err || ''), '名字不匹配应被拒绝（防 PID 复用误杀）', r.j.err);

  r = await api('/api/proc/kill', { pid: pid, name: name });
  check(r.j.ok && r.j.signal === 'SIGTERM', '正确 pid+name 应结束成功', JSON.stringify(r.j));

  await new Promise((s) => setTimeout(s, 400));
  r = await api('/api/proc/kill', { pid: pid, name: name });
  check(!r.j.ok, '进程已退出后再次结束应失败', r.j.err);

  r = await api('/api/proc/kill', { pid: -5, name: 'x' });
  check(!r.j.ok, '负数 PID 应被拒绝', r.j.err);

  console.log(out.join('\n'));
  console.log(process.exitCode ? '\n[proc] FAIL' : '\n[proc] PASS ✅');
})();
