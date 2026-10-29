// 기존 가이드 HTML(_original/) → content/**/*.md 변환기 (1회성 이전용)
// 먼저 node tools/survey.mjs 로 메뉴(content/_nav.json)와 원본을 받아둔다.
// 사용: node tools/convert.mjs                 전체 (이미 있는 .md는 건너뜀)
//       node tools/convert.mjs bank/bankbook_02.html --force   특정 페이지만 덮어쓰기
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join, dirname, basename } from 'node:path';
import { parse } from 'node-html-parser';

const LEGACY = 'https://srookpay.com/view/new_guide/';
const CIRCLED = '①②③④⑤⑥⑦⑧⑨⑩⑪⑫⑬⑭⑮⑯⑰⑱⑲⑳';
const args = process.argv.slice(2);
const force = args.includes('--force');
const only = args.filter((a) => !a.startsWith('--'));

const nav = JSON.parse(readFileSync('content/_nav.json', 'utf8'));
const sectionOf = Object.fromEntries(nav.map((s) => [s.dir, s.name]));
const pages = new Set();
for (const s of nav) for (const g of s.groups) for (const i of g.items) [i, ...(i.children || [])].forEach((x) => x.href && pages.add(x.href));

const clean = (s) => s.replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim()
  .replace(/&gt;/g, '>').replace(/&lt;/g, '<').replace(/&quot;/g, '"').replace(/&amp;/g, '&');

let page, dir, images, altFallback, converted;

// 이미지: 원본 위치를 절대주소로 풀고 섹션 images/ 폴더에 파일명으로 저장
function imageSrc(img) {
  const url = new URL(img.getAttribute('src').trim(), LEGACY + page).href;
  let name = basename(new URL(url).pathname);
  if (images.has(name) && images.get(name) !== url) name = url.split('/').slice(-2).join('_');
  images.set(name, url);
  return 'images/' + name;
}

function linkHref(href) {
  href = href.trim();
  if (href.startsWith('#') || /^(https?:|mailto:|tel:)/.test(href) && !href.startsWith(LEGACY)) return href;
  const u = new URL(href, LEGACY + page);
  if (!u.href.startsWith(LEGACY)) return u.href;
  const target = u.href.slice(LEGACY.length).split('#')[0];
  if (!converted.has(target)) return u.href; // 새 사이트에 없는 페이지는 기존 사이트로
  const [tdir, file] = target.split('/');
  return (tdir === dir ? file : `../${target}`) + u.hash;
}

function inline(node) {
  return clean(node.childNodes.map((c) => {
    if (c.nodeType === 3) return c.rawText.replace(/\*/g, '\\*'); // 본문의 * 가 굵게 표시로 읽히지 않게
    const tag = c.rawTagName?.toLowerCase();
    if (tag === 'br') return ' ';
    if (tag === 'img') return ` ![${clean(c.getAttribute('alt') || '')}](${imageSrc(c)}) `;
    if (tag === 'a') return `[${inline(c)}](${linkHref(c.getAttribute('href') || '')})`;
    if ((tag === 'b' || tag === 'strong') && clean(c.text)) return ` **${inline(c)}** `;
    return inline(c);
  }).join('')).replace(/\*\*\s+\*\*/g, '');
}

function screen(img) {
  const src = imageSrc(img);
  const alt = clean(img.getAttribute('alt') || '') || altFallback;
  return ['```screen', `src: ${src}`, ...(alt ? [`alt: ${alt}`] : []), '```', ''].join('\n');
}

// 이미지만 있는 요소는 screen 블록, 글이 섞여 있으면 글 + 인라인 이미지
const onlyImages = (el) => el.querySelectorAll('img').length && !clean(el.text.replace(/∘/g, ''));

function textLine(t) {
  t = t.replace(/^∘\s*/, '');
  const m = t.match(/^(\d+)\.\s*(.*)$/);
  return m ? `${m[1]}. ${m[2]}` : `- ${t}`;
}

