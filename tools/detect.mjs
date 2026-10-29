// 캡처 이미지에 그려진 빨간 번호 동그라미를 찾아 마커 좌표(%)와 번호를 추정한다 (1회성 이전용).
// 번호 인식: 이미 마커를 손으로 맞춘 상품관리(goods) 이미지에서 숫자 모양 견본을 만들어 가장 비슷한 것을 고른다.
// 사용: node tools/detect.mjs  →  tools/_detected.json
import sharp from 'sharp';
import { readFileSync, writeFileSync, readdirSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';

const G = 20; // 숫자 모양 특징 격자 크기
// --small: 1차에서 하나도 못 찾은 이미지만 작은 동그라미(반지름 5px~)까지 다시 찾는다
const SMALL = process.argv.includes("--small");
const MIN_R = SMALL ? 5 : 8;

async function load(file) {
  const { data, info } = await sharp(file).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const { width: w, height: h } = info;
  const red = new Uint8Array(w * h);
  for (let i = 0; i < w * h; i++) {
    const r = data[i * 4], g = data[i * 4 + 1], b = data[i * 4 + 2];
    red[i] = SMALL ? (r > 150 && r - g > 30 && r - b > 25 ? 1 : 0) // 얇고 흐린 테두리(JPEG)
      : (r > 150 && r - g > 60 && r - b > 50 ? 1 : 0);
  }
  return { w, h, red };
}

// 원 모양 탐색: 중심 후보마다 반지름 8~20px 원 위 점들이 빨간지 본다.
// (동그라미가 옆의 빨간 박스와 붙어 있어도 찾을 수 있게 덩어리 대신 원 둘레로 판단)
function circles({ w, h, red }) {
  // 1px 번진 마스크 (얇거나 끊긴 테두리 대비)
  const fat = new Uint8Array(w * h);
  for (let y = 1; y < h - 1; y++) for (let x = 1; x < w - 1; x++) {
    const i = y * w + x;
    fat[i] = red[i] | red[i - 1] | red[i + 1] | red[i - w] | red[i + w];
  }
  const at = (x, y) => (x < 0 || y < 0 || x >= w || y >= h ? 0 : fat[(y | 0) * w + (x | 0)]);
  const N = 32;
  const cos = Array.from({ length: N }, (_, k) => Math.cos((k / N) * 2 * Math.PI));
  const sin = Array.from({ length: N }, (_, k) => Math.sin((k / N) * 2 * Math.PI));
  const cands = [];
  for (let r = MIN_R; r <= 20; r++) {
    for (let y = r; y < h - r; y++) for (let x = r; x < w - r; x++) {
      if (!at(x + r, y) || !at(x - r, y) || !at(x, y + r) || !at(x, y - r)) continue;
      let on = 0, out = 0, mid = 0;
      for (let k = 0; k < N; k++) {
        on += at(x + cos[k] * r, y + sin[k] * r);
        out += at(x + cos[k] * (r + 3), y + sin[k] * (r + 3));
        mid += at(x + cos[k] * r * 0.82, y + sin[k] * r * 0.82);
      }
      if (on < N * 0.9 || out > N * 0.45 || mid > N * 0.6) continue;
      cands.push({ cx: x, cy: y, r, score: on - out * 0.5 - mid * 0.5 });
    }
  }
  // 겹치는 후보 중 가장 좋은 것만
  cands.sort((a, b) => b.score - a.score || b.r - a.r);
  const out = [];
  for (const c of cands) {
    if (out.some((o) => Math.hypot(o.cx - c.cx, o.cy - c.cy) < Math.max(o.r, c.r))) continue;
    out.push(c);
  }
  return out.map((c) => ({ ...c, feat: feature({ w, red }, c.cx, c.cy, c.r) }));
}

// 동그라미 안쪽(테두리 제외)의 빨간 점 분포를 G×G 격자로
function feature({ w, red }, cx, cy, r) {
  const f = new Float32Array(G * G);
  const ir = r * 0.68;
  for (let gy = 0; gy < G; gy++) for (let gx = 0; gx < G; gx++) {
    let s = 0, c = 0;
    for (let sy = 0; sy < 3; sy++) for (let sx = 0; sx < 3; sx++) {
      const x = cx - ir + ((gx + (sx + 0.5) / 3) / G) * 2 * ir;
      const y = cy - ir + ((gy + (sy + 0.5) / 3) / G) * 2 * ir;
      if ((x - cx) ** 2 + (y - cy) ** 2 > ir * ir) continue;
      c++; s += red[Math.round(y) * w + Math.round(x)];
    }
    f[gy * G + gx] = c ? s / c : 0;
  }
  // 굵기 차이를 줄이려고 정규화
  const norm = Math.hypot(...f) || 1;
  return f.map((v) => v / norm);
}

const dist = (a, b) => { let s = 0; for (let i = 0; i < a.length; i++) s += (a[i] - b[i]) ** 2; return Math.sqrt(s); };

function walk(d) {
  return readdirSync(d).flatMap((f) => {
    const p = join(d, f);
    return statSync(p).isDirectory() ? (f === 'images' ? [] : walk(p)) : p.endsWith('.md') ? [p] : [];
  });
}
const screens = (file) => [...readFileSync(file, 'utf8').matchAll(/```screen\n([\s\S]*?)```/g)].map((m) => m[1]);

// 1) 견본 만들기: goods 의 원형 마커와 감지된 동그라미를 짝지음
const templates = [];
for (const f of walk('content/goods')) for (const body of screens(f)) {
  if (/style: sub/.test(body)) continue;
  const marks = [...body.matchAll(/^(\d+): ([\d.]+) ([\d.]+)$/gm)].map((m) => ({ n: +m[1], x: +m[2], y: +m[3] }));
  if (!marks.length) continue;
  const src = join(dirname(f), body.match(/src: (\S+)/)[1]);
  const img = await load(src);
  for (const c of circles(img)) {
    const x = (c.cx / img.w) * 100, y = (c.cy / img.h) * 100;
    const m = marks.find((m) => Math.abs(m.x - x) < 2.5 && Math.abs(m.y - y) < 2.5 * (img.w / img.h));
    if (m) templates.push({ n: m.n, feat: c.feat });
  }
}
console.log('templates:', templates.length, 'numbers:', [...new Set(templates.map((t) => t.n))].sort((a, b) => a - b).join(','));

// 2) 나머지 섹션의 전체 화면 이미지 감지
let groups = JSON.parse(readFileSync("tools/_overviews.json", "utf8"));
if (SMALL) { const prev = JSON.parse(readFileSync("tools/_detected.json", "utf8")); const none = new Set(prev.filter((g) => g.status === "none").map((g) => g.md + g.src)); groups = groups.filter(([md, src]) => none.has(md.replace(/\\/g, "/") + src)); }
const done = {};
const result = [];
for (const [md, src, items] of groups) {
  const file = join('content', dirname(md), src);
  const key = file;
  if (!done[key]) {
    const img = await load(file);
    done[key] = circles(img).map((c) => {
      const ranked = templates.map((t) => ({ n: t.n, d: dist(t.feat, c.feat) })).sort((a, b) => a.d - b.d);
      const best = ranked[0];
      const other = ranked.find((r) => r.n !== best.n);
      return { n: best.n, x: +((c.cx / img.w) * 100).toFixed(1), y: +((c.cy / img.h) * 100).toFixed(1), d: +best.d.toFixed(3), margin: +(other.d - best.d).toFixed(3), px: [Math.round(c.cx), Math.round(c.cy)] };
    });
  }
  const found = done[key];
  const ns = found.map((c) => c.n).sort((a, b) => a - b);
  const want = Array.from({ length: items }, (_, i) => i + 1);
  const exact = ns.length === items && ns.every((n, i) => n === want[i]);
  result.push({ md: md.replace(/\\/g, '/'), src, items, found, status: exact ? 'ok' : found.length ? 'check' : 'none' });
}
writeFileSync(SMALL ? "tools/_detected_small.json" : "tools/_detected.json", JSON.stringify(result, null, 1));
const by = result.reduce((a, r) => ((a[r.status] = (a[r.status] || 0) + 1), a), {});
console.log(by);
