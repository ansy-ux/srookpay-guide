// content/**/*.md → dist/**/*.html
// 마크다운 원고 + ```screen 블록(캡처 이미지 + 마커 좌표)을 가이드 페이지로 만든다.
// 메뉴는 content/_nav.json 에서 읽는다.
import { readFileSync, writeFileSync, mkdirSync, readdirSync, statSync, copyFileSync, rmSync, existsSync } from 'node:fs';
import { join, dirname, relative, extname, posix } from 'node:path';
import { Marked } from 'marked';

const SRC = 'content';
const OUT = 'dist';
const STALE_MONTHS = 12; // 캡처가 이보다 오래되면 "구버전 화면" 안내를 띄운다
const LEGACY = 'https://srookpay.com/view/new_guide/';

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const hasPage = (rel) => existsSync(join(SRC, rel.replace(/\.html$/, '.md')));

// 메뉴: 본문이 없는 상위 메뉴(예: 셀럽션 > 상품관리)는 첫 하위 페이지로 연결한다
const NAV = JSON.parse(readFileSync(join(SRC, '_nav.json'), 'utf8'));
// GNB(상단 메뉴)에서만 빼는 대분류. 페이지와 HOME 사이트맵·검색에는 그대로 남는다.
const GNB_HIDE = new Set(['링크셀러', '무통장자동입금확인']);
for (const s of NAV) for (const g of s.groups) for (const i of g.items) {
  if ((!i.href || !hasPage(i.href)) && i.children) i.href = i.children.find((c) => c.href && hasPage(c.href))?.href;
}

function walk(dir) {
  return readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    return statSync(p).isDirectory() ? walk(p) : [p];
  });
}

function parseFrontmatter(src) {
  const m = src.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n/);
  if (!m) return [{}, src];
  const meta = Object.fromEntries(
    m[1].split(/\r?\n/).filter(Boolean).map((l) => {
      const i = l.indexOf(':');
      return [l.slice(0, i).trim(), l.slice(i + 1).trim()];
    }),
  );
  return [meta, src.slice(m[0].length)];
}

// ```screen 블록: "키: 값" 줄과 "번호: x y" 줄(이미지 대비 %)로 이루어진다.
function parseScreen(text) {
  const screen = { markers: [] };
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/^\s*([^:]+):\s*(.*)$/);
    if (!m) continue;
    const [, key, val] = m;
    if (/^\d+$/.test(key.trim())) {
      // "번호: x y box 왼쪽 위 너비 높이" 처럼 box 를 붙이면 그 영역에 점선 박스를 그린다 (모두 이미지 대비 %)
      const [x, y, kw, ...b] = val.split(/\s+/);
      const box = kw === 'box' && b.length === 4 ? b.map(Number) : null;
      screen.markers.push({ n: Number(key), x: Number(x), y: Number(y), box });
    } else {
      screen[key.trim()] = val.trim();
    }
  }
  return screen;
}

function monthsSince(ym, now) {
  const [y, m] = ym.split('-').map(Number);
  return (now.getFullYear() - y) * 12 + (now.getMonth() + 1 - m);
}

// 이미지 가로·세로(px)를 파일 머리에서 읽는다 (PNG·JPG·GIF). <img> 에 넣어 두면 이미지가 늦게 불려 와도
// 자리가 미리 잡혀서, 번호를 눌러 이동한 위치가 밀리지 않는다.
function imageSize(file) {
  try {
    const b = readFileSync(file);
    if (b.readUInt32BE(0) === 0x89504e47) return [b.readUInt32BE(16), b.readUInt32BE(20)];
    if (b.toString('ascii', 0, 3) === 'GIF') return [b.readUInt16LE(6), b.readUInt16LE(8)];
    if (b[0] === 0xff && b[1] === 0xd8) {
      for (let i = 2; i < b.length - 9;) {
        if (b[i] !== 0xff) { i++; continue; }
        const m = b[i + 1], len = b.readUInt16BE(i + 2);
        if (m >= 0xc0 && m <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(m)) return [b.readUInt16BE(i + 7), b.readUInt16BE(i + 5)];
        i += 2 + len;
      }
    }
  } catch {}
  return null;
}

