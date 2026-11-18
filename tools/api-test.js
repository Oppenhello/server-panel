'use strict';
/* 接口级测试：服务控制 / 日志 / 电源拦截 / 非法输入
 * 用法: node tools/api-test.js <baseUrl> <user> <pass>
 */
const BASE = process.argv[2] || 'http://127.0.0.1:3199';
const USER = process.argv[3] || 'admin';
const PASS = process.argv[4] || 'devpass123';

let cookie = '';
let fails = 0;

function check(name, ok, extra) {
  if (!ok) fails++;
  console.log((ok ? '[OK]   ' : '[FAIL] ') + name + (extra ? '  ' + extra : ''));
}

async function call(path, body) {
  const opt = { headers: { Cookie: cookie } };
  if (body) {
    opt.method = 'POST';
    opt.headers['Content-Type'] = 'application/json';
    opt.body = JSON.stringify(body);
  }
  const r = await fetch(BASE + path, opt);
  let j = {};
  try { j = await r.json(); } catch (e) { j = { raw: await r.text() }; }
  return { status: r.status, body: j };
}

async function main() {
  const lr = await fetch(BASE + '/api/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ user: USER, pass: PASS }),
  });
  cookie = (lr.headers.get('set-cookie') || '').split(';')[0];
  const lj = await lr.json();
  check('login', lj.ok === true);
  if (!lj.ok) process.exit(1);

  /* 未登录必须被拒 */
  const anon = await fetch(BASE + '/api/state');
  check('未登录返回 401', anon.status === 401, 'status=' + anon.status);

  /* state 结构 */
  const st = await call('/api/state');
  const d = st.body;
  check('state 200', st.status === 200);
  check('state 有 host/cpu/mem/net/disk/services/procs',
    !!(d.host && d.cpu && d.mem && d.net && Array.isArray(d.disk) && Array.isArray(d.services) && Array.isArray(d.procs)));
  check('disk 非空', (d.disk || []).length > 0, JSON.stringify((d.disk || []).slice(0, 1)));
  check('services 非空', (d.services || []).length > 0, (d.services || []).length + ' 个');

  /* 两次 state 之间 CPU 应有差分 */
  await new Promise((r) => setTimeout(r, 1200));
  const st2 = await call('/api/state');
  check('CPU 采样有值', st2.body.cpu && typeof st2.body.cpu.pct === 'number', 'pct=' + (st2.body.cpu || {}).pct);

  /* 服务：reload nginx（安全）—— 放最后，因为 reload 会断掉 keep-alive 连接 */
  const sv = await call('/api/service', { unit: 'nginx.service', action: 'reload' });
  check('service reload nginx', sv.status === 200 && sv.body.ok === true, JSON.stringify(sv.body).slice(0, 100));

  /* 非法服务名 / 非法动作必须拒绝 */
  const badUnit = await call('/api/service', { unit: '../../etc/passwd', action: 'stop' });
  check('拦截非法服务名', badUnit.status === 400 && badUnit.body.ok === false, badUnit.body.err || '');
  const badAct = await call('/api/service', { unit: 'nginx.service', action: 'rm -rf' });
  check('拦截非法动作', badAct.status === 400 && badAct.body.ok === false, badAct.body.err || '');

  /* 日志 */
  const lg = await call('/api/logs', { unit: 'nginx.service', lines: 20 });
  check('logs 返回内容', lg.status === 200 && typeof lg.body.out === 'string' && lg.body.out.length > 0,
    (lg.body.out || '').length + ' 字符');

  /* v7 起电源与命令终端已移除：接口必须彻底不存在（404），不能只靠前端隐藏 */
  const pw = await call('/api/power', { action: 'reboot', confirm: 'definitely-wrong' });
  check('电源接口已移除', pw.status === 404, 'status=' + pw.status);

  /* 结束进程接口：PID 1 与不存在的 PID 必须拒绝 */
  const k1 = await call('/api/proc/kill', { pid: 1, name: 'systemd' });
  check('拒绝结束 PID 1', k1.status === 400 && k1.body.ok === false, k1.body.err || '');
  const k2 = await call('/api/proc/kill', { pid: 999999, name: 'nope' });
  check('拒绝不存在的 PID', k2.status === 400 && k2.body.ok === false, k2.body.err || '');

  console.log(fails ? `\n[api] FAIL ${fails} 项` : '\n[api] PASS ✅');
  process.exit(fails ? 1 : 0);
}

main().catch((e) => { console.error('[api] error', e); process.exit(1); });
