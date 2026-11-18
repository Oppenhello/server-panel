/* 设计系统收敛度度量：统计 web/style.css 的间距/字号/颜色字面量/重复定义。
   可选参数：改造前的对照文件（默认 design/before/style.css，不存在则只打印当前值）。 */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const CUR = path.join(ROOT, 'web/style.css');

function stats(p) {
  const s = fs.readFileSync(p, 'utf8');
  const lines = s.split('\n').length;
  const hard = (s.match(/rgba\(255,\s*255,\s*255/g) || []).length;
  const hexes = new Set((s.match(/#[0-9a-fA-F]{3,8}\b/g) || []).map((x) => x.toLowerCase()));
  const px = (s.match(/(?:padding|margin|gap|row-gap|column-gap)\s*:\s*([^;}]+)/g) || [])
    .flatMap((d) => (d.match(/\b\d+(?:\.\d+)?px\b/g) || []));
  const vals = new Set(px);
  const fsz = new Set((s.match(/font-size\s*:\s*([^;}]+)/g) || []).map((x) => x.split(':')[1].trim()));
  const rads = new Set((s.match(/border-radius\s*:\s*([^;}]+)/g) || []).map((x) => x.split(':')[1].trim()));
  const dupFsRow = (s.match(/\.fs-row\s*\{/g) || []).length;
  const dupSplitPanel = (s.match(/\.split\s*>\s*\.panel\s*\{/g) || []).length;
  const vars = new Set((s.match(/--[a-z0-9-]+\s*:/g) || []).map((x) => x.replace(/\s*:$/, '')));
  const important = (s.match(/!important/g) || []).length;
  return {
    lines, hard, hex: hexes.size, spacingVals: vals.size,
    spacing: [...vals].sort((a, b) => parseFloat(a) - parseFloat(b)).join(' '),
    fontSizes: fsz.size, radiusDefs: rads.size, dupFsRow, dupSplitPanel,
    vars: vars.size, important,
  };
}

const cur = stats(CUR);
const beforePath = process.argv[2] || path.join(ROOT, 'design/before/style.css');

if (!fs.existsSync(beforePath)) {
  console.log('[css] 当前 web/style.css');
  console.log('  行数            ', cur.lines);
  console.log('  间距取值种类    ', cur.spacingVals, '→', cur.spacing);
  console.log('  字号声明种类    ', cur.fontSizes);
  console.log('  圆角声明种类    ', cur.radiusDefs);
  console.log('  十六进制色值种类', cur.hex);
  console.log('  CSS 变量个数    ', cur.vars);
  console.log('  .fs-row 定义    ', cur.dupFsRow, '  .split > .panel 定义', cur.dupSplitPanel);
  console.log('\n（没有对照文件，只打印当前值；传一个旧版 css 路径即可对比）');
  process.exit(0);
}

const a = stats(beforePath);
const rows = [
  ['行数', a.lines, cur.lines],
  ['硬编码 rgba(255,255,255,…) 次数', a.hard, cur.hard],
  ['十六进制色值种类', a.hex, cur.hex],
  ['间距取值种类', a.spacingVals, cur.spacingVals],
  ['字号声明种类', a.fontSizes, cur.fontSizes],
  ['圆角声明种类', a.radiusDefs, cur.radiusDefs],
  ['.fs-row 重复定义', a.dupFsRow, cur.dupFsRow],
  ['.split > .panel 重复定义', a.dupSplitPanel, cur.dupSplitPanel],
  ['CSS 变量个数', a.vars, cur.vars],
  ['!important 次数', a.important, cur.important],
];
console.log('指标                            改造前  →  当前');
for (const [k, x, y] of rows) console.log(String(k).padEnd(30, ' '), String(x).padStart(6), ' → ', y);
console.log('\n当前间距取值:', cur.spacing);