function renderScreen(s, now, group, dir) {
  const sub = s.style === 'sub';
  const markers = s.markers.map((mk) => {
    const tag = sub ? 'span' : 'a';
    const href = sub ? '' : ` href="#m-${group}-${mk.n}"`;
    const box = mk.box ? ` data-box="${mk.box.join(' ')}"` : '';
    return `<${tag} class="mk${sub ? ' mk-sub' : ''}" data-n="${mk.n}"${box}${href} style="left:${mk.x}%;top:${mk.y}%">${mk.n}</${tag}>`;
  }).join('');
  // 박스는 번호보다 먼저 그려서 번호 아래에 깔리게 한다
  const boxes = s.markers.filter((mk) => mk.box).map(({ n, box: [l, t, w, h] }) =>
    `<span class="bx" data-n="${n}" style="left:${l}%;top:${t}%;width:${w}%;height:${h}%"></span>`).join('');
  const stale = s.captured && monthsSince(s.captured, now) > STALE_MONTHS
    ? `<p class="stale">이 화면은 ${esc(s.captured)} 캡처본이라 지금 화면과 다를 수 있어요.</p>` : '';
  const cap = s.captured ? ` data-captured="${esc(s.captured)}"` : '';
  const size = dir && imageSize(join(dir, s.src));
  return `<figure class="screen${sub ? ' screen-sub' : ''}" data-src="${esc(s.src)}"${cap}${sub ? ' data-style="sub"' : ''}>
  ${stale}<div class="shot"><img src="${esc(s.src)}" alt="${esc(s.alt || '')}"${size ? ` width="${size[0]}" height="${size[1]}"` : ''} loading="lazy">${boxes}${markers}</div>
</figure>`;
}

