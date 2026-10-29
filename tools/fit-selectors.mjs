// 기존 가이드 이미지가 관리자 화면의 어느 묶음인지 찾아 capture/targets.json 에 from/to(묶음 제목)를 채운다.
//   node tools/fit-selectors.mjs --only id1,id2     지정한 화면만
//   node tools/fit-selectors.mjs --unfit            url 은 있고 영역 지정이 없는 화면 중, 기존 이미지와 비율이 많이 다른 것
// 기존 이미지(분홍 배경 + 흰 카드)에서 카드만 잘라, 본문의 "제목 ~ 다음 제목" 구간들과 비율·모양(흑백 축소)을 비교한다.
// 점수가 낮으면 넣지 않고 "확인" 으로 남긴다 (탭 클릭 등 steps 가 필요하거나 화면 구성이 크게 바뀐 경우).
// 고른 구간 이미지는 capture/fit/ 에 저장된다 → capture/fit/index.html 에서 기존 이미지와 나란히 확인.
import { chromium } from 'playwright-core';
import sharp from 'sharp';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { unfix, sections } from './capture-lib.mjs';

const args = process.argv.slice(2);
const opt = (n) => { const i = args.indexOf('--' + n); return i < 0 ? null : args[i + 1]; };
const FILE = 'capture/targets.json';
const config = JSON.parse(readFileSync(FILE, 'utf8'));
const base = config.baseUrl;
const root = config.selector || '#contents';
const maxH = config.maxHeight || 1000;
const OK = 0.3;  // 이 점수 이상이면 from/to 를 넣는다 (데이터·배치가 바뀌어 점수는 낮게 나오는 편, 0.5 미만은 확인 페이지에서 꼭 볼 것)

// 기존 이미지에서 분홍 테두리를 걷어낸 카드 영역
async function card(file) {
  const img = sharp(file).removeAlpha();
  const { data, info } = await img.clone().raw().toBuffer({ resolveWithObject: true });
  const bg = [...data.subarray(0, 3)];
  if (!(bg[0] > 225 && bg[0] - bg[2] > 8)) return img.png().toBuffer(); // 테두리 없는 이미지
  let x0 = info.width, y0 = info.height, x1 = 0, y1 = 0;
  for (let y = 0; y < info.height; y += 2) for (let x = 0; x < info.width; x += 2) {
    const i = (y * info.width + x) * 3;
    if (Math.abs(data[i] - bg[0]) + Math.abs(data[i + 1] - bg[1]) + Math.abs(data[i + 2] - bg[2]) > 24) {
      if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
    }
  }
  const m = 14; // 카드 안쪽 여백(둥근 모서리) 조금 제외
  return img.extract({ left: x0 + m, top: y0 + m, width: Math.max(10, x1 - x0 - 2 * m), height: Math.max(10, y1 - y0 - 2 * m) }).png().toBuffer();
}

// 세로 윤곽: 줄마다 진한 정도(글자·선·버튼). 예전 관리자는 폭만 좁았고 세로 크기는 1:1 이라 실제 높이(px)로 비교한다.
const STEP = 4; // 4px 단위
async function print(buf) {
  const m = await sharp(buf).metadata();
  const h = Math.max(2, Math.round(m.height / STEP));
  const px = await sharp(buf).greyscale().resize(32, h, { fit: 'fill' }).raw().toBuffer();
  const rows = new Float64Array(h);
  for (let y = 0; y < h; y++) for (let x = 0; x < 32; x++) rows[y] += 255 - px[y * 32 + x];
  return { rows, height: m.height };
}
const corr = (a, b) => {
  // 길이를 맞춰 상관계수
  const n = Math.min(a.length, b.length);
  const pick = (arr, i) => arr[Math.floor((i * arr.length) / n)];
  let ma = 0, mb = 0;
  for (let i = 0; i < n; i++) { ma += pick(a, i); mb += pick(b, i); }
  ma /= n; mb /= n;
  let sab = 0, saa = 0, sbb = 0;
  for (let i = 0; i < n; i++) { const da = pick(a, i) - ma, db = pick(b, i) - mb; sab += da * db; saa += da * da; sbb += db * db; }
  return saa && sbb ? sab / Math.sqrt(saa * sbb) : 0;
};
// 후보가 기존 이미지보다 길면 위쪽을 기존 높이만큼만 쓴다 (긴 목록은 예전에도 위만 잘라 썼다). 짧으면 높이 차이만큼 감점.
const score = (a, b) => 0.6 * Math.max(0, corr(a.rows, b.rows)) + 0.4 * Math.exp(-2.5 * Math.abs(Math.log(a.height / b.height)));

const only = opt('only')?.split(',');
const unfit = args.includes('--unfit');
function needsFit(t) {
  if (!t.url || t.from || t.selector || t.fitChecked) return false;
  return true;
}
const list = config.targets.filter((t) => t.url && (only ? only.includes(t.id) : unfit && needsFit(t)));
if (!list.length) { console.log('대상 없음 (--only id,... 또는 --unfit)'); process.exit(0); }

