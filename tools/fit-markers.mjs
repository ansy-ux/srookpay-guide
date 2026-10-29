// 새로 찍은 화면의 번호 마커 위치를 "번호 옆 글자"로 다시 맞춘다.
//   node tools/fit-markers.mjs <예전 content 폴더> [--only 섹션/images/파일,...] [--dry]
// 1) 예전 이미지(번호가 그려진 것)에서 각 번호 바로 옆 글자(이름표·버튼)를 OCR 로 찾는다
// 2) 새 이미지에서 같은 글자를 찾아, 번호를 같은 상대 위치에 놓는다
// 3) 못 찾은 번호는 그대로 두고 capture/fit-markers.json 에 "확인 필요"로 남긴다 → ?edit 로 손보기
// OCR 은 Windows 내장(tools/ocr.ps1)이라 Windows 에서만 동작한다.
import { readFileSync, writeFileSync, readdirSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import sharp from 'sharp';

const args = process.argv.slice(2);
const oldRoot = args[0];
const dry = args.includes('--dry');
const oi = args.indexOf('--only');
const only = oi > 0 ? new Set(args[oi + 1].split(',')) : null;
if (!oldRoot || !existsSync(oldRoot)) throw new Error('예전 content 폴더를 지정하세요');

// 바뀐(새로 찍은) 이미지가 있는 screen 블록 모으기
const blocks = [];
for (const dir of readdirSync('content', { withFileTypes: true }).filter((d) => d.isDirectory())) {
  for (const f of readdirSync(join('content', dir.name)).filter((f) => f.endsWith('.md'))) {
    const md = readFileSync(join('content', dir.name, f), 'utf8');
    const oldMdPath = join(oldRoot, dir.name, f);
    if (!existsSync(oldMdPath)) continue;
    const oldMd = readFileSync(oldMdPath, 'utf8');
    for (const m of md.matchAll(/```screen\n([\s\S]*?)```/g)) {
      const src = (m[1].match(/^src: (.*)$/m) || [])[1]?.trim();
      if (!src || !/^\d+: /m.test(m[1])) continue;
      const key = `${dir.name}/${src}`;
      if (only && !only.has(key)) continue;
      const neu = join('content', dir.name, src), old = join(oldRoot, dir.name, src);
      if (!existsSync(old) || readFileSync(neu).equals(readFileSync(old))) continue;
      const oldBlock = [...oldMd.matchAll(/```screen\n([\s\S]*?)```/g)].find((b) => b[1].includes(`src: ${src}`));
      if (!oldBlock) continue;
      const parse = (b) => [...b.matchAll(/^(\d+): (-?[\d.]+) (-?[\d.]+)$/gm)].map(([, n, x, y]) => ({ n, x: +x, y: +y }));
      // 이 화면 뒤 같은 ## 묶음 안의 항목 제목: "### 송장일괄등록 {#1}" → { 1: '송장일괄등록' }
      const after = md.slice(m.index + m[0].length);
      const group = after.split(/\n## /)[0]; // 같은 ## 묶음 끝까지 (중간에 다른 화면 이미지가 있어도 번호는 묶음 안에서 이어짐)
      const titles = Object.fromEntries([...group.matchAll(/^### (.+?)\s*\{#(\d+)\}/gm)].map(([, t, n]) => [n, t.replace(/\[([^\]]+)\]\([^)]*\)/g, '$1').replace(/[*`]/g, '').trim()]));
      blocks.push({ md: join('content', dir.name, f), key, neu, old, cur: parse(m[1]), was: parse(oldBlock[1]), titles, sub: /^style: sub$/m.test(m[1]) });
    }
  }
}
console.log(`대상 이미지 ${blocks.length}개`);

// OCR (글자 + 위치). 작은 글자를 잘 읽도록 2배로 키운 사본을 읽고 좌표는 다시 1배로
const tmp = join(process.env.TEMP || '.', 'fit-markers');
mkdirSync(tmp, { recursive: true });
const UP = 2;
const big = {};
for (const [i, p] of [...new Set(blocks.flatMap((b) => [b.old, b.neu]))].entries()) {
  const m = await sharp(p).metadata();
  big[p] = join(tmp, `${i}.png`);
  await sharp(p).resize({ width: m.width * UP, kernel: 'lanczos3' }).png().toFile(big[p]);
}
writeFileSync(tmp + '.txt', Object.values(big).join('\n'));
execFileSync('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', 'tools/ocr.ps1', '-List', tmp + '.txt', '-Out', tmp + '.json', '-Boxes'], { stdio: 'inherit' });
const ocrBig = JSON.parse(readFileSync(tmp + '.json', 'utf8'));
const lines = (p) => [].concat(ocrBig[big[p]] || []).filter((l) => l && typeof l === 'object')
  .map((l) => ({ t: l.t, x: l.x / UP, y: l.y / UP, w: l.w / UP, h: l.h / UP }));

// 글자 비교: 공백·기호·OCR 잡음 빼고, 두 글자씩 묶어 겹치는 정도(0~1)
const norm = (t) => t.replace(/[\s•·○●◎ㆍ.,:;'"`~!?()[\]{}<>|/\\_\-=+*#%^&@$]+/g, '').replace(/[①-⑳]/g, '').toLowerCase();
const useful = (t) => { const n = norm(t); return n.length >= 2 && !/^\d+$/.test(n); };
const grams = (s) => { const g = new Map(); for (let i = 0; i < s.length - 1; i++) g.set(s.slice(i, i + 2), (g.get(s.slice(i, i + 2)) || 0) + 1); return g; };
function sim(a, b) {
  a = norm(a); b = norm(b);
  if (!a || !b) return 0;
  if (a === b) return 1;
  if (a.length < 2 || b.length < 2) return 0;
  const ga = grams(a), gb = grams(b); let both = 0;
  for (const [k, v] of ga) both += Math.min(v, gb.get(k) || 0);
  return (2 * both) / (a.length - 1 + b.length - 1);
}

const report = [];
for (const b of blocks) {
  const [om, nm] = await Promise.all([sharp(b.old).metadata(), sharp(b.neu).metadata()]);
  const OL = lines(b.old).filter((l) => useful(l.t)), NL = lines(b.neu).filter((l) => useful(l.t));
  const fixed = [];
  for (const mk of b.was) {
    const mx = (mk.x / 100) * om.width, my = (mk.y / 100) * om.height;
    // ① 항목 제목("### 송장일괄등록 {#1}")을 새 화면에서 찾기 — 새 캡처는 원본 크기라 글자를 잘 읽는다
    const title = !b.sub && b.titles[mk.n] && norm(b.titles[mk.n].replace(/\[[^\]]*\]/g, ''));
    if (title && title.length >= 2) {
      const ex = (mk.x / 100) * nm.width, ey = (mk.y / 100) * nm.height; // 예전 위치를 비율로 옮긴 곳 (같은 글자가 여럿일 때 기준)
      const cands = NL.map((l) => {
        const t = norm(l.t);
        const s = t === title ? 1 : (t.includes(title) || (title.includes(t) && t.length >= Math.max(2, title.length * 0.6))) ? 0.9 : sim(title, t);
        return { l, s, d: Math.hypot((l.x - ex) / nm.width, (l.y - ey) / nm.height) };
      }).filter((c) => c.s >= 0.7).sort((a, c) => (c.s - a.s) || (a.d - c.d));
      const top = cands.filter((c) => c.s >= cands[0]?.s - 0.05).sort((a, c) => a.d - c.d)[0];
      if (top) {
        const l = top.l, R = Math.max(12, l.h * 1.1);
        // 글자 왼쪽에 자리가 있으면 왼쪽, 없으면(화면 왼쪽 끝) 글자 왼쪽 위
        // 번호는 글자 왼쪽. 화면 왼쪽 끝이라 자리가 없으면 이미지 밖(왼쪽 최대 -2%)으로 — 사이트 본문 왼쪽 여백에 걸침
        const [nx, ny] = [l.x - R, l.y + l.h / 2];
        fixed.push({ n: mk.n, x: +Math.min(99, Math.max(-2, (nx / nm.width) * 100)).toFixed(1), y: +Math.min(99, Math.max(1, (ny / nm.height) * 100)).toFixed(1), ok: true, by: `제목: ${b.titles[mk.n]}`, sim: +top.s.toFixed(2), ox: mk.x, oy: mk.y });
        continue;
      }
    }
    // ② 예전 이미지에서 번호 바로 옆 글자: 같은 줄(세로 겹침)에서 오른쪽 가까운 것 우선, 없으면 가장 가까운 것
    const scored = OL.map((l) => {
      const cy = l.y + l.h / 2, dy = Math.abs(cy - my), dxR = l.x - mx, dxL = mx - (l.x + l.w);
      const inside = mx >= l.x && mx <= l.x + l.w;
      const dx = inside ? 0 : dxR >= 0 ? dxR : dxL * 1.6; // 오른쪽에 있는 글자를 더 쳐줌
      // 같은 글자가 화면에 여러 번 나오면(예: "검색내용을 입력해주세요") 새 화면에서 헷갈리므로 덜 쳐줌
      const dup = OL.filter((o) => o !== l && sim(o.t, l.t) >= 0.8).length;
      return { l, d: dx + dy * 2.2 + (dup ? 70 : 0) };
    }).filter((s) => s.d < Math.max(140, om.width * 0.12)).sort((a, c) => a.d - c.d);
    const cur = b.cur.find((c) => c.n === mk.n);
    if (!scored.length) { fixed.push({ n: mk.n, x: cur.x, y: cur.y, ok: false, why: '번호 옆 글자 없음' }); continue; }
    const anchor = scored[0].l;
    // 새 이미지에서 같은 글자 찾기: 글자 비슷한 정도 + 예상 위치(비율)와 가까운 정도
    const ex = (anchor.x / om.width) * nm.width, ey = (anchor.y / om.height) * nm.height;
    const cands = NL.map((l) => ({ l, s: sim(anchor.t, l.t), d: Math.hypot((l.x - ex) / nm.width, (l.y - ey) / nm.height) }))
      .filter((c) => c.s >= 0.55).sort((a, c) => (c.s - a.s) || (a.d - c.d));
    // 같은 글자가 여러 개면 예상 위치에 가장 가까운 것
    const top = cands.filter((c) => c.s >= cands[0]?.s - 0.08).sort((a, c) => a.d - c.d)[0];
    if (!top) { fixed.push({ n: mk.n, x: cur.x, y: cur.y, ok: false, why: `"${anchor.t}" 를 새 화면에서 못 찾음` }); continue; }
    // 글자 높이 비율로 거리 맞추기 (예전 이미지는 축소본)
    const k = Math.min(3, Math.max(0.5, top.l.h / anchor.h));
    const nx = top.l.x + (mx - anchor.x) * k, ny = top.l.y + top.l.h / 2 + (my - (anchor.y + anchor.h / 2)) * k;
    const px = Math.min(99, Math.max(-2, (nx / nm.width) * 100)), py = Math.min(99, Math.max(1, (ny / nm.height) * 100));
    fixed.push({ n: mk.n, x: +px.toFixed(1), y: +py.toFixed(1), ok: true, by: anchor.t, sim: +top.s.toFixed(2), ox: mk.x, oy: mk.y });
  }
  // 못 찾은 번호: 같은 이미지에서 찾은 번호들이 옮겨 간 모양(가로·세로 각각 직선)으로 위치를 추정
  const good = fixed.filter((f) => f.ok);
  const fit = (pairs) => {
    if (pairs.length < 2) return null;
    const n = pairs.length, sx = pairs.reduce((s, p) => s + p[0], 0), sy = pairs.reduce((s, p) => s + p[1], 0);
    const sxx = pairs.reduce((s, p) => s + p[0] * p[0], 0), sxy = pairs.reduce((s, p) => s + p[0] * p[1], 0);
    const den = n * sxx - sx * sx;
    if (Math.abs(den) < 1e-6) return (v) => v + (sy - sx) / n; // 모두 같은 값이면 평행 이동만
    const a = (n * sxy - sx * sy) / den, c = (sy - a * sx) / n;
    return (v) => a * v + c;
  };
  const fx = fit(good.map((g) => [g.ox, g.x])), fy = fit(good.map((g) => [g.oy, g.y]));
  for (const f of fixed) {
    if (f.ok || !fx || !fy) continue;
    const w = b.was.find((m) => m.n === f.n);
    f.x = +Math.min(99, Math.max(1, fx(w.x))).toFixed(1);
    f.y = +Math.min(99, Math.max(1, fy(w.y))).toFixed(1);
    f.estimated = true;
  }
  report.push({ key: b.key, md: b.md, markers: fixed });
  if (!dry) {
    let md = readFileSync(b.md, 'utf8');
    md = md.replace(/```screen\n([\s\S]*?)```/g, (all, body) => {
      if (!body.includes(`src: ${b.key.split('/').slice(1).join('/')}`)) return all;
      return '```screen\n' + body.replace(/^(\d+): -?[\d.]+ -?[\d.]+$/gm, (line, n) => {
        const f = fixed.find((x) => x.n === n);
        return f ? `${n}: ${f.x} ${f.y}` : line;
      }) + '```';
    });
    writeFileSync(b.md, md);
  }
}
writeFileSync('capture/fit-markers.json', JSON.stringify(report, null, 1));
const all = report.flatMap((r) => r.markers), ok = all.filter((m) => m.ok).length;
const est = all.filter((m) => m.estimated).length;
console.log(`${dry ? '(미리보기) ' : ''}마커 ${all.length}개: 글자로 맞춤 ${ok}, 추정 ${est}, 그대로(확인 필요) ${all.length - ok - est} → capture/fit-markers.json`);
