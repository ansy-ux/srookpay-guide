// 판매관리자 화면 자동 캡처
//   node tools/capture.mjs login      브라우저 창이 열리면 직접 로그인 → 세션을 .auth/state.json 에 저장
//   node tools/capture.mjs discover   로그인 세션으로 관리자 메뉴 주소를 모아 capture/admin-menu.json 에 저장
//   node tools/capture.mjs run        capture/targets.json 의 화면을 캡처해 지금 이미지와 비교, 보고서 생성
//   node tools/capture.mjs run --apply   바뀐 캡처를 content/ 에 반영하고 captured 날짜 갱신
//   node tools/capture.mjs scaffold   가이드의 모든 화면 이미지로 capture/targets.json 틀 생성 (이미 채운 항목은 유지)
// 공통 옵션: --config <파일>  --only <id,id>  --headed
import { chromium } from 'playwright-core';
import sharp from 'sharp';
import pixelmatch from 'pixelmatch';
import { readFileSync, writeFileSync, mkdirSync, existsSync, copyFileSync, readdirSync, statSync } from 'node:fs';
import { join, dirname, relative } from 'node:path';
import { unfix, sectionClip, maskPrivate } from './capture-lib.mjs';

const args = process.argv.slice(2);
const mode = args[0];
const opt = (name) => { const i = args.indexOf('--' + name); return i < 0 ? null : args[i + 1]; };
const flag = (name) => args.includes('--' + name);
const configPath = opt('config') || 'capture/targets.json';
const STATE = '.auth/state.json';

// Windows 에 설치된 Edge 를 쓴다 (별도 브라우저 내려받기 불필요). 없으면 Chrome.
async function launch(headed) {
  // 최신 Edge/Chrome 은 예전 headless 모드를 지원하지 않으므로 새 headless(--headless=new)로 띄운다
  for (const channel of ['msedge', 'chrome']) {
    try {
      const browser = await chromium.launch({ channel, headless: false, args: headed ? [] : ['--headless=new', '--hide-scrollbars'] });
      console.log(`브라우저: ${channel}`);
      return browser;
    } catch { /* 다음 후보 */ }
  }
  throw new Error('Edge 또는 Chrome 을 찾을 수 없습니다.');
}

// 가릴 단어(판매자·부계정 아이디, 계정명 등). 공개 저장소에 남지 않도록 .auth/ 안에만 둔다.
const maskWords = existsSync('.auth/mask-words.json') ? JSON.parse(readFileSync('.auth/mask-words.json', 'utf8')).words || [] : [];
const config = existsSync(configPath) ? JSON.parse(readFileSync(configPath, 'utf8')) : null;
const base = config?.baseUrl || 'https://srookpay.com';
const viewport = config?.viewport || { width: 1440, height: 900 };

