// 이미지를 새 캡처로 바꾼 뒤, 예전 이미지 기준이던 마커 좌표를 새 이미지 기준으로 옮긴다.
//   node tools/remap-markers.mjs <예전 content 폴더> [--dry]
// 예전 이미지: 분홍 배경 + 흰 카드 안에 화면. 새 이미지: 화면만.
//   가로 = 카드 안 비율 그대로 (표·입력칸이 폭에 맞춰 늘어나므로)
//   세로 = 카드 안 위에서부터의 px 그대로 (예전과 지금 관리자의 세로 크기가 1:1)
// 화면 구성이 바뀐 곳은 어긋나므로 ?edit 모드에서 확인해 다듬는다. 바뀐 화면 목록은 capture/remap-log.txt
import sharp from 'sharp';
import { readFileSync, writeFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const oldRoot = process.argv[2];
const dry = process.argv.includes('--dry');
// --images 파일: 이 목록(섹션/images/파일, 한 줄에 하나)에 있는 이미지만 옮긴다. 이미 옮긴 것을 두 번 옮기지 않도록.
const listArg = process.argv.indexOf('--images');
const only = listArg > 0 ? new Set(readFileSync(process.argv[listArg + 1], 'utf8').split('\n').map((s) => s.trim()).filter(Boolean)) : null;
if (!oldRoot || !existsSync(oldRoot)) throw new Error('예전 content 폴더를 지정하세요');
const content = 'content';
const INSET = 20; // 카드 테두리에서 화면 내용이 시작하기까지 여백 (예전 이미지 기준 대략값)

async function cardBox(file) {
  const { data, info } = await sharp(file).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  // 배경색은 위쪽 가운데에서 (모서리는 둥글게 투명 처리된 이미지가 있다)
  const top = ((3 * info.width + (info.width >> 1)) * 4);
  const bg = [...data.subarray(top, top + 3)];
  if (!(bg[0] > 225 && bg[0] - bg[2] > 8)) return null; // 테두리 없는 이미지
  let x0 = info.width, y0 = info.height, x1 = 0, y1 = 0;
  for (let y = 0; y < info.height; y += 2) for (let x = 0; x < info.width; x += 2) {
    const i = (y * info.width + x) * 4;
    if (data[i + 3] < 128) continue; // 투명
    if (Math.abs(data[i] - bg[0]) + Math.abs(data[i + 1] - bg[1]) + Math.abs(data[i + 2] - bg[2]) > 24) {
      if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
    }
  }
  return { w: info.width, h: info.height, x0: x0 + INSET, y0: y0 + INSET, x1: x1 - INSET, y1: y1 - INSET };
}

const same = (a, b) => readFileSync(a).equals(readFileSync(b));
const log = [];
let files = 0, markers = 0;
for (const dir of readdirSync(content, { withFileTypes: true }).filter((d) => d.isDirectory())) {
  for (const f of readdirSync(join(content, dir.name)).filter((f) => f.endsWith('.md'))) {
    const path = join(content, dir.name, f);
    let md = readFileSync(path, 'utf8');
    let changed = false;
    const blocks = [...md.matchAll(/```screen\n([\s\S]*?)```/g)];
    for (const b of blocks.reverse()) {
      const src = (b[1].match(/^src: (.*)$/m) || [])[1]?.trim();
      if (!src) continue;
      const neu = join(content, dir.name, src), old = join(oldRoot, dir.name, src);
      if (!existsSync(neu) || !existsSync(old) || same(neu, old)) continue; // 이미지가 안 바뀜
      if (only && !only.has(`${dir.name}/${src.replace(/^images\//, 'images/')}`)) continue;
      if (!/^\d+: /m.test(b[1])) continue;
      const box = await cardBox(old);
      if (!box) { log.push(`건너뜀(테두리 없음) ${dir.name}/${src}`); continue; }
      const nm = await sharp(neu).metadata();
      let n = 0;
      const body = b[1].replace(/^(\d+): ([\d.]+) ([\d.]+)$/gm, (m, k, x, y) => {
        const px = (x / 100) * box.w, py = (y / 100) * box.h;
        const nx = ((px - box.x0) / (box.x1 - box.x0)) * 100;
        const ny = ((py - box.y0) / nm.height) * 100;
        n++;
        return `${k}: ${Math.min(99, Math.max(1, nx)).toFixed(1)} ${Math.min(99, Math.max(1, ny)).toFixed(1)}`;
      });
      md = md.slice(0, b.index) + '```screen\n' + body + '```' + md.slice(b.index + b[0].length);
      changed = true;
      markers += n;
      log.push(`${dir.name}/${f}  ${src}  마커 ${n}개`);
    }
    if (changed) { files++; if (!dry) writeFileSync(path, md); }
  }
}
writeFileSync('capture/remap-log.txt', log.join('\n') + '\n');
console.log(`${dry ? '(미리보기) ' : ''}md ${files}개, 마커 ${markers}개 옮김 → capture/remap-log.txt`);
