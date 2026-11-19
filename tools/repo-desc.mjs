#!/usr/bin/env node
/**
 * repo-desc.mjs —— 两端仓库简介写成同一句（≤80 字）
 *
 * 用法：
 *   GITEE_TOKEN=xxx GH_TOKEN=xxx node tools/repo-desc.mjs "简介文字"
 *   node tools/repo-desc.mjs --show          # 只看两边现在写的是什么
 *
 * 为什么单独一个脚本：简介是仓库门面，两边必须同一份；
 * 之前靠记性去网页手改，改了一边忘另一边，读者看到两种说法。
 */
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(new URL('.', import.meta.url).pathname, '..');
const GITEE_OWNER = 'yingning2026';
const GITEE_REPO = 'dsh-pbyugujia';
const GH_OWNER = 'yingning1991';
const GH_REPO = 'dsh-pbyugujia';

const args = process.argv.slice(2);
const show = args.includes('--show');
const desc = show ? '' : args.filter((a) => !a.startsWith('--')).join(' ').trim();

const giteeCred = process.env.GITEE_TOKEN || readMaybe(path.join(ROOT, '.gitee-token'));
const ghCred = process.env.GH_TOKEN || readMaybe(path.join(ROOT, '.gh-token'));

function readMaybe(p) {
  try { return fs.readFileSync(p, 'utf8').trim(); } catch { return ''; }
}

async function j(url, opt = {}) {
  const r = await fetch(url, opt);
  const t = await r.text();
  let body;
  try { body = JSON.parse(t); } catch { body = t.slice(0, 200); }
  return { status: r.status, body };
}

async function main() {
  const giteeUrl = `https://gitee.com/api/v5/repos/${GITEE_OWNER}/${GITEE_REPO}`;
  const ghUrl = `https://api.github.com/repos/${GH_OWNER}/${GH_REPO}`;

  if (show) {
    const g = await j(`${giteeUrl}?access_token=${giteeCred}`);
    const h = await j(ghUrl, { headers: { Authorization: `Bearer ${ghCred}`, Accept: 'application/vnd.github+json' } });
    console.log('Gitee :', g.body.description || '(空)');
    console.log('GitHub:', h.body.description || '(空)');
    return;
  }

  if (!desc) {
    console.error('给一句话：node tools/repo-desc.mjs "简介文字"（或 --show 看现状）');
    process.exit(2);
  }
  if ([...desc].length > 80) {
    console.error(`简介 ${[...desc].length} 字，超过 80 字`); 
    process.exit(2);
  }

  const g = await j(`${giteeUrl}?access_token=${giteeCred}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ description: desc }),
  });
  console.log(`Gitee : ${g.status} ${g.body.description ?? JSON.stringify(g.body).slice(0, 120)}`);

  const h = await j(ghUrl, {
    method: 'PATCH',
    headers: {
      Authorization: `Bearer ${ghCred}`,
      Accept: 'application/vnd.github+json',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ description: desc }),
  });
  console.log(`GitHub: ${h.status} ${h.body.description ?? JSON.stringify(h.body).slice(0, 120)}`);
}

main().catch((e) => { console.error(e.message); process.exit(1); });
