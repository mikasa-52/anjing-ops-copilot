#!/usr/bin/env node
/**
 * GitHub Pages 一键部署（走 REST API，不需要 git push）
 *
 * 背景：当前网络环境下 github.com 不可达，但 api.github.com 可用。
 *      因此用 Git Data API 提交文件、Pages API 开启托管。
 *
 * 用法：
 *   Windows CMD :  set GITHUB_TOKEN=ghp_xxx && node deploy.mjs
 *   PowerShell  :  $env:GITHUB_TOKEN="ghp_xxx"; node deploy.mjs
 *   Git Bash    :  GITHUB_TOKEN=ghp_xxx node deploy.mjs
 *
 * Token 权限（fine-grained）：Contents 读写 + Pages 读写 + Administration 读写（仅建仓时需要）
 * classic token 勾选 repo 即可。
 * Token 只在内存与环境变量中，本脚本不写入任何文件。
 *
 * 注意：Pages 只托管静态文件，AI 走预置答案；完整 AI 能力需本地 node server.js。
 */

import fs from 'node:fs';
import path from 'node:path';

const API = 'https://api.github.com';
const TOKEN = process.env.GITHUB_TOKEN || process.env.GH_TOKEN || '';
const REPO_NAME = process.env.REPO_NAME || 'anjing-ops-copilot';
const PAGES_PATH = '/docs'; // Pages 发布目录
const FILES = [
  'README.md',
  'server.js',
  '.env.example',
  '.gitignore',
  'DEMO-SCRIPT.md',
  'deploy.mjs',
  'docs/index.html',
  'docs/styles.css',
  'docs/app.js',
  'docs/data.js'
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

if (!TOKEN) {
  console.error('❌ 未检测到 GITHUB_TOKEN。');
  console.error('   Windows CMD: set GITHUB_TOKEN=ghp_xxx && node deploy.mjs');
  console.error('   生成地址（需 fine-grained）：https://github.com/settings/tokens');
  process.exit(1);
}

async function api(pathname, { method = 'GET', body } = {}) {
  const res = await fetch(API + pathname, {
    method,
    headers: {
      Authorization: 'Bearer ' + TOKEN,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'Content-Type': 'application/json',
      'User-Agent': 'anjing-ops-copilot-deploy'
    },
    body: body ? JSON.stringify(body) : undefined
  });
  const text = await res.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = { raw: text };
  }
  if (!res.ok) {
    const err = new Error('GitHub API ' + res.status + ' ' + method + ' ' + pathname);
    err.status = res.status;
    err.payload = data;
    throw err;
  }
  return data;
}

