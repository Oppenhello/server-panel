/*
 * push-api.js —— 用 GitHub Git Data API 把当前目录的内容推成一个提交。
 *
 * 为什么不用 git push：本机 git 的 HTTPS 走到 github.com 会被重置
 * （Recv failure: Connection was reset），而 node 的 fetch 正常。
 *
 * 令牌来自 DSH 的 GitHub 连接器存储，只在进程内使用，不打印。
 *
 * 用法：node tools/push-api.js <owner/repo> "<commit message>" [branch]
 */
const fs = require('fs');
const path = require('path');

const REPO = process.argv[2];
const MESSAGE = process.argv[3] || 'V1.0.0';
const BRANCH = process.argv[4] || 'main';
if (!REPO || !REPO.includes('/')) {
  console.error('用法: node tools/push-api.js <owner/repo> "<message>" [branch]');
  process.exit(2);
}

const CONNECTOR = path.join(process.env.USERPROFILE || process.env.HOME, '.dsh', 'profiles', 'desktop', 'connector', 'github', 'github.json');
const TOKEN = JSON.parse(fs.readFileSync(CONNECTOR, 'utf8')).token;
if (!TOKEN) { console.error('连接器里没有 token'); process.exit(2); }

const API = 'https://api.github.com';
const ROOT = path.resolve(__dirname, '..');

/* 要排除的东西：.git、node_modules、构建产物 */
const SKIP_DIRS = new Set(['.git', 'node_modules', '.vscode']);
const SKIP_EXT = /\.(b64|tar\.gz|zip|log)$/i;

async function api(method, url, body) {
  const res = await fetch(API + url, {
    method,
    headers: {
      authorization: 'Bearer ' + TOKEN,
      accept: 'application/vnd.github+json',
      'x-github-api-version': '2022-11-28',
      'content-type': 'application/json',
      'user-agent': 'server-panel-release',
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = { raw: text }; }
  if (!res.ok) {
    const msg = (data && (data.message || data.raw)) || res.statusText;
    const err = new Error(`${method} ${url} -> ${res.status}: ${msg}`);
    err.status = res.status;
    err.data = data;
    throw err;
  }
  return data;
}

function walk(dir, base = '') {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name.startsWith('.') && e.name !== '.gitignore') continue;
    const full = path.join(dir, e.name);
    const rel = base ? base + '/' + e.name : e.name;
    if (e.isDirectory()) {
      if (SKIP_DIRS.has(e.name)) continue;
      out.push(...walk(full, rel));
    } else if (e.isFile()) {
      if (SKIP_EXT.test(e.name)) continue;
      out.push({ rel, full });
    }
  }
  return out.sort((a, b) => a.rel.localeCompare(b.rel));
}

(async () => {
  const files = walk(ROOT);
  console.log(`仓库: ${REPO}  分支: ${BRANCH}  文件: ${files.length}`);

  /* 0) 空仓库无法建 blob（409 Git Repository is empty）→ 先用 Contents API 造一个初始提交 */
  let bootstrapped = false;
  try {
    await api('GET', `/repos/${REPO}/git/ref/heads/${BRANCH}`);
  } catch (e) {
    if (e.status !== 404 && e.status !== 409) throw e;
    await api('PUT', `/repos/${REPO}/contents/.bootstrap`, {
      message: 'chore: bootstrap',
      content: Buffer.from('bootstrap\n').toString('base64'),
      branch: BRANCH,
    });
    bootstrapped = true;
    console.log('   空仓库：已用 Contents API 建立初始提交');
  }

  /* 1) 逐个建 blob */
  const entries = [];
  for (const f of files) {
    const buf = fs.readFileSync(f.full);
    const blob = await api('POST', `/repos/${REPO}/git/blobs`, {
      content: buf.toString('base64'),
      encoding: 'base64',
    });
    entries.push({ path: f.rel, mode: '100644', type: 'blob', sha: blob.sha });
    process.stdout.write('.');
  }
  console.log(`\n✅ ${entries.length} 个 blob`);

  /* 2) 建 tree（不带 base_tree = 全新树） */
  const tree = await api('POST', `/repos/${REPO}/git/trees`, { tree: entries });
  console.log(`✅ tree ${tree.sha.slice(0, 10)}`);

  /* 3) 建 commit（若分支已存在则带父提交） */
  let parents = [];
  try {
    const ref = await api('GET', `/repos/${REPO}/git/ref/heads/${BRANCH}`);
    parents = [ref.object.sha];
    console.log(`   分支已存在，基于 ${ref.object.sha.slice(0, 10)}`);
  } catch (e) {
    if (e.status !== 404) throw e;
    console.log('   新建分支');
  }
  const commit = await api('POST', `/repos/${REPO}/git/commits`, {
    message: MESSAGE,
    tree: tree.sha,
    parents,
  });
  console.log(`✅ commit ${commit.sha.slice(0, 10)}`);

  /* 4) 更新/创建 ref */
  if (parents.length) {
    await api('PATCH', `/repos/${REPO}/git/refs/heads/${BRANCH}`, { sha: commit.sha, force: true });
  } else {
    await api('POST', `/repos/${REPO}/git/refs`, { ref: `refs/heads/${BRANCH}`, sha: commit.sha });
  }

  /* 5) 校验 */
  const repo = await api('GET', `/repos/${REPO}`);
  const head = await api('GET', `/repos/${REPO}/commits/${BRANCH}`);
  console.log('');
  console.log('仓库:', repo.html_url);
  console.log('可见性:', repo.private ? 'private' : 'public');
  console.log('默认分支:', repo.default_branch);
  console.log('HEAD:', head.sha, '·', head.commit.message.split('\n')[0]);
  console.log('文件数(HEAD tree):', head.commit.tree.sha);
  console.log('PASS');
})().catch((e) => {
  console.error('\nFAIL:', e.message);
  process.exit(1);
});
