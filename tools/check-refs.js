'use strict';
/* 检查 app.js 里用到的 DOM id 是否都在 index.html 里存在 */
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'web/index.html'), 'utf8');
const js = fs.readFileSync(path.join(root, 'web/app.js'), 'utf8');

const htmlIds = new Set();
for (const m of html.matchAll(/\bid="([^"]+)"/g)) htmlIds.add(m[1]);

const used = new Set();
for (const m of js.matchAll(/\$\('([^']+)'\)/g)) used.add(m[1]);
for (const m of js.matchAll(/getElementById\('([^']+)'\)/g)) used.add(m[1]);

/* $(prefix + '-size') 这类动态 id：把「以 -size 结尾」的 id 视为已引用 */
const dynamicSuffix = new Set();
for (const m of js.matchAll(/\$\s*\(\s*[A-Za-z_$][\w$]*\s*\+\s*'(-[\w-]+)'/g)) dynamicSuffix.add(m[1]);
if (dynamicSuffix.size) {
  for (const id of htmlIds) {
    for (const suf of dynamicSuffix) if (id.endsWith(suf)) used.add(id);
  }
}

const missing = [...used].filter((id) => !htmlIds.has(id));
const unusedInJs = [...htmlIds].filter((id) => !used.has(id));

console.log('index.html id 数:', htmlIds.size);
console.log('app.js 引用 id 数:', used.size);
if (missing.length) {
  console.log('❌ 缺少的 id:', missing.join(', '));
} else {
  console.log('✅ app.js 引用的 id 全部存在');
}
if (unusedInJs.length) console.log('ℹ app.js 未直接引用（可能被 CSS/动态使用）:', unusedInJs.join(', '));

/* 回归守卫：[hidden] 必须能压过 .login-wrap/.modal 的 display:grid，
   否则登录成功后遮罩不消失（真踩过这个坑） */
const css = fs.readFileSync(path.join(root, 'web/style.css'), 'utf8');

/* v19 守卫：取消 v10 的「两栏强行等高」，改为各自滚动区。
   进程表与服务列表必须各有 max-height，否则长列表会把页面撑垮；
   同时 .split 不能再出现固定的 420px 假等高。 */
const listOk =
  /\.table-wrap\s*\{[^}]*max-height/is.test(css) &&
  /\.svc-list\s*\{[^}]*max-height/is.test(css);
console.log(listOk ? '✅ 进程表 / 服务列表各自有 max-height 滚动区' : '❌ 缺少 .table-wrap / .svc-list 的 max-height');
if (!listOk) missing.push('.table-wrap / .svc-list 的 max-height');

const fakeEqual = /\.split\s*>\s*\.panel\s*\{[^}]*height:\s*420px/is.test(css);
console.log(fakeEqual ? '❌ 仍残留 420px 假等高' : '✅ 已移除 420px 假等高');
if (fakeEqual) missing.push('420px 假等高残留');

const guard = /\[hidden\]\s*\{[^}]*display\s*:\s*none\s*!important/i.test(css);
console.log(guard ? '✅ [hidden]{display:none!important} 存在' : '❌ 缺少 [hidden] 强制隐藏规则');
if (!guard) missing.push('[hidden] CSS 规则');

/* v12 守卫：#tip 浮层节点必须排在 <script> 之前。
   app.js 是同步脚本，节点排在脚本后面时 document.getElementById('tip') 是 null，
   所有 hover 提示都会因为异常而失效（真踩过）。 */
const tipAt = html.indexOf('id="tip"');
const scriptAt = html.indexOf('src="./app.js');
const tipOrder = tipAt > 0 && scriptAt > 0 && tipAt < scriptAt;
console.log(tipOrder ? '✅ #tip 节点在脚本之前（hover 提示可初始化）' : '❌ #tip 节点排在脚本之后，hover 提示会失效');
if (!tipOrder) missing.push('#tip 必须排在 app.js 之前');

/* 顺带检查静态资源引用 */
const refs = [...html.matchAll(/(?:href|src)="([^"]+)"/g)].map((m) => m[1])
  .filter((s) => !/^https?:/.test(s));
let bad = 0;
for (const r of refs) {
  const clean = r.split('?')[0].replace(/^\.\//, '');
  const f = path.join(root, 'web', clean);
  if (!fs.existsSync(f)) { console.log('❌ 资源不存在:', r); bad++; }
}
console.log(bad ? `❌ 有 ${bad} 个资源缺失` : `✅ ${refs.length} 个本地资源都存在`);

process.exit(missing.length || bad ? 1 : 0);
