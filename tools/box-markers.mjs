// 번호 마커마다 가리키는 영역(이름표·버튼·입력칸)을 관리자 화면에서 찾아 점선 박스(box) 값을 만든다.
//   node tools/box-markers.mjs [--only id,id] [--apply] [--force] [--no-scan]
// 1) capture/targets.json 의 화면을 캡처할 때와 똑같이 열고(조회만), 캡처 영역을 다시 계산한다
// 2) 번호 위치에서 같은 줄 오른쪽으로 훑어 처음 닿는 글자·버튼·입력칸의 테두리를 박스로 잡는다
// 3) 결과는 capture/box-markers.json. --apply 면 md 의 번호 줄에 "box 왼쪽 위 너비 높이" 를 붙인다
//    (이미 box 가 있는 번호는 --force 일 때만 바꾼다)
// 이미지 크기가 지금 캡처 영역과 다르면(예전 이미지) 건너뛴다 → ?edit 로 확인하거나 손으로 넣기
import { chromium } from 'playwright-core';
import { readFileSync, writeFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import sharp from 'sharp';
import { unfix, sectionClip } from './capture-lib.mjs';

const args = process.argv.slice(2);
const oi = args.indexOf('--only');
const only = oi >= 0 ? new Set(args[oi + 1].split(',')) : null;
const config = JSON.parse(readFileSync('capture/targets.json', 'utf8'));
const base = config.baseUrl.replace(/\/$/, '');

// md 의 screen 블록에서 이미지별 번호 좌표
const marks = {};
const mdFiles = readdirSync('content', { withFileTypes: true }).filter((d) => d.isDirectory())
  .flatMap((d) => readdirSync(join('content', d.name)).filter((f) => f.endsWith('.md')).map((f) => [d.name, join('content', d.name, f)]));
// 같은 묶음(##) 안의 "### 제목 {#번호}" 를 번호의 이름으로 쓴다 (화면에서 그 글자를 먼저 찾는다)
for (const [dir, file] of mdFiles)
  for (const group of readFileSync(file, 'utf8').split(/\n(?=## )/)) {
    const titles = Object.fromEntries([...group.matchAll(/^### (.*?) \{#(\d+)\}/gm)].map((x) => [x[2], x[1]]));
    for (const m of group.matchAll(/```screen\n([\s\S]*?)```/g)) {
      const src = (m[1].match(/^src: (.*)$/m) || [])[1]?.trim();
      const pts = [...m[1].matchAll(/^(\d+): (-?[\d.]+) (-?[\d.]+)/gm)].map((x) => ({ n: x[1], x: +x[2], y: +x[3], title: titles[x[1]] || '' }));
      if (src && pts.length) marks[`${dir}/${src}`] ??= pts;
    }
  }

// --no-scan: 화면은 다시 열지 않고 capture/box-markers.json 을 그대로 md 에 반영만
const targets = args.includes('--no-scan') ? [] : config.targets.filter((t) => t.url && marks[t.image] && (!only || only.has(t.id)));
const browser = await chromium.launch({ channel: 'msedge', headless: false, args: ['--headless=new', '--hide-scrollbars'] });
const ctx = await browser.newContext({ viewport: config.viewport, deviceScaleFactor: 1, storageState: '.auth/state.json' });
const page = await ctx.newPage();
page.setDefaultTimeout(config.timeout || 15000);
const result = existsSync('capture/box-markers.json') ? JSON.parse(readFileSync('capture/box-markers.json', 'utf8')) : {};

for (const t of targets) {
  const file = join('content', t.image);
  try {
    await page.goto(new URL(t.url, base).href, { waitUntil: 'load' });
    await page.waitForLoadState('networkidle', { timeout: 5000 }).catch(() => {});
    if (!page.url().includes('/newsrp/')) throw new Error('로그인 세션 만료');
    for (const s of t.steps || []) {
      if (s.click) await page.click(s.click);
      if (s.wait) await page.waitForSelector(s.wait);
      if (s.sleep) await page.waitForTimeout(s.sleep);
      if (s.eval) await page.evaluate(s.eval);
    }
    await page.addStyleTag({ content: '*,*::before,*::after{animation:none!important;transition:none!important}' });
    await unfix(page, !!t.steps?.length);
    // 캡처와 같은 영역 계산
    const selector = t.selector || config.selector;
    let clip;
    if (t.from) clip = await sectionClip(page, t.root || config.selector || '#contents', t.from, t.to);
    else if (t.include?.length) {
      const boxes = [];
      for (const sel of [selector, ...t.include].filter(Boolean)) boxes.push(await page.locator(sel).first().boundingBox());
      const pad = t.pad || 0;
      const x = Math.max(0, Math.min(...boxes.map((b) => b.x)) - pad), y = Math.max(0, Math.min(...boxes.map((b) => b.y)) - pad);
      clip = { x, y, width: Math.max(...boxes.map((b) => b.x + b.width)) + pad - x, height: Math.max(...boxes.map((b) => b.y + b.height)) + pad - y };
    } else if (selector) {
      const b = await page.locator(selector).first().boundingBox();
      clip = { x: b.x, y: b.y + await page.evaluate(() => scrollY), width: b.width, height: b.height };
    } else clip = { x: 0, y: 0, ...config.viewport };
    const { width: W, height: H } = await sharp(file).metadata();
    if (Math.abs(W - clip.width) > 2) throw new Error(`이미지 폭 ${W} ≠ 캡처 영역 ${Math.round(clip.width)} (예전 이미지)`);
    const R = Math.round(12 * W / Math.min(W, 824)); // 화면의 번호 반지름(12px)을 이미지 px 로
    const pts = marks[t.image].map((m) => ({ n: m.n, title: m.title, px: clip.x + (m.x / 100) * W, py: clip.y + (m.y / 100) * H }));
    const found = await page.evaluate(({ pts, R, clip }) => {
      const CTRL = 'button, input:not([type=hidden]), select, textarea, img, a[class*=btn], span[class*=btn], label, [class*=btn_]';
      const ownText = (e) => [...e.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim());
      const textRect = (e) => {
        const r = document.createRange(); r.selectNodeContents(e);
        const rs = [...r.getClientRects()].filter((q) => q.width && q.height);
        if (!rs.length) return null;
        const x1 = Math.min(...rs.map((q) => q.left)), y1 = Math.min(...rs.map((q) => q.top)), x2 = Math.max(...rs.map((q) => q.right)), y2 = Math.max(...rs.map((q) => q.bottom));
        return { left: x1, top: y1, right: x2, bottom: y2, width: x2 - x1, height: y2 - y1, rs };
      };
      const hit = (cx, cy) => {
        const e = document.elementFromPoint(cx, cy);
        if (!e) return null;
        const c = e.closest(CTRL);
        if (c?.tagName === 'IMG' && c.getBoundingClientRect().width < 24) return null; // 필수 표시 같은 작은 아이콘은 건너뜀
        if (c && c.getBoundingClientRect().width < clip.width * 0.6) return { r: c.getBoundingClientRect(), t: (c.value || c.textContent || c.alt || '').trim().slice(0, 30), k: c.tagName.toLowerCase() };
        if (ownText(e)) {
          const tr = textRect(e);
          // 글자 위를 실제로 지났을 때만 (칸의 빈 곳은 제외)
          if (tr && tr.width < clip.width * 0.6 && tr.rs.some((q) => cx >= q.left - 2 && cx <= q.right + 2 && cy >= q.top - 2 && cy <= q.bottom + 2))
            return { r: tr, t: e.textContent.trim().replace(/\s+/g, ' ').slice(0, 30), k: 'text' };
        }
        return null;
      };
      // 제목 비교용: [필수항목] 같은 꾸밈과 띄어쓰기·기호를 뺀 글자
      const norm = (s) => s.replace(/\[[^\]]*\]|\([^)]*\)/g, '').replace(/[^0-9A-Za-z가-힣]/g, '').toLowerCase();
      const texts = [...document.querySelectorAll('#contents *, #side_area *, .pop_layer *, .layer_wrap *')].filter(ownText);
      const byTitle = (title, px, py, ox, oy) => {
        const want = norm(title);
        if (want.length < 2) return null;
        let best = null;
        for (const e of texts) {
          const have = norm(e.textContent);
          if (!have || !(have === want || (have.length >= 2 && want.includes(have) && have.length >= want.length * 0.6) || (have.includes(want) && have.length <= want.length * 1.6))) continue;
          const r = textRect(e);
          if (!r || r.width > clip.width * 0.6) continue;
          const cy = (r.top + r.bottom) / 2 + oy, cx = (r.left + r.right) / 2 + ox;
          if (Math.abs(cy - py) > R * 1.5 || cx < clip.x || cx > clip.x + clip.width) continue;
          const dist = Math.abs(cy - py) * 3 + Math.min(Math.abs(r.left + ox - px), Math.abs(r.right + ox - px));
          if (!best || dist < best.dist) best = { dist, r, t: e.textContent.trim().replace(/\s+/g, ' ').slice(0, 30), k: 'title' };
        }
        return best;
      };
      return pts.map(({ n, title, px, py }) => {
        window.scrollTo(0, Math.max(0, py - innerHeight / 2));
        const ox = scrollX, oy = scrollY;
        let f = byTitle(title, px, py, ox, oy);
        // 같은 줄 오른쪽으로 → 안 되면 조금 위·아래 줄
        for (const dy of [0, -R * 0.5, R * 0.5, -R, R]) {
          for (let dx = -R * 0.6; dx <= R * 14 && !f; dx += 3) {
            const h = hit(px + dx - ox, py + dy - oy);
            if (h && Math.abs((h.r.top + h.r.bottom) / 2 - (py - oy)) <= Math.max(R * 1.2, h.r.height / 2 + 4)) f = h;
          }
          if (f) break;
        }
        if (!f) return { n, box: null };
        const p = 4;
        return { n, t: f.t, k: f.k, rect: [f.r.left + ox - clip.x - p, f.r.top + oy - clip.y - p, f.r.width + 2 * p, f.r.height + 2 * p] };
      });
    }, { pts, R, clip });
    // 지금 화면이 저장된 이미지와 다를 수 있으므로(계정·데이터에 따라 열·줄이 달라짐),
    // 박스 자리의 지금 화면과 저장된 이미지가 거의 같을 때만 쓴다
    await page.evaluate(() => window.scrollTo(0, 0));
    const live = await sharp(await page.screenshot({ clip, fullPage: true })).removeAlpha().raw().toBuffer({ resolveWithObject: true });
    const saved = await sharp(file).removeAlpha().raw().toBuffer({ resolveWithObject: true });
    const diff = (x, y, w, h) => {
      let s = 0, c = 0;
      for (let j = Math.round(y); j < Math.round(y + h); j++) for (let i = Math.round(x); i < Math.round(x + w); i++) {
        if (j >= live.info.height || j >= saved.info.height || i >= live.info.width || i >= saved.info.width) continue;
        const a = (j * live.info.width + i) * 3, b = (j * saved.info.width + i) * 3;
        s += Math.abs(live.data[a] - saved.data[b]) + Math.abs(live.data[a + 1] - saved.data[b + 1]) + Math.abs(live.data[a + 2] - saved.data[b + 2]); c += 3;
      }
      return c ? s / c : 255;
    };
    const pct = (v, d) => Math.round((v / d) * 1000) / 10;
    let same = 0;
    result[t.image] = Object.fromEntries(found.map((f) => {
      if (!f.rect) return [f.n, null];
      let [x, y, w, h] = f.rect;
      const x2 = Math.min(W, x + w), y2 = Math.min(H, y + h); x = Math.max(0, x); y = Math.max(0, y);
      if (x2 - x < 4 || y2 - y < 4 || y >= H) return [f.n, null]; // 이미지 밖(잘린 부분)
      const d = Math.round(diff(x, y, x2 - x, y2 - y) * 10) / 10;
      if (d > 12) return [f.n, { reject: `화면이 이미지와 다름 (차이 ${d})`, t: f.t }];
      same++;
      return [f.n, { box: [pct(x, W), pct(y, H), pct(x2 - x, W), pct(y2 - y, H)], t: f.t, k: f.k, d }];
    }));
    console.log(`${String(same).padStart(2)}/${found.length}  ${t.id}`);
  } catch (e) {
    result[t.image] = { error: String(e.message || e).split('\n')[0] };
    console.log(`오류  ${t.id}  ${result[t.image].error}`);
  }
}
await browser.close();
writeFileSync('capture/box-markers.json', JSON.stringify(result, null, 1));

if (args.includes('--apply')) {
  const force = args.includes('--force');
  let n = 0;
  for (const [dir, file] of mdFiles) {
    const md = readFileSync(file, 'utf8');
    const out = md.replace(/```screen\n([\s\S]*?)```/g, (all, body) => {
      const src = (body.match(/^src: (.*)$/m) || [])[1]?.trim();
      const r = result[`${dir}/${src}`];
      if (!r || r.error) return all;
      return '```screen\n' + body.replace(/^(\d+): (-?[\d.]+) (-?[\d.]+)( box [\d. ]+)?$/gm, (line, k, x, y, old) => {
        if (!r[k]?.box || (old && !force)) return line;
        n++;
        return `${k}: ${x} ${y} box ${r[k].box.join(' ')}`;
      }) + '```';
    });
    if (out !== md) writeFileSync(file, out);
  }
  console.log(`md 에 박스 ${n}개 반영`);
}