const browser = await chromium.launch({ channel: 'chrome', headless: false, args: ['--headless=new', '--hide-scrollbars'] });
const ctx = await browser.newContext({ viewport: config.viewport, deviceScaleFactor: 1, storageState: '.auth/state.json' });
const page = await ctx.newPage();
mkdirSync('capture/fit', { recursive: true });
const reportFile = 'capture/fit/_report.json';
const report = existsSync(reportFile) ? JSON.parse(readFileSync(reportFile, 'utf8')) : {};
const pages = {}; // 같은 주소는 한 번만 연다

for (const t of list) {
  const old = join('content', t.image);
  if (!existsSync(old)) { console.log('없음', t.id); continue; }
  try {
    if (!pages[t.url]) {
      await page.goto(new URL(t.url, base).href, { waitUntil: 'load' });
      await page.waitForLoadState('networkidle', { timeout: 5000 }).catch(() => {});
      await unfix(page);
      const full = await page.screenshot({ fullPage: true });
      pages[t.url] = { full, meta: await sharp(full).metadata(), secs: await sections(page, root) };
    }
    const { full, meta, secs } = pages[t.url];
    const target = await print(await card(old));
    const cands = [];
    // 후보: 제목 a 부터 제목 b 앞까지의 모든 연속 구간
    for (let a = 0; a < secs.length; a++) for (let b = a; b < secs.length; b++) {
      const left = Math.round(secs[a].x), top = Math.round(secs[a].y);
      const width = Math.min(Math.round(secs[a].w), meta.width - left);
      const natural = Math.round(secs[b].end - secs[a].y);
      const height = Math.min(natural, Math.round(target.height * 1.05), maxH, meta.height - top);
      if (width < 50 || height < 30) continue;
      const crop = await sharp(full).extract({ left, top, width, height }).png().toBuffer();
      cands.push({ a, b, s: score(target, await print(crop)), crop, natural, height });
      if (natural > target.height * 1.05) break; // 더 늘려도 잘리는 높이는 같음
    }
    if (!cands.length) throw new Error(`본문에서 묶음 제목을 찾지 못함 (${secs.length}개)`);
    let best = cands.reduce((x, y) => (y.s > x.s ? y : x));
    // 높이로 자른 것과 점수가 비슷하면 제목 경계에서 끝나는 쪽 (데이터 양이 바뀌어도 범위가 그대로)
    if (best.natural > best.height) {
      const whole = cands.filter((c) => c.a === best.a && c.natural <= c.height && c.s >= best.s - 0.06).sort((x, y) => y.s - x.s)[0];
      if (whole) best = whole;
    }
    const from = secs[best.a].label, to = secs[best.b + 1]?.label;
    const cut = best.natural > best.height ? best.height : null; // 구간이 기존 이미지보다 길어서 잘랐으면 그 높이
    const ok = best.s >= OK;
    if (ok) {
      t.from = from;
      if (to) t.to = to; else delete t.to;
      if (cut) t.maxHeight = cut; else delete t.maxHeight;
    }
    t.fitChecked = true;
    const out = `capture/fit/${t.id.replace(/\//g, '__')}.png`;
    writeFileSync(out, best.crop);
    report[t.id] = { score: +best.s.toFixed(3), ok, from, to: to || null, cut, image: t.image, fit: out.replace('capture/fit/', ''), heads: secs.map((s) => s.label) };
    console.log(`${ok ? '맞춤' : '확인'} ${best.s.toFixed(3)} ${t.id}  "${from}" → ${to ? `"${to}" 앞` : '끝'}${cut ? ` (높이 ${cut})` : ''}`);
  } catch (e) {
    report[t.id] = { error: e.message.split('\n')[0], image: t.image };
    console.log('오류', t.id, e.message.split('\n')[0]);
  }
  writeFileSync(FILE, JSON.stringify(config, null, 2));
}
await browser.close();
writeFileSync(reportFile, JSON.stringify(report, null, 2));

// 확인용 페이지: 기존 이미지 | 고른 구간
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
writeFileSync('capture/fit/index.html', `<!doctype html><meta charset="utf-8"><title>캡처 영역 맞춤</title>
<style>body{font:14px/1.5 sans-serif;margin:20px}section{border-top:1px solid #ddd;padding:12px 0}.row{display:grid;grid-template-columns:1fr 1fr;gap:12px}img{max-width:100%;border:1px solid #eee}.ok{color:#187a3a}.no{color:#c0392b}small{color:#777}</style>
<h1>캡처 영역 맞춤</h1><p>왼쪽 = 지금 가이드 이미지, 오른쪽 = 고른 구간. <b class="ok">맞춤</b>은 targets.json 에 들어갔고, <b class="no">확인</b>은 들어가지 않았다.</p>
${Object.entries(report).sort((a, b) => (a[1].ok === b[1].ok ? 0 : a[1].ok ? 1 : -1)).map(([id, r]) => `<section><b class="${r.ok ? 'ok' : 'no'}">${r.error ? '오류' : r.ok ? '맞춤' : '확인'}</b> <b>${esc(id)}</b> ${r.score ?? ''}
<div><small>${r.error ? esc(r.error) : `from "${esc(r.from)}" → ${r.to ? `"${esc(r.to)}" 앞` : '끝'} · 제목들: ${esc(r.heads?.join(' / '))}`}</small></div>
<div class="row"><img src="/content/${esc(r.image)}"><div>${r.fit ? `<img src="${esc(r.fit)}">` : ''}</div></div></section>`).join('')}`);
console.log('확인 페이지: http://localhost:4321/capture/fit/index.html');