function renderPage(file, now) {
  const [meta, body] = parseFrontmatter(readFileSync(file, 'utf8'));
  const marked = new Marked();
  const tokens = marked.lexer(body);
  const toc = [];
  let html = '';
  let open = false;
  let group = 0; // ## 단위로 번호가 다시 ①부터 시작하므로 id를 묶음별로 나눈다
  let lastN = 0;

  // 화면 블록은 뒤따르는 번호 항목과 같은 묶음이어야 하므로, 항목별 묶음 번호를 미리 계산한다
  const numOf = (t) => t.type === 'heading' && t.depth === 3 && Number((t.text.match(/\{#(\d+)\}\s*$/) || [])[1]) || 0;
  const groupAt = [];
  for (let i = 0, g = 0, last = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (t.type === 'heading' && t.depth === 2) { g++; last = 0; }
    const n = numOf(t);
    if (n && n <= last) g++;
    if (n) last = n;
    groupAt[i] = g;
  }
  const screenGroup = (i) => {
    for (let j = i + 1; j < tokens.length; j++) {
      if (tokens[j].type === 'heading' && tokens[j].depth === 2) break;
      if (numOf(tokens[j])) return groupAt[j];
    }
    return groupAt[i];
  };

  for (const [i, t] of tokens.entries()) {
    if (t.type === 'code' && t.lang === 'screen') {
      html += renderScreen(parseScreen(t.text), now, screenGroup(i) || 1, dirname(file));
      continue;
    }
    if (t.type === 'heading' && t.depth === 3) {
      const m = t.text.match(/^(.*?)\s*\{#(\d+)\}\s*$/);
      const title = m ? m[1] : t.text;
      const n = m ? Number(m[2]) : null;
      // ## 없이 번호가 다시 1부터 시작하면(예: 은행별 안내) 새 묶음으로 본다
      if (n && n <= lastN) group += 1;
      if (n) lastN = n;
      if (open) html += '</section>';
      open = true;
      const id = n ? `m-${group || 1}-${n}` : `s-${toc.length + 1}`;
      toc.push({ id, title, n });
      html += `<section class="item" id="${id}"><h3>${n ? `<span class="num">${n}</span>` : ''}${marked.parseInline(title)}</h3>`;
      continue;
    }
    if (t.type === 'heading' && t.depth === 2) {
      if (open) { html += '</section>'; open = false; }
      group += 1;
      lastN = 0;
      toc.push({ group: t.text, id: `g-${group}` });
      html += `<h2 id="g-${group}">${marked.parseInline(t.text)}</h2>`;
      continue;
    }
    const chunk = [t];
    chunk.links = tokens.links;
    html += marked.parser(chunk);
  }
  if (open) html += '</section>';
  return { meta, html, toc };
}

// 기존 사이트 주소 중 새 사이트에 있는 페이지는 상대 주소로 바꾸고, 깨진 링크를 모은다
const broken = [];
function fixLinks(html, relPath) {
  const here = posix.dirname(relPath);
  return html.replace(/href="([^"]+)"/g, (all, href) => {
    let target = null, hash = '';
    if (href.startsWith(LEGACY)) [target, hash = ''] = href.slice(LEGACY.length).split(/(?=#)/);
    else if (!/^(https?:|mailto:|tel:|#)/.test(href)) [target, hash = ''] = [posix.normalize(posix.join(here, href.split('#')[0])), href.includes('#') ? '#' + href.split('#')[1] : ''];
    if (!target || !target.endsWith('.html')) return all;
    if (hasPage(target)) return `href="${posix.relative(here, target)}${hash}"`;
    if (!href.startsWith(LEGACY)) broken.push(`${relPath} → ${href}`);
    return all;
  });
}

function layout(relPath, { meta, html, toc }) {
  const root = '../'.repeat(relPath.split('/').length - 1);
  const dir = relPath.split('/')[0];
  const section = NAV.find((s) => s.dir === dir);
  const link = (href) => (href.startsWith('http') ? href : root + href);
  // 맨 앞 홈 아이콘 → 판매관리자 첫 화면 안내(home/main)
  const home = `<a class="home${dir === 'home' ? ' on' : ''}" href="${root}home/main.html" title="HOME"><img src="${root}assets/ico_home.svg" alt="HOME" width="24" height="20"></a>`;
  const topMenu = home + NAV.filter((s) => !GNB_HIDE.has(s.name)).map((s) => `<a href="${link(s.entry)}"${s === section ? ' class="on"' : ''}>${esc(s.name)}</a>`).join('')
    + `<a class="all${relPath === 'sitemap.html' ? ' on' : ''}" href="${root}sitemap.html">전체메뉴</a>`;
  const navItem = (i) => {
    const kids = i.children?.filter((c) => c.href && c.href !== i.href || i.children.length > 1) || [];
    const active = i.href === relPath || kids.some((c) => c.href === relPath);
    const sub = kids.length ? `<ul class="sub${active ? ' open' : ''}">${kids.map((c) =>
      `<li${c.href === relPath ? ' class="on"' : ''}><a href="${link(c.href)}">${esc(c.name)}</a></li>`).join('')}</ul>` : '';
    return `<li class="${active ? 'on' : ''}${kids.length ? ' has-sub' : ''}"><a href="${link(i.href)}">${esc(i.name)}</a>${sub}</li>`;
  };
  // HOME 은 메뉴 트리에 없는 페이지라, 왼쪽 메뉴에 이 페이지의 묶음(## 메뉴, ## 쇼핑몰 현황)을 바로가기로 보여준다
  const side = dir === 'home'
    ? `<h4>HOME</h4><ul>${toc.filter((t) => t.group).map((t) => `<li><a href="#${t.id}">${esc(t.group)}</a></li>`).join('')}</ul>`
    : (section?.groups || []).map((g) => `<h4>${esc(g.title)}</h4><ul>${g.items.map(navItem).join('')}</ul>`).join('');
  const tocHtml = toc.map((t) => t.group ? `<li class="grp"><a href="#${t.id}">${esc(t.group)}</a></li>` : `<li><a href="#${t.id}">${t.n ? `<span>${t.n}</span>` : ''}${esc(t.title)}</a></li>`).join('');

  return `<!doctype html>
<html lang="ko">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>스룩페이 매뉴얼${meta.title ?` - ${esc(meta.title)}` : ''}</title>
<link rel="icon" href="${root}assets/favicon.ico" sizes="any">
<link rel="icon" type="image/png" href="${root}assets/favicon_32.png" sizes="32x32">
<link rel="apple-touch-icon" href="${root}assets/favicon_152.png">
<link rel="stylesheet" href="${root}assets/guide.css">
</head>
<body data-root="${root}">
<header class="top">
  <div class="top-row">
    <div class="brand"><a href="${root}home/main.html"><img src="${root}assets/logo-srookpay.png" alt="srookpay" width="200" height="43"><span>판매관리자 매뉴얼</span></a></div>
    <div class="search" role="search">
      <input type="search" id="q" placeholder="궁금한 기능을 검색해 보세요 (예: 송장, 배송비)" autocomplete="off" aria-label="매뉴얼 검색" aria-controls="q-results">
      <label for="q" class="search-ico" title="검색 (단축키 /)"><svg aria-hidden="true" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/></svg></label>
      <ul id="q-results" class="results" role="listbox" hidden></ul>
    </div>
  </div>
  <nav class="gnb">${topMenu}</nav>
</header>
<div class="wrap">
  <aside class="side">
    <a class="admin" href="https://srookpay.com/newsrp/Main/Index" target="_blank" rel="noopener">판매관리자 바로가기<svg class="ico" aria-hidden="true" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 3h6v6"/><path d="M10 14 21 3"/><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/></svg></a>
    ${side}
  </aside>
  <main class="doc">
    ${meta.title ? `<h1>${esc(meta.title)}</h1>
    <p class="meta">${esc(meta.section || '')}${meta.updated ? ` · 최종 수정 ${esc(meta.updated)}` : ''}</p>` : ''}
    ${fixLinks(html, relPath)}
  </main>
  ${toc.length ? `<nav class="toc" aria-label="이 페이지 목차"><ol>${tocHtml}</ol></nav>` : '<div></div>'}
</div>
<button type="button" class="to-top" aria-label="맨 위로" title="맨 위로" hidden><svg aria-hidden="true" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m5 12 7-7 7 7"/><path d="M12 19V5"/></svg></button>
<script src="${root}assets/guide.js"></script>
</body>
</html>
`;
}

// 검색 색인: 페이지를 묶음(##)·항목(###) 단위로 잘라 제목과 본문 글자만 남긴다
const searchIndex = [];
const plain = (h) => h.replace(/<figure[\s\S]*?<\/figure>/g, ' ').replace(/<[^>]+>/g, ' ')
  .replace(/&nbsp;/g, ' ').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&')
  .replace(/\s+/g, ' ').trim();
function indexPageText(relPath, meta, html) {
  let group = '';
  for (const chunk of html.split(/(?=<h2 id="g-|<section class="item" id=")/)) {
    const h2 = chunk.match(/^<h2 id="(g-\d+)">([\s\S]*?)<\/h2>/);
    const item = chunk.match(/^<section class="item" id="([^"]+)"><h3>(?:<span class="num">\d+<\/span>)?([\s\S]*?)<\/h3>/);
    if (h2) group = plain(h2[2]);
    const id = h2?.[1] || item?.[1] || '';
    const heading = item ? plain(item[2]) : h2 ? group : '';
    const text = plain(chunk.slice((h2 || item)?.[0].length || 0));
    if (!heading && !text) continue;
    searchIndex.push({ u: relPath + (id ? '#' + id : ''), p: meta.title, s: meta.section, g: item ? group : '', h: heading, x: text.slice(0, 3000) });
  }
}

// 전체메뉴(GNB 오른쪽 링크): 전체 메뉴 한눈에 보기
function sitemapPage() {
  const body = NAV.map((s) => `<section class="map-sec"><h2><a href="${s.entry}">${esc(s.name)}</a></h2>${s.groups.map((g) =>
    `<ul>${g.items.map((i) => `<li><a href="${i.href}">${esc(i.name)}</a>${i.children?.length > 1 ? `<ul>${i.children.map((c) =>
      `<li><a href="${c.href}">${esc(c.name)}</a></li>`).join('')}</ul>` : ''}</li>`).join('')}</ul>`).join('')}</section>`).join('');
  return layout('sitemap.html', { meta: { title: '전체메뉴' }, html: `<div class="sitemap">${body}</div>`, toc: [] });
}

// 사이트 주소(/)로 들어오면 HOME 으로 보낸다
const indexPage = () => `<!doctype html>
<html lang="ko"><head><meta charset="utf-8"><title>스룩페이 매뉴얼</title>
<meta http-equiv="refresh" content="0; url=home/main.html"><link rel="canonical" href="home/main.html"></head>
<body><a href="home/main.html">스룩페이 매뉴얼 HOME 으로 이동</a></body></html>
`;

const now = new Date();
rmSync(OUT, { recursive: true, force: true });
let count = 0;
for (const file of walk(SRC)) {
  const rel = relative(SRC, file).replace(/\\/g, '/');
  if (rel.startsWith('_')) continue;
  const dest = join(OUT, rel);
  mkdirSync(dirname(dest), { recursive: true });
  if (extname(file) === '.md') {
    const relHtml = rel.replace(/\.md$/, '.html');
    const page = renderPage(file, now);
    indexPageText(relHtml, page.meta, page.html);
    writeFileSync(join(OUT, relHtml), layout(relHtml, page));
    count++;
  } else {
    copyFileSync(file, dest);
  }
}
writeFileSync(join(OUT, 'sitemap.html'), sitemapPage());
writeFileSync(join(OUT, 'index.html'), indexPage());
mkdirSync(join(OUT, 'assets'), { recursive: true });
for (const f of readdirSync('assets')) copyFileSync(join('assets', f), join(OUT, 'assets', f));
writeFileSync(join(OUT, 'assets', 'search.json'), JSON.stringify(searchIndex));
console.log(`pages: ${count} + index → ${OUT} (검색 항목 ${searchIndex.length}개)`);
if (broken.length) console.warn(`깨진 링크 ${broken.length}개:\n  ` + broken.join('\n  '));
