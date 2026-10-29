// 기존 사이트 전체 메뉴(2단계 포함)를 content/_nav.json 으로 뽑고, 원본 HTML을 _original/<섹션>/ 에 저장한다.
// 저장한 원본의 요소 사용 현황도 출력한다 (변환기가 처리하지 못하는 구조 찾기용).
import { parse } from 'node-html-parser';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

const LEGACY = 'https://srookpay.com/view/new_guide/';
const TOP = ['setting/info01', 'goods/goods_01', 'order/state', 'member/member', 'supply/order01', 'sms/set',
  'accounts/sales', 'affiliate/ecount', 'celeb/celeb_01', 'bank/bankbook_01'];

// 페이지 기준 상대 주소 → 'dir/file.html' (사이트 밖이면 null)
const resolve = (href, base) => {
  if (!href || href.startsWith('#') || href.startsWith('javascript')) return null;
  const u = new URL(href, LEGACY + base);
  return u.href.startsWith(LEGACY) ? u.href.slice(LEGACY.length).split('#')[0] : null;
};

const nav = [];
const pages = new Set();
for (const entry of TOP) {
  const base = entry + '.html';
  const root = parse(await (await fetch(LEGACY + base)).text());
  const name = root.querySelectorAll('.gnb a, nav a, a').find((a) => resolve(a.getAttribute('href'), base) === base && a.text.trim())?.text.trim();
  const groups = [];
  let cur;
  for (const el of root.querySelector('.lnb').childNodes.filter((c) => c.nodeType === 1)) {
    if (el.classList.contains('tit')) groups.push((cur = { title: el.text.trim(), items: [] }));
    else if (el.rawTagName === 'ul') {
      for (const li of el.childNodes.filter((c) => c.rawTagName === 'li')) {
        const a = li.querySelector(':scope > a');
        const item = { name: a?.text.trim() || li.childNodes.find((c) => c.nodeType === 3 && c.text.trim())?.text.trim(), href: resolve(a?.getAttribute('href'), base) };
        const kids = li.querySelectorAll('.depth2 a').map((k) => ({ name: k.text.replace(/^·\s*/, '').trim(), href: resolve(k.getAttribute('href'), base) }));
        if (kids.length) item.children = kids;
        cur.items.push(item);
        [item, ...kids].forEach((i) => i.href && pages.add(i.href));
      }
    }
  }
  nav.push({ name, dir: entry.split('/')[0], entry: base, groups });
}
writeFileSync('content/_nav.json', JSON.stringify(nav, null, 2));

const stats = {};
for (const p of pages) {
  const html = await (await fetch(LEGACY + p)).text();
  mkdirSync(dirname(`_original/${p}`), { recursive: true });
  writeFileSync(`_original/${p}`, html);
  const c = parse(html, { comment: false }).querySelector('.contents');
  if (!c) { console.log('NO .contents', p); continue; }
  for (const el of c.querySelectorAll('*')) {
    const k = el.rawTagName.toLowerCase() + (el.classList.length ? '.' + [...el.classList.values()].join('.') : '');
    (stats[k] ||= new Set()).add(p);
  }
}
for (const s of nav) console.log(s.name, s.dir, s.groups.map((g) => `${g.title}(${g.items.length})`).join(' '));
console.log('pages:', pages.size);
for (const [k, v] of Object.entries(stats).sort((a, b) => b[1].size - a[1].size)) console.log(k.padEnd(28), v.size, v.size < 6 ? [...v].join(' ') : '');