(async function main() {
  const log = (...a) => console.log(...a);

  log('▶ 1/6 校验 Token …');
  let me;
  try {
    me = await api('/user');
  } catch (e) {
    if (e.status === 401) {
      console.error('❌ Token 无效或已过期。');
      process.exit(1);
    }
    throw e;
  }
  const owner = me.login;
  log('   账号：' + owner);

  log('▶ 2/6 检查仓库 …');
  let repo = null;
  let finalName = REPO_NAME;
  try {
    repo = await api('/repos/' + owner + '/' + REPO_NAME);
    log('   仓库已存在：' + repo.full_name);
  } catch (e) {
    if (e.status !== 404) throw e;
    log('   仓库不存在，尝试创建 …');
    try {
      repo = await api('/user/repos', {
        method: 'POST',
        body: {
          name: REPO_NAME,
          description: '值守 · AI 运维工作台 —— 面向 ERP/OA 业务系统的智能支持工作台原型',
          private: false,
          has_issues: true,
          has_wiki: false,
          has_projects: false,
          auto_init: false
        }
      });
      log('   已创建：' + repo.full_name);
    } catch (err) {
      if (err.status === 403) {
        console.error('❌ 403：Token 缺少创建仓库权限。请先在网页端手动新建仓库，再重跑本脚本。');
        process.exit(1);
      }
      throw err;
    }
  }

  log('▶ 3/6 提交文件（单次提交）…');

  // 自动同步 public → docs，避免改了源文件忘记同步静态目录
  const SRC = path.resolve('public');
  if (fs.existsSync(SRC)) {
    fs.mkdirSync(path.resolve('docs'), { recursive: true });
    for (const f of ['index.html', 'styles.css', 'app.js', 'data.js']) {
      const from = path.join(SRC, f);
      if (fs.existsSync(from)) fs.copyFileSync(from, path.resolve('docs', f));
    }
    log('   已同步 public → docs');
  }

  const payload = [];
  for (const file of FILES) {
    const full = path.resolve(file);
    if (!fs.existsSync(full)) {
      log('   跳过缺失：' + file);
      continue;
    }
    payload.push({ path: file, content: fs.readFileSync(full, 'utf8') || '\n' });
  }

  const branch = (repo && repo.default_branch) || 'main';
  let baseCommitSha = null;
  let baseTreeSha = null;
  try {
    const ref = await api('/repos/' + owner + '/' + finalName + '/git/ref/heads/' + branch);
    baseCommitSha = ref.object.sha;
    const baseCommit = await api('/repos/' + owner + '/' + finalName + '/git/commits/' + baseCommitSha);
    baseTreeSha = baseCommit.tree.sha;
    log('   基于现有提交：' + baseCommitSha.slice(0, 7) + '（' + branch + '）');
  } catch (e) {
    if (e.status !== 404 && e.status !== 409) throw e;
    log('   空仓库，先用 Contents API 播种首个提交 …');
    await api('/repos/' + owner + '/' + finalName + '/contents/README.md', {
      method: 'PUT',
      body: {
        message: 'init: 创建仓库',
        content: Buffer.from('# 值守 · AI 运维工作台\n', 'utf8').toString('base64'),
        branch
      }
    });
    const ref2 = await api('/repos/' + owner + '/' + finalName + '/git/ref/heads/' + branch);
    baseCommitSha = ref2.object.sha;
    const c2 = await api('/repos/' + owner + '/' + finalName + '/git/commits/' + baseCommitSha);
    baseTreeSha = c2.tree.sha;
    log('   已播种：' + baseCommitSha.slice(0, 7));
  }

  const treeItems = [];
  for (const f of payload) {
    const blob = await api('/repos/' + owner + '/' + finalName + '/git/blobs', {
      method: 'POST',
      body: { content: f.content, encoding: 'utf-8' }
    });
    treeItems.push({ path: f.path, mode: '100644', type: 'blob', sha: blob.sha });
    log('   ✓ ' + f.path + '（' + f.content.length + ' 字符）');
  }

  const treeBody = { tree: treeItems };
  if (baseTreeSha) treeBody.base_tree = baseTreeSha;
  const tree = await api('/repos/' + owner + '/' + finalName + '/git/trees', {
    method: 'POST',
    body: treeBody
  });

  const commit = await api('/repos/' + owner + '/' + finalName + '/git/commits', {
    method: 'POST',
    body: {
      message: 'deploy: 值守 AI 运维工作台\n\n静态版（docs/）发布到 GitHub Pages，源码与演示脚本一并入库。',
      tree: tree.sha,
      parents: baseCommitSha ? [baseCommitSha] : []
    }
  });

  if (baseCommitSha) {
    await api('/repos/' + owner + '/' + finalName + '/git/refs/heads/' + branch, {
      method: 'PATCH',
      body: { sha: commit.sha, force: false }
    });
  } else {
    await api('/repos/' + owner + '/' + finalName + '/git/refs', {
      method: 'POST',
      body: { ref: 'refs/heads/' + branch, sha: commit.sha }
    });
  }
  log('   ✓ 已提交 ' + commit.sha.slice(0, 7));

  log('▶ 4/6 配置 GitHub Pages …');
  let pagesEnabled = false;
  try {
    await api('/repos/' + owner + '/' + finalName + '/pages', {
      method: 'POST',
      body: { source: { branch, path: PAGES_PATH } }
    });
    pagesEnabled = true;
    log('   已开启：' + branch + ' ' + PAGES_PATH);
  } catch (e) {
    if (e.status === 409) {
      await api('/repos/' + owner + '/' + finalName + '/pages', {
        method: 'PUT',
        body: { source: { branch, path: PAGES_PATH } }
      });
      pagesEnabled = true;
      log('   已更新：' + branch + ' ' + PAGES_PATH);
    } else if (e.status === 403) {
      console.error('❌ 403：Token 缺少 Pages 写权限。');
      console.error('   可先推代码，再到仓库 Settings → Pages 手动把 Source 设为 main /docs。');
    } else {
      console.error('⚠️ 配置 Pages 失败：' + e.status + ' ' + ((e.payload && e.payload.message) || ''));
    }
  }

  const url = 'https://' + owner.toLowerCase() + '.github.io/' + finalName + '/';
  log('▶ 5/6 等待构建 …');
  if (pagesEnabled) {
    for (let i = 0; i < 18; i++) {
      await sleep(8000);
      try {
        const p = await api('/repos/' + owner + '/' + finalName + '/pages');
        const st = p.status || 'null';
        log('   [' + (i + 1) + '/18] ' + st);
        if (st === 'built') break;
      } catch (e) {
        log('   查询状态失败：' + e.status);
      }
    }
  }

  log('▶ 6/6 验证访问 …');
  let code = 0;
  for (let i = 0; i < 8; i++) {
    try {
      const res = await fetch(url + '?t=' + Date.now());
      code = res.status;
      if (res.ok) {
        const html = await res.text();
        log('   HTTP ' + code + ' · ' + (/值守/.test(html) ? '页面内容正常' : '已返回，未匹配标题'));
        break;
      }
    } catch {
      /* 继续重试 */
    }
    await sleep(8000);
  }

  log('\n────────────────────────────');
  log('仓库地址：https://github.com/' + owner + '/' + finalName);
  log('预览地址：' + url);
  log('验证结果：' + (code === 200 ? 'HTTP 200，可正常访问' : 'HTTP ' + code + '，可能仍在构建'));
  log('────────────────────────────');
})().catch((err) => {
  console.error('\n❌ 部署中断：' + err.message);
  if (err.payload) console.error(JSON.stringify(err.payload, null, 2));
  process.exit(1);
});