if (mode === 'login') {
  // 비밀번호는 사람이 직접 입력한다. 스크립트는 로그인 후 쿠키만 저장.
  const browser = await launch(true);
  const context = await browser.newContext({ viewport });
  const page = await context.newPage();
  await page.goto(base + '/member/login');
  console.log('열린 창에서 캡처 전용 계정(조회 권한 부계정 권장)으로 로그인하세요.');
  console.log('관리자 화면이 뜨면 자동 저장됩니다. 저장되지 않으면 이 터미널에서 Enter 를 누르세요.');
  // 관리자 주소 형식을 모르므로 /newsrp/ 로 넘어가거나 사람이 Enter 를 누르면 저장한다.
  const enter = new Promise((res) => process.stdin.once('data', res));
  await Promise.race([page.waitForURL(/\/newsrp\//i, { timeout: 0 }), enter]);
  mkdirSync(dirname(STATE), { recursive: true });
  await context.storageState({ path: STATE });
  const admin = page.url();
  writeFileSync(join(dirname(STATE), 'admin-url.txt'), admin);
  console.log('세션 저장:', STATE);
  console.log('현재 화면 주소:', admin);
  await browser.close();
  process.exit(0);
} else if (mode === 'discover') {
  const browser = await launch(flag('headed'));
  const context = await browser.newContext({ viewport, storageState: STATE });
  const page = await context.newPage();
  const adminFile = join(dirname(STATE), 'admin-url.txt');
  const start = existsSync(adminFile) ? readFileSync(adminFile, 'utf8').trim() : base + '/newsrp/Main/Index';
  await page.goto(start);
  console.log('시작 주소:', start, '→', page.url());
  if (/\/member\/login/i.test(page.url())) throw new Error('로그인 세션이 없거나 만료됐습니다. login 을 먼저 실행하세요.');
  // 첫 화면과 전체메뉴 화면에서 같은 사이트 안의 /newsrp/ 링크를 모은다 (로그인·로그아웃·공지 제외)
  const origin = new URL(page.url()).origin;
  const collect = () => page.$$eval('a[href]', (as) => as.map((a) => ({ name: a.textContent.trim().replace(/\s+/g, ' '), href: a.href })));
  const links = await collect();
  await page.goto(origin + '/newsrp/Popup/menuAll');
  links.push(...await collect());
  const menu = links.filter((l) => l.name && l.href.startsWith(origin + '/newsrp/') && !/logout|login|#/i.test(l.href))
    .map((l) => ({ ...l, href: l.href.slice(origin.length) }));
  const uniq = [...new Map(menu.map((l) => [l.href, l])).values()];
  mkdirSync('capture', { recursive: true });
  writeFileSync('capture/admin-menu.json', JSON.stringify(uniq, null, 2));
  console.log(`관리자 메뉴 ${uniq.length}개 → capture/admin-menu.json`);
  await browser.close();
} else if (mode === 'run') {
  if (!config) throw new Error(`${configPath} 가 없습니다.`);
  const contentDir = config.contentDir || 'content';
  const only = opt('only')?.split(',');
  const targets = config.targets.filter((t) => t.url && (!only || only.includes(t.id)));
  console.log(`캡처 대상 ${targets.length}개 (주소 미입력 ${config.targets.filter((t) => !t.url).length}개는 건너뜀)`);
  const stamp = new Date().toISOString().slice(0, 19).replace(/[-:T]/g, '');
  const outDir = join('capture', 'out', stamp);
  const browser = await launch(flag('headed'));
  const context = await browser.newContext({ viewport, deviceScaleFactor: 1, storageState: existsSync(STATE) ? STATE : undefined });
  const page = await context.newPage();
  page.setDefaultTimeout(config.timeout || 15000);
  const results = [];

  for (const t of targets) {
    const r = { id: t.id, image: t.image, url: t.url };
    try {
      // 계속 통신하는 화면도 있어서 networkidle 은 최대 5초만 기다린다
      await page.goto(new URL(t.url, base).href, { waitUntil: 'load' });
      await page.waitForLoadState('networkidle', { timeout: 5000 }).catch(() => {});
      if (config.requireLogin && !page.url().includes('/newsrp/')) throw new Error('로그인 세션 만료 (login 다시 실행)');
      for (const s of t.steps || []) {
        if (s.click) await page.click(s.click);
        if (s.fill) await page.fill(s.fill[0], s.fill[1]);
        if (s.wait) await page.waitForSelector(s.wait);
        if (s.sleep) await page.waitForTimeout(s.sleep);
        if (s.eval) await page.evaluate(s.eval);
      }
      // 개인정보 등 가릴 부분: 공통 + 화면별
      const mask = [...(config.mask || []), ...(t.mask || [])];
      if (mask.length) await page.addStyleTag({ content: `${mask.join(',')} { color: transparent !important; background: #dddddd !important; border-color: #dddddd !important; } ${mask.map((m) => m + ' *').join(',')} { visibility: hidden !important; }` });
      // 캡처 중 깜빡임 방지: 애니메이션·커서 끄기
      await page.addStyleTag({ content: '*,*::before,*::after{animation:none!important;transition:none!important;caret-color:transparent!important}' });
      await unfix(page, !!t.steps?.length);
      if (config.privacy !== false) await maskPrivate(page, maskWords); // 개인정보 회색 막대로 가리기 (끄려면 설정에 "privacy": false)
      // from(+to): 본문 안 묶음 제목 기준으로 자른다. from 제목부터 to 제목 바로 위까지 (to 가 없으면 from 묶음 하나)
      // selector 하나면 그 요소만, include 가 있으면 여러 요소를 합친 영역(예: 버튼 + 펼쳐진 목록), pad 만큼 여백
      // 화면별 selector 가 없으면 설정의 기본 selector (관리자 본문 #contents)
      const selector = t.selector || config.selector;
      let shot;
      if (t.from) {
        shot = await page.screenshot({ clip: await sectionClip(page, t.root || config.selector || '#contents', t.from, t.to), fullPage: true });
      } else if (t.include?.length) {
        const boxes = [];
        for (const sel of [selector, ...t.include].filter(Boolean)) {
          const loc = page.locator(sel).first();
          await loc.waitFor();
          boxes.push(await loc.boundingBox());
        }
        const pad = t.pad || 0;
        const x = Math.max(0, Math.min(...boxes.map((b) => b.x)) - pad), y = Math.max(0, Math.min(...boxes.map((b) => b.y)) - pad);
        const clip = { x, y, width: Math.max(...boxes.map((b) => b.x + b.width)) + pad - x, height: Math.max(...boxes.map((b) => b.y + b.height)) + pad - y };
        shot = await page.screenshot({ clip, fullPage: true });
      } else if (selector) {
        // 요소 캡처는 스크롤을 일으켜 상단 메뉴가 고정되며 본문을 가리므로, 좌표로 잘라 전체 페이지에서 찍는다
        const loc = page.locator(selector).first();
        await loc.waitFor();
        const b = await loc.boundingBox();
        shot = await page.screenshot({ clip: { x: b.x, y: b.y, width: b.width, height: b.height }, fullPage: true });
      } else {
        shot = await page.screenshot({ fullPage: !!t.fullPage });
      }
      // 긴 목록은 위쪽만 (maxHeight: 화면별 > 설정, 0 이면 자르지 않음)
      const maxH = t.maxHeight ?? config.maxHeight ?? 0;
      const meta = await sharp(shot).metadata();
      if (maxH && meta.height > maxH) shot = await sharp(shot).extract({ left: 0, top: 0, width: meta.width, height: maxH }).png().toBuffer();
      const dest = join(outDir, t.image);
      mkdirSync(dirname(dest), { recursive: true });
      // 캡처는 PNG 로 나오므로 기존 파일이 .jpg 면 형식을 맞춘다 (파일명·md는 그대로)
      writeFileSync(dest, /\.jpe?g$/i.test(dest) ? await sharp(shot).jpeg({ quality: 92 }).toBuffer() : shot);
      r.out = dest;
      Object.assign(r, await compare(join(contentDir, t.image), dest, join(outDir, '_diff', t.image)));
    } catch (e) {
      r.status = 'error';
      r.error = String(e.message || e).split('\n')[0];
    }
    results.push(r);
    console.log(`${r.status.padEnd(8)} ${t.id}${r.ratio != null ? ` (${(r.ratio * 100).toFixed(2)}%)` : ''}${r.error ? ' ' + r.error : ''}`);
  }
  await browser.close();
  writeFileSync(join(outDir, 'report.html'), report(results, outDir, contentDir));
  writeFileSync(join(outDir, 'results.json'), JSON.stringify(results, null, 2));
  console.log('보고서:', join(outDir, 'report.html'));

  if (flag('apply')) {
    const ym = new Date().toISOString().slice(0, 7);
    for (const r of results.filter((r) => ['changed', 'minor', 'new', 'resized'].includes(r.status))) {
      const dest = join(contentDir, r.image);
      mkdirSync(dirname(dest), { recursive: true });
      // Windows 에서 백신·미리보기 등이 파일을 잠깐 잡고 있으면 복사가 실패하므로 몇 번 다시 시도,
      // 그래도 안 되면 읽어서 직접 쓴다 (copyFile 이 UNKNOWN 오류를 내는 경우가 있음)
      for (let i = 0; ; i++) {
        try { copyFileSync(r.out, dest); break; } catch (e) {
          if (!['EBUSY', 'EPERM', 'EACCES', 'UNKNOWN'].includes(e.code)) throw e;
          if (i >= 5) { writeFileSync(dest, readFileSync(r.out)); break; }
          await new Promise((res) => setTimeout(res, 500));
        }
      }
      setCaptured(contentDir, r.image, ym);
    }
    console.log('반영 완료. npm run build 로 사이트를 다시 만드세요.');
  }
} else if (mode === 'scaffold') {
  // 가이드에 쓰인 화면 이미지마다 캡처 대상 틀을 만든다. url/selector 는 사람이 채운다 (비어 있으면 run 에서 건너뜀).
  const existing = config ? new Map(config.targets.map((t) => [t.image, t])) : new Map();
  const targets = [];
  const walk = (d) => readdirSync(d).flatMap((f) => { const p = join(d, f); return statSync(p).isDirectory() ? (f === 'images' ? [] : walk(p)) : p.endsWith('.md') ? [p] : []; });
  for (const md of walk('content')) {
    const rel = relative('content', md).replace(/\\/g, '/');
    const dir = rel.split('/')[0];
    const title = (readFileSync(md, 'utf8').match(/^title: (.*)$/m) || [])[1];
    for (const m of readFileSync(md, 'utf8').matchAll(/```screen\n([\s\S]*?)```/g)) {
      const src = m[1].match(/src: (\S+)/)[1];
      const image = `${dir}/${src}`;
      if (targets.some((t) => t.image === image)) continue;
      targets.push(existing.get(image) || {
        // 이름이 같고 확장자만 다른 이미지(.png/.jpg)가 있으면 확장자까지 넣어 구분
        id: ((id) => (targets.some((t) => t.id === id) ? image.replace(/\/images\//, '/') : id))(image.replace(/\/images\//, '/').replace(/\.\w+$/, '')), page: `${rel} (${title})`,
        alt: (m[1].match(/alt: (.*)/) || [])[1] || '', markers: (m[1].match(/^\d+: /gm) || []).length,
        url: '', selector: '', image,
      });
    }
  }
  const out = { baseUrl: base, requireLogin: true, viewport, selector: config?.selector || '#contents', maxHeight: config?.maxHeight ?? 1000, timeout: 15000, mask: config?.mask || [], targets };
  writeFileSync(configPath, JSON.stringify(out, null, 2));
  console.log(`${configPath}: 캡처 대상 ${targets.length}개 (url 채운 것 ${targets.filter((t) => t.url).length}개)`);
} else {
  console.log(readFileSync(new URL(import.meta.url), 'utf8').split('\n').slice(0, 8).join('\n'));
}

// 지금 이미지와 새 캡처 비교: 크기가 같으면 픽셀 비교, 다르면 resized
async function compare(oldPath, newPath, diffPath) {
  if (!existsSync(oldPath)) return { status: 'new' };
  const [a, b] = await Promise.all([oldPath, newPath].map((p) => sharp(p).ensureAlpha().raw().toBuffer({ resolveWithObject: true })));
  if (a.info.width !== b.info.width || a.info.height !== b.info.height) {
    return { status: 'resized', from: `${a.info.width}x${a.info.height}`, to: `${b.info.width}x${b.info.height}` };
  }
  const { width, height } = a.info;
  const diff = Buffer.alloc(width * height * 4);
  const n = pixelmatch(a.data, b.data, diff, width, height, { threshold: 0.1 });
  const ratio = n / (width * height);
  if (n) {
    mkdirSync(dirname(diffPath), { recursive: true });
    await sharp(diff, { raw: { width, height, channels: 4 } }).png().toFile(diffPath);
  }
  // 0.1% 넘게 다르면 바뀜, 조금이라도 다르면 작은 변경 (개인정보 가림처럼 좁은 부분만 바뀌는 경우)
  return { status: ratio > 0.001 ? 'changed' : n ? 'minor' : 'same', ratio, diff: n ? diffPath : null };
}

// md 의 screen 블록 중 이 이미지를 쓰는 곳의 captured 날짜를 갱신
function setCaptured(contentDir, image, ym) {
  const [dir, ...rest] = image.split('/');
  const src = rest.join('/');
  const mdDir = join(contentDir, dir);
  if (!existsSync(mdDir)) return;
  for (const f of readdirSync(mdDir).filter((f) => f.endsWith('.md') && statSync(join(mdDir, f)).isFile())) {
    const p = join(mdDir, f);
    const s = readFileSync(p, 'utf8');
    const next = s.replace(/```screen\n([\s\S]*?)```/g, (all, body) => {
      if (!body.includes(`src: ${src}\n`)) return all;
      const b = /^captured: .*$/m.test(body) ? body.replace(/^captured: .*$/m, `captured: ${ym}`) : body.replace(/^(src: .*\n(?:alt: .*\n)?)/, `$1captured: ${ym}\n`);
      return '```screen\n' + b + '```';
    });
    if (next !== s) writeFileSync(p, next);
  }
}

function report(results, outDir, contentDir) {
  const rel = (p) => relative(outDir, p).replace(/\\/g, '/');
  const order = { error: 0, resized: 1, changed: 2, new: 3, same: 4 };
  const label = { error: '오류', resized: '크기 변경', changed: '바뀜', minor: '작은 변경', new: '새 화면', same: '같음' };
  const counts = Object.entries(results.reduce((a, r) => ((a[r.status] = (a[r.status] || 0) + 1), a), {})).map(([k, v]) => `${label[k]} ${v}`).join(' · ');
  const rows = [...results].sort((a, b) => order[a.status] - order[b.status]).map((r) => `
<section class="${r.status}"><h2><span>${label[r.status]}</span> ${r.id} <small>${r.image}${r.ratio != null ? ` · ${(r.ratio * 100).toFixed(2)}% 달라짐` : ''}${r.from ? ` · ${r.from} → ${r.to}` : ''}</small></h2>
${r.error ? `<p class="err">${r.error}</p>` : `<div class="cols">
  <figure><figcaption>지금</figcaption>${existsSync(join(contentDir, r.image)) ? `<img src="${rel(join(contentDir, r.image))}">` : '<p>(없음)</p>'}</figure>
  <figure><figcaption>새 캡처</figcaption><img src="${rel(r.out)}"></figure>
  ${r.diff ? `<figure><figcaption>차이</figcaption><img src="${rel(r.diff)}"></figure>` : ''}
</div>`}</section>`).join('');
  return `<!doctype html><meta charset="utf-8"><title>캡처 비교 보고서</title>
<style>body{font-family:"Malgun Gothic",sans-serif;margin:24px;color:#222}h1{font-size:22px}section{border-top:1px solid #ddd;padding:12px 0}
h2{font-size:15px}h2 span{display:inline-block;padding:2px 8px;border-radius:10px;font-size:12px;color:#fff;background:#888}
.changed h2 span,.resized h2 span{background:#e5383b}.minor h2 span{background:#e08a00}.new h2 span{background:#1d6fd8}.error h2 span{background:#000}
small{color:#666;font-weight:400}.cols{display:grid;grid-template-columns:repeat(auto-fit,minmax(280px,1fr));gap:12px}
figure{margin:0}figcaption{font-size:12px;color:#666}img{max-width:100%;border:1px solid #ddd}.same .cols{display:none}.err{color:#c00}</style>
<h1>캡처 비교 보고서 <small>${new Date().toLocaleString('ko-KR')}</small></h1><p>${counts}</p>${rows}`;
}
