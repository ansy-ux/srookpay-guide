// 개인정보 점검: GitHub 에 올리기 전에 반드시 통과해야 한다 (커밋 전 훅 + GitHub Actions 에서 실행).
//
//   node tools/privacy-check.mjs --staged     커밋하려는 파일만 (커밋 전 훅에서 자동 실행)
//   node tools/privacy-check.mjs --all        올라갈 모든 파일 (GitHub Actions, 직접 점검)
//   node tools/privacy-check.mjs --review     검토 안 된 이미지를 OCR 로 읽어 휴대폰·이메일 의심 부분을 보여줌 (Windows)
//   node tools/privacy-check.mjs --approve 이미지경로 [...]   사람이 눈으로 확인한 이미지를 "검토 완료" 목록에 추가
//
// 규칙
//  1) 올리면 안 되는 파일: 캡처 원본(capture/out·backup·fit), 로그인 세션(.auth), OCR 결과, 계정 정보가 든 파일
//  2) 이미지: capture/privacy-reviewed.json 에 같은 내용(sha256)으로 등록된 것만. 새로 찍거나 바뀐 이미지는 막힘
//  3) 글자 파일: 휴대폰 번호·이메일이 있으면 막힘 (capture/privacy-allow.json 의 샘플 값은 허용)
import { readFileSync, writeFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { join, extname } from 'node:path';

const REVIEWED = 'capture/privacy-reviewed.json';
const ALLOW = 'capture/privacy-allow.json';
const BLOCKED = [/^capture\/(out|backup|fit|test-content)\//, /^\.auth\//, /^capture\/ocr-all\.json$/, /^capture\/menuAll-tree\.txt$/, /^_original\//];
const IMAGE = /\.(png|jpe?g|gif|webp|bmp)$/i;
const TEXT = /\.(md|json|txt|html?|css|m?js|ps1|ya?ml|csv)$/i;
const PHONE = /(?<![A-Za-z0-9-])(01[016789]|0[2-6][0-9]?)[-. ]?\d{3,4}[-. ]?\d{4}(?![0-9])/g;
const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)+/g;

const args = process.argv.slice(2);
const mode = args[0];
const sha = (f) => createHash('sha256').update(readFileSync(f)).digest('hex');
const load = (f, d) => (existsSync(f) ? JSON.parse(readFileSync(f, 'utf8')) : d);
const reviewed = load(REVIEWED, {});
const SECRET_WORDS = (load('.auth/mask-words.json', { words: [] }).words || []).filter(Boolean).map((w) => w.toLowerCase());
const allow = load(ALLOW, { phones: [], emails: [] });
const allowed = (v) => allow.phones.some((p) => p.replace(/\D/g, '') === v.replace(/\D/g, '')) || allow.emails.some((e) => e.toLowerCase() === v.toLowerCase() || (e.startsWith('@') && v.toLowerCase().endsWith(e.toLowerCase())));
const git = (...a) => execFileSync('git', a, { encoding: 'utf8' }).split('\n').filter(Boolean);
const walk = (d) => readdirSync(d).flatMap((f) => { const p = join(d, f).replace(/\\/g, '/'); return statSync(p).isDirectory() ? walk(p) : [p]; });

function files() {
  if (mode === '--staged') return git('diff', '--cached', '--name-only', '--diff-filter=ACMR');
  // --all: git 저장소면 올라갈 파일(추적 + 무시되지 않은 새 파일), 아니면 폴더 전체에서 .gitignore 대상 제외
  try { return [...git('ls-files'), ...git('ls-files', '--others', '--exclude-standard')]; } catch {
    const ignore = existsSync('.gitignore') ? readFileSync('.gitignore', 'utf8').split('\n').map((s) => s.trim()).filter((s) => s && !s.startsWith('#')) : [];
    return walk('.').map((f) => f.replace(/^\.\//, '')).filter((f) => !f.startsWith('.git/') && !ignore.some((g) => f === g.replace(/\/$/, '') || f.startsWith(g.endsWith('/') ? g : g + '/')));
  }
}

function check(list) {
  const problems = [];
  for (const f of list) {
    if (!existsSync(f)) continue;
    if (BLOCKED.some((re) => re.test(f))) { problems.push(`올리면 안 되는 파일: ${f}`); continue; }
    if (IMAGE.test(f)) {
      if (reviewed[f]?.sha256 !== sha(f)) problems.push(`개인정보 검토 안 된 이미지: ${f}`);
      continue;
    }
    if (TEXT.test(f) && f !== ALLOW && f !== REVIEWED) {
      const t = readFileSync(f, 'utf8');
      const hits = [...(t.match(PHONE) || []), ...(t.match(EMAIL) || [])].filter((v) => !allowed(v));
      if (hits.length) problems.push(`휴대폰·이메일 의심 (${[...new Set(hits)].slice(0, 3).join(', ')}): ${f}`);
      // 가릴 단어(계정 아이디 등, .auth/mask-words.json — 이 PC 에만 있음). 단어 자체는 출력하지 않는다
      const lower = t.toLowerCase();
      const n = SECRET_WORDS.filter((w) => lower.includes(w)).length;
      if (n) problems.push(`계정 아이디 등 가릴 단어 ${n}종 포함: ${f}`);
    }
  }
  return problems;
}

if (mode === '--staged' || mode === '--all') {
  const list = files();
  const problems = check(list);
  if (problems.length) {
    console.error(`\n✖ 개인정보 점검 실패 (${problems.length}건) — 올리지 않았어요.\n`);
    problems.slice(0, 40).forEach((p) => console.error('  - ' + p));
    if (problems.length > 40) console.error(`  … 외 ${problems.length - 40}건`);
    console.error('\n  이미지: node tools/privacy-check.mjs --review 로 확인 → 눈으로 본 뒤 --approve 로 등록');
    console.error('  글자: 실제 번호·주소를 지우거나, 샘플 값이면 capture/privacy-allow.json 에 추가\n');
    process.exit(1);
  }
  console.log(`✓ 개인정보 점검 통과 (파일 ${list.length}개)`);
} else if (mode === '--review') {
  // 검토 목록에 없거나 내용이 바뀐 이미지를 OCR 로 읽어 의심 부분을 보여준다
  const imgs = files().filter((f) => IMAGE.test(f) && !BLOCKED.some((re) => re.test(f)) && reviewed[f]?.sha256 !== sha(f));
  if (!imgs.length) { console.log('검토할 이미지가 없어요.'); process.exit(0); }
  const tmp = join(process.env.TEMP || '.', 'privacy-ocr');
  writeFileSync(tmp + '.txt', imgs.join('\n'));
  execFileSync('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', 'tools/ocr.ps1', '-List', tmp + '.txt', '-Out', tmp + '.json'], { stdio: 'inherit' });
  const ocr = JSON.parse(readFileSync(tmp + '.json', 'utf8'));
  for (const f of imgs) {
    const t = ocr[f] || '';
    const hits = [...(t.match(PHONE) || []), ...(t.match(EMAIL) || [])].filter((v) => !allowed(v));
    console.log(`${hits.length ? '⚠' : '·'} ${f}${hits.length ? '  ← ' + [...new Set(hits)].join(', ') : ''}`);
  }
  console.log(`\n검토할 이미지 ${imgs.length}개. ⚠ 표시는 휴대폰·이메일로 보이는 글자가 있는 것.`);
  console.log('OCR 은 이름을 구별하지 못하니, 이름·주소·사진도 눈으로 확인한 뒤 등록하세요:');
  console.log('  node tools/privacy-check.mjs --approve <이미지경로> ...');
} else if (mode === '--approve') {
  const list = args.slice(1);
  if (!list.length) { console.error('등록할 이미지 경로를 적어 주세요.'); process.exit(1); }
  const today = new Date().toISOString().slice(0, 10);
  for (const f of list) {
    if (!existsSync(f) || !IMAGE.test(f)) { console.error('이미지가 아님: ' + f); process.exit(1); }
    reviewed[f] = { sha256: sha(f), reviewed: today };
  }
  writeFileSync(REVIEWED, JSON.stringify(Object.fromEntries(Object.entries(reviewed).sort()), null, 1) + '\n');
  console.log(`검토 완료로 등록: ${list.length}개 → ${REVIEWED}`);
} else {
  console.log('사용법: node tools/privacy-check.mjs --staged | --all | --review | --approve <이미지> ...');
}
