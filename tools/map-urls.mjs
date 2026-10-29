// 가이드 페이지 ↔ 관리자 메뉴 주소를 이름으로 맞춰 capture/targets.json 의 url 을 채운다.
//   node tools/map-urls.mjs          마커가 있는 개요 화면만 채움 (이미 채운 url 은 그대로)
//   node tools/map-urls.mjs --all    같은 페이지의 다른 화면에도 같은 주소를 넣음 (팝업 등은 steps 를 따로 채워야 함)
import { readFileSync, writeFileSync } from 'node:fs';

const nav = JSON.parse(readFileSync('content/_nav.json', 'utf8'));
const menu = JSON.parse(readFileSync('capture/admin-menu.json', 'utf8'));
const targetsFile = 'capture/targets.json';
const config = JSON.parse(readFileSync(targetsFile, 'utf8'));
const all = process.argv.includes('--all');

// 가이드 섹션 → 관리자 주소의 두 번째 칸 (같은 이름이 여러 섹션에 있을 때 구분용)
const SECTION = {
  setting: ['Setting'], goods: ['Good', 'Review', 'Qna'], order: ['Order'], member: ['Member', 'Point', 'Coupon'],
  supply: ['Supply'], sms: ['Sms'], accounts: ['Account'], affiliate: ['Marketing'], celeb: ['CelebLink'], linkseller: ['Sns'], bank: [],
};
const norm = (s) => s.replace(/\s+/g, '').replace(/^SMS(?=알림톡)/, '').replace(/설정$|관리$/, '').toLowerCase();
// 이름이 달라 자동으로 못 맞추는 것
const ALIAS = { '쇼핑몰설정': '쇼핑몰 기본 설정', '상품 물류업체 관리': '상품 물류업체 설정', '공지사항 관리': '공지사항', '셀럽 찾기': '셀럽찾기', '기간별정산통계': '기간별정산통계(일반)', '카카오싱크 설정': '카카오싱크' };

// 가이드 페이지 목록 (section/page → 이름)
const pages = {};
for (const s of nav) {
  const walk = (items) => items.forEach((i) => (i.children ? walk(i.children) : (pages[i.href.replace('.html', '')] = { name: i.name, dir: s.dir })));
  s.groups.forEach((g) => walk(g.items));
}

const pageUrl = {};
const missing = [];
for (const [key, { name, dir }] of Object.entries(pages)) {
  const want = norm(ALIAS[name] || name);
  const ctrls = SECTION[dir] || [];
  const hit = menu.find((m) => ctrls.includes(m.href.split('/')[2]) && norm(m.name) === want);
  if (hit) pageUrl[key] = hit.href;
  else missing.push(`${key} (${name})`);
}

let filled = 0;
for (const t of config.targets) {
  if (t.url) continue;
  const key = t.page.split(' ')[0].replace('.md', '');
  if (!pageUrl[key] || (!all && !t.markers)) continue;
  t.url = pageUrl[key];
  filled++;
}
writeFileSync(targetsFile, JSON.stringify(config, null, 2));
const withUrl = config.targets.filter((t) => t.url);
console.log(`페이지 ${Object.keys(pageUrl).length}/${Object.keys(pages).length}개 주소 찾음, 이번에 채운 화면 ${filled}개 (url 있는 화면 ${withUrl.length}개, 마커 화면 중 ${withUrl.filter((t) => t.markers).length}/${config.targets.filter((t) => t.markers).length})`);
console.log('주소를 못 찾은 페이지:\n  ' + missing.join('\n  '));
