// 빌드된 사이트(dist/) 전체 점검. npm run serve 를 켜 둔 상태에서 실행.
//   node tools/audit.mjs            모든 페이지
//   node tools/audit.mjs goods/goods_01.html setting/info01.html
// 점검: 같은 페이지 # 링크 대상 없음, id 중복, 이미지 깨짐, 스크립트 오류,
//       목차 클릭 시 그 항목 표시·위치, 스크롤 위치에 따른 목차 표시, 번호 마커 좌표 범위
import { chromium } from 'playwright-core';
import { readdirSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const BASE = 'http://localhost:4321/';
const walk = (d) => readdirSync(d).flatMap((f) => (statSync(join(d, f)).isDirectory() ? walk(join(d, f)) : f.endsWith('.html') ? [join(d, f)] : []));
const only = process.argv.slice(2);
const pages = only.length ? only : walk('dist').map((f) => f.slice(5).replace(/\\/g, '/')).filter((f) => !f.startsWith('capture/'));

const browser = await chromium.launch({ channel: 'chrome', headless: false, args: ['--headless=new'] });
const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
const problems = [];
const add = (p, kind, msg) => problems.push({ page: p, kind, msg });
let errs = [];
page.on('pageerror', (e) => errs.push(e.message));
page.on('console', (m) => { if (m.type() === 'error') errs.push(m.text()); });

for (const p of pages) {
  errs = [];
  await page.goto(BASE + p, { waitUntil: 'load' });
  // 이미지 모두 불러오기 (lazy)
  await page.evaluate(async () => {
    for (const img of document.images) img.loading = 'eager';
    await Promise.all([...document.images].map((i) => (i.complete ? 0 : new Promise((r) => { i.onload = i.onerror = r; }))));
  });
  const info = await page.evaluate(() => {
    const ids = [...document.querySelectorAll('[id]')].map((e) => e.id);
    const dup = ids.filter((id, i) => ids.indexOf(id) !== i);
    const missing = [...document.querySelectorAll('a[href^="#"]')].map((a) => a.getAttribute('href')).filter((h) => h.length > 1 && !document.getElementById(decodeURIComponent(h.slice(1))));
    const broken = [...document.images].filter((i) => !i.naturalWidth).map((i) => i.getAttribute('src'));
    const badMk = [...document.querySelectorAll('.mk')].filter((m) => { const x = parseFloat(m.style.left), y = parseFloat(m.style.top); return !(x >= -3 && x <= 100 && y >= 0 && y <= 100); }).map((m) => m.dataset.n);
    const toc = [...document.querySelectorAll('.toc li:not(.grp) a')].map((a) => a.hash);
    return { dup: [...new Set(dup)], missing: [...new Set(missing)], broken, badMk, toc };
  });
  if (info.dup.length) add(p, 'id 중복', info.dup.join(' '));
  if (info.missing.length) add(p, '# 링크 대상 없음', info.missing.join(' '));
  if (info.broken.length) add(p, '이미지 깨짐', info.broken.join(' '));
  if (info.badMk.length) add(p, '마커 좌표 범위 밖', info.badMk.join(' '));

  // 목차 클릭 → 그 항목 표시, 항목이 머리글 바로 아래(또는 페이지 끝이라 더 못 올라감)
  for (const h of info.toc) {
    const r = await page.evaluate(async (h) => {
      document.querySelector(`.toc a[href="${h}"]`).click();
      await new Promise((r) => setTimeout(r, 60));
      const on = [...document.querySelectorAll('.toc li.on a')].map((a) => a.hash);
      const t = document.getElementById(decodeURIComponent(h.slice(1))).getBoundingClientRect().top;
      const hdr = document.querySelector('header.top').offsetHeight;
      const atBottom = scrollY + innerHeight >= document.documentElement.scrollHeight - 2;
      return { on, t: Math.round(t), hdr, atBottom };
    }, h);
    if (r.on.length !== 1 || r.on[0] !== h) add(p, '목차 클릭 표시 틀림', `${h} 눌렀는데 ${r.on.join(',') || '없음'} 표시`);
    if (!r.atBottom && (r.t < r.hdr || r.t > r.hdr + 40)) add(p, '이동 위치 틀림', `${h} 위치 ${r.t}px (머리글 ${r.hdr}px)`);
  }

  // 사용자 스크롤(휠)로 각 항목을 머리글 아래에 맞추면 그 항목이 표시되는지
  await page.evaluate(() => history.replaceState(null, '', location.pathname));
  await page.mouse.move(700, 500);
  await page.mouse.wheel(0, 1); // 고정 풀기
  for (const h of info.toc) {
    const r = await page.evaluate(async (h) => {
      const el = document.getElementById(decodeURIComponent(h.slice(1)));
      const hdr = document.querySelector('header.top').offsetHeight;
      scrollTo(0, scrollY + el.getBoundingClientRect().top - hdr - 8);
      await new Promise((r) => setTimeout(r, 40));
      const reached = Math.abs(el.getBoundingClientRect().top - hdr - 8) < 3;
      const on = [...document.querySelectorAll('.toc li.on a')].map((a) => a.hash);
      return { reached, on };
    }, h);
    if (r.reached && (r.on.length !== 1 || r.on[0] !== h)) add(p, '스크롤 표시 틀림', `${h} 위치인데 ${r.on.join(',') || '없음'} 표시`);
  }
  if (errs.length) add(p, '스크립트 오류', [...new Set(errs)].join(' | '));
}
await browser.close();

writeFileSync('capture/audit.json', JSON.stringify(problems, null, 2));
const byKind = {};
for (const x of problems) (byKind[x.kind] ||= []).push(x);
console.log(`페이지 ${pages.length}개 점검, 문제 ${problems.length}건 → capture/audit.json`);
for (const [k, list] of Object.entries(byKind)) {
  console.log(`\n## ${k} (${list.length})`);
  list.slice(0, 15).forEach((x) => console.log(`  ${x.page}: ${x.msg}`));
  if (list.length > 15) console.log(`  … 외 ${list.length - 15}건`);
}