function convertDl(dl, faq) {
  const md = [];
  for (const el of dl.childNodes.filter((c) => c.nodeType === 1)) {
    const tag = el.rawTagName.toLowerCase();
    if (tag === 'dt') {
      const b = el.querySelector('b');
      if (faq) { altFallback = clean(el.text); md.push(`### ${clean(el.text)}`, ''); continue; }
      if (b && clean(b.text)) {
        let title = clean(b.text);
        const n = CIRCLED.indexOf(title[0]) + 1;
        if (n) title = title.slice(1).trim();
        altFallback = title;
        md.push(`### ${title}${n ? ` {#${n}}` : ''}`, '');
        const span = el.querySelector('span');
        const desc = span ? inline(span).replace(/^:\s*/, '') : '';
        if (desc) md.push(desc, '');
      } else if (clean(el.text) || el.querySelector('img')) {
        md.push(inline(el), ''); // 번호가 문장 안에 있는 단계 설명
      }
    } else if (tag === 'dd') {
      md.push(...blocks(el, { inDd: true }));
    } else {
      md.push(...blocks(el));
    }
  }
  return md;
}

function blocks(node, { inDd = false } = {}) {
  const md = [];
  const kids = node.childNodes;
  // dd 안이 글뿐이면 한 줄 목록 항목
  if (inDd && !kids.some((c) => c.nodeType === 1 && /^(p|ul|ol|dl|div)$/i.test(c.rawTagName))) {
    if (onlyImages(node)) node.querySelectorAll('img').forEach((i) => md.push(screen(i)));
    else if (clean(node.text) || node.querySelector('img')) md.push(textLine(inline(node)), '');
    return md;
  }
  for (const c of kids) {
    if (c.nodeType === 3) { if (clean(c.rawText)) md.push(clean(c.rawText), ''); continue; }
    if (c.nodeType !== 1) continue;
    const tag = c.rawTagName.toLowerCase();
    const cls = c.classList;
    if (cls.contains('right_part') || tag === 'button' || tag === 'h2' || tag === 'script') continue;
    if (c.id && anchors.has(c.id) && !emitted.has(c.id)) { emitted.add(c.id); md.push(`<a id="${c.id}"></a>`, ''); }
    if (tag === 'h3') { altFallback = clean(c.text) + ' 화면'; md.push(`## ${clean(c.text)}`, ''); }
    else if (tag === 'h4') { altFallback = clean(c.text); md.push(`#### ${inline(c)}`, ''); }
    else if (tag === 'p') {
      if (onlyImages(c)) c.querySelectorAll('img').forEach((i) => md.push(screen(i)));
      else if (clean(c.text)) md.push(inInlineDd(inline(c)), '');
    } else if (tag === 'img') md.push(screen(c));
    else if (tag === 'ul' || tag === 'ol') {
      for (const li of c.querySelectorAll('li')) if (clean(li.text)) md.push(textLine(inline(li)));
      md.push('');
    } else if (tag === 'dl') md.push(...convertDl(c, node.classList?.contains('faq-area')));
    else md.push(...blocks(c, { inDd })); // div, section, 오타 태그(dlv 등)는 안으로 들어간다
  }
  return md;
}
const inInlineDd = (t) => t.replace(/^∘\s*/, '');

let anchors, emitted;
async function convert(p) {
  page = p;
  dir = p.split('/')[0];
  const out = join('content', p.replace(/\.html$/, '.md'));
  if (existsSync(out) && !force) return 'skip';
  const root = parse(readFileSync(join('_original', p), 'utf8'), { comment: false });
  const contents = root.querySelector('.contents');
  if (!contents) return 'empty';
  // 페이지 안 링크(#id)가 가리키는 요소에는 앵커를 남긴다
  anchors = new Set(contents.querySelectorAll('a').map((a) => a.getAttribute('href') || '').filter((h) => h.startsWith('#')).map((h) => h.slice(1)));
  emitted = new Set();
  images = images || new Map();
  altFallback = '';
  const title = clean(contents.querySelector('h2')?.text || basename(p, '.html'));
  const md = ['---', `title: ${title}`, `section: ${sectionOf[dir]}`, `updated: ${new Date().toISOString().slice(0, 10)}`, `source: ${LEGACY}${p}`, '---', ''];
  md.push(...blocks(contents));
  mkdirSync(dirname(out), { recursive: true });
  const text = md.join('\n').replace(/\n{3,}/g, '\n\n')
    .replace(/^((?:- |\d+\. ).*)\n\n(?=- |\d+\. )/gm, '$1\n'); // 이어지는 목록 항목은 붙인다
  writeFileSync(out, text.trimEnd() + '\n');
  return 'wrote';
}

// 본문이 없는 페이지(메뉴 묶음용 빈 페이지)는 링크 대상에서 뺀다
converted = new Set([...pages].filter((p) => existsSync(join('_original', p)) && readFileSync(join('_original', p), 'utf8').includes('class="contents"')));
const result = {};
const byDir = {};
for (const p of only.length ? only : pages) {
  images = byDir[p.split('/')[0]] ||= new Map();
  const r = await convert(p);
  (result[r] ||= []).push(p);
}
for (const [k, v] of Object.entries(result)) console.log(k, v.length, k === 'wrote' ? '' : v.join(' '));

// 사용된 이미지 내려받기
let got = 0, miss = [];
for (const [d, map] of Object.entries(byDir)) {
  const imgDir = join('content', d, 'images');
  mkdirSync(imgDir, { recursive: true });
  for (const [name, url] of map) {
    const dest = join(imgDir, name);
    if (existsSync(dest)) continue;
    const res = await fetch(url);
    if (!res.ok) { miss.push(`${d}/${name} (${res.status})`); continue; }
    writeFileSync(dest, Buffer.from(await res.arrayBuffer()));
    got++;
  }
}
console.log(`images downloaded: ${got}`, miss.length ? `missing: ${miss.join(', ')}` : '');
