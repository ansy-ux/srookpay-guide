// 확인한 번호(tools/_labels.txt)와 감지 좌표(tools/_review.json)를 md의 screen 블록에 넣는다 (1회성 이전용)
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const label = {};
for (const line of readFileSync('tools/_labels.txt', 'utf8').trim().split(/\r?\n/)) {
  const [range, nums] = line.split(':');
  const [a, b = a] = range.split('-').map(Number);
  const ns = nums.split(',').map(Number);
  if (ns.length !== b - a + 1) throw new Error('개수 불일치: ' + line);
  ns.forEach((n, i) => (label[a + i] = n));
}
const review = ['tools/_review.json', 'tools/_review_small.json'].flatMap((f) => JSON.parse(readFileSync(f, 'utf8')));
const markersOf = Object.fromEntries(review.map((u) => [u.key, u.found.filter((c) => label[c.id]).map((c) => ({ n: label[c.id], x: c.x, y: c.y }))]));

const groups = JSON.parse(readFileSync('tools/_overviews.json', 'utf8'));
const files = [...new Set(groups.map((g) => g[0].replace(/\\/g, '/')))];
const report = [];
let added = 0;
for (const md of files) {
  const path = join('content', md);
  const dir = md.split('/')[0];
  const s = readFileSync(path, 'utf8');
  const re = /```screen\n([\s\S]*?)```/g;
  let out = '', last = 0, m;
  while ((m = re.exec(s))) {
    const body = m[1];
    const src = body.match(/src: (\S+)/)[1];
    const key = `${dir}/${src}`;
    let block = m[0];
    if (markersOf[key] && !/^\d+: /m.test(body)) {
      // 이 화면이 설명하는 항목 번호: 뒤따르는 ### {#n} 중 번호가 다시 작아지거나 ## 가 나오기 전까지
      const nums = [];
      let prev = 0;
      for (const h of s.slice(re.lastIndex).matchAll(/^(## .*|### .*\{#(\d+)\})\s*$/gm)) {
        if (h[1].startsWith('## ')) break;
        const n = +h[2];
        if (n <= prev) break;
        nums.push(n);
        prev = n;
      }
      if (nums.length) {
        const keep = markersOf[key].filter((mk) => nums.includes(mk.n));
        const dropped = markersOf[key].filter((mk) => !nums.includes(mk.n)).map((mk) => mk.n);
        const missing = nums.filter((n) => !keep.some((k) => k.n === n));
        if (dropped.length || missing.length) report.push(`${md} ${src}:${dropped.length ? ' 설명 없는 번호 ' + dropped.join(',') : ''}${missing.length ? ' 못 찾은 번호 ' + missing.join(',') : ''}`);
        if (keep.length) {
          block = '```screen\n' + body + keep.sort((a, b) => a.n - b.n).map((k) => `${k.n}: ${k.x.toFixed(1)} ${k.y.toFixed(1)}\n`).join('') + '```';
          added += keep.length;
        }
      }
    }
    out += s.slice(last, m.index) + block;
    last = re.lastIndex;
  }
  writeFileSync(path, out + s.slice(last));
}
console.log('added markers:', added);
console.log(report.join('\n'));
