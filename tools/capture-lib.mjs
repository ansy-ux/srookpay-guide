// capture.mjs 와 fit-selectors.mjs 가 같이 쓰는 화면 준비·영역 계산

// 고정 요소 정리: 화면 맨 위에 붙은 메뉴 막대는 페이지 맨 위에 고정(스크롤해도 본문을 가리지 않게),
// 나머지(TOP·채팅 버튼, 하단 저장 버튼 막대, 처음부터 떠 있는 안내 팝업과 어두운 배경)는 숨긴다.
// keepPopups: steps 로 일부러 띄운 팝업을 찍을 때는 팝업·배경을 숨기지 않는다.
export const unfix = (page, keepPopups = false) => page.evaluate((keepPopups) => {
  for (const el of document.querySelectorAll('body *')) {
    const pos = getComputedStyle(el).position;
    if (pos !== 'fixed' && pos !== 'sticky') continue;
    const r = el.getBoundingClientRect();
    if (!r.width || !r.height) continue;
    if (r.top <= 5 && r.height < 200 && r.width > 600) {
      el.style.setProperty('position', 'absolute', 'important');
      el.style.setProperty('top', r.top + scrollY + 'px', 'important');
    } else if (!keepPopups || r.width * r.height < 300 * 300) {
      el.style.setProperty('visibility', 'hidden', 'important');
    }
  }
}, keepPopups);

// 본문(root) 안의 묶음 제목 목록. 제목 = 직접 글자가 있고 17px 이상·굵은 글씨인 요소 (관리자는 h4 18px/600).
// 각 제목의 묶음은 그 제목 위에서 다음 제목 위까지 (마지막은 root 끝까지). 좌표는 페이지 기준.
export const sections = (page, root) => page.evaluate((root) => {
  const r = document.querySelector(root);
  if (!r) return [];
  const rb = r.getBoundingClientRect();
  const heads = [...r.querySelectorAll('*')]
    .filter((h) => {
      const b = h.getBoundingClientRect();
      const s = getComputedStyle(h);
      const own = [...h.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim());
      if (!own || !b.width || !b.height || s.visibility === 'hidden' || s.display === 'none') return false;
      if (parseFloat(s.fontSize) < 17 || parseInt(s.fontWeight) < 600) return false;
      if (h.textContent.trim().length > 40) return false;
      return b.left - rb.left <= 60; // 표 안 제목·버튼 제외 (왼쪽 정렬된 묶음 제목만)
    })
    // label: 제목 자체 글자만 (안에 든 "전체 11개" 같은 숫자 표시는 빼서 데이터가 바뀌어도 찾을 수 있게)
    .map((h) => ({
      label: [...h.childNodes].filter((n) => n.nodeType === 3).map((n) => n.textContent).join('').trim().replace(/\s+/g, ' ') || h.textContent.trim().replace(/\s+/g, ' '),
      full: h.textContent.trim().replace(/\s+/g, ' '), top: h.getBoundingClientRect().top + scrollY,
    }))
    .sort((a, b) => a.top - b.top);
  const bottom = rb.bottom + scrollY;
  const M = 8; // 제목 위 여백 (이보다 크면 앞 묶음의 버튼 아래끝이 걸린다)
  return heads.map((h, i) => ({ ...h, x: rb.left + scrollX, w: rb.width, y: Math.max(rb.top + scrollY, h.top - M), end: (heads[i + 1]?.top ?? bottom + M) - M }));
}, root);

// from 제목부터 to 제목 바로 위까지 (to 가 없으면 from 묶음 하나, "끝" 이면 본문 끝까지). 제목은 앞부분 일치로 찾는다.
export async function sectionClip(page, root, from, to) {
  const list = await sections(page, root);
  const find = (t) => list.findIndex((s) => s.label === t || s.full.startsWith(t));
  const a = find(from);
  if (a < 0) throw new Error(`제목 "${from}" 을 찾을 수 없음 (있는 제목: ${list.map((s) => s.label).join(' / ')})`);
  // to: "끝" 이면 본문 끝까지
  let b = to === '끝' ? list.length - 1 : to ? find(to) - 1 : a;
  if (to && b < a) throw new Error(`제목 "${to}" 를 "${from}" 뒤에서 찾을 수 없음`);
  const s = list[a];
  return { x: s.x, y: s.y, width: s.w, height: list[b].end - s.y };
}

// 개인정보 가리기: 휴대폰·이메일, 개인정보 입력칸(성함·연락처 등), 개인정보 표 칸(주문자·수령인·주소 등)
// 글자가 있는 자리만 #DDDDDD 막대로 덮는다 (칸 배경·테두리·사진은 그대로). 글자를 투명하게 하고 배경만 칠해서
// 레이아웃이 바뀌지 않으므로 번호 마커 위치도 그대로다.
// words: 가릴 단어(판매자 아이디·계정명 등). 공개 저장소에 남지 않도록 .auth/mask-words.json 에서 읽어 넘긴다.
export const maskPrivate = (page, words = []) => page.evaluate((words) => {
  // 앞뒤가 영문·숫자·하이픈이면 전화번호가 아님 (주문번호 NLJ61020-29003353 같은 것)
  const PHONE = /(?<![A-Za-z0-9-])(01[016789]|0\d{1,2})[-.\s]?\d{3,4}[-.\s]?\d{4}(?![0-9])/;
  const EMAIL = /[\w.+-]+@[\w-]+(\.[\w-]+)+/;
  const LABEL = /성함|이름|성명|휴대폰|핸드폰|연락처|전화|이메일|e-?mail|주소|계좌번호|예금주|입금자|연동키|인증키|API|토큰|token|비밀번호|secret/i;
  const COL = /주문자|수령인|주소|연락처|휴대폰|이메일|작성자|예금주|계좌번호|입금자|아이디|대표자|셀럽명|담당자|성함|^\s*이름/;
  // 가릴 단어 (판매자·부계정 아이디 등): 글자 속 어디에 있든 그 부분만
  const SECRET_SRC = words.filter(Boolean).map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|');
  const hasSecret = (t) => !!SECRET_SRC && new RegExp(SECRET_SRC, 'i').test(t);
  // 연동키처럼 보이는 값: 공백 없는 12자 이상 영문+숫자 섞인 문자열
  const KEY = /^(?=.*\d)(?=.*[a-z])[A-Za-z0-9]{12,}$/;
  const KEEP = /1600-?7313|@srookpay\.com/; // 고객센터 번호, 안내용 예시 주소는 그대로
  const COLOR = '#dddddd';
  const root = document.querySelector('#contents') || document.body;
  const esc = (t) => t.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
  const bar = (t) => `<span style="background:${COLOR};color:transparent;border-radius:2px;-webkit-box-decoration-break:clone;box-decoration-break:clone">${esc(t)}</span>`;
  // 글자 덩어리 하나를 막대로 (앞뒤 공백은 남김)
  const maskText = (n, onlyMatches) => {
    const t = n.textContent;
    if (!t.trim()) return;
    const span = document.createElement('span');
    if (onlyMatches) {
      // 휴대폰·이메일 부분만 막대로, 나머지 글자는 그대로
      let html = '', last = 0;
      for (const m of t.matchAll(new RegExp([PHONE.source, EMAIL.source, SECRET_SRC].filter(Boolean).join('|'), 'gi'))) {
        html += esc(t.slice(last, m.index)) + (KEEP.test(m[0]) ? esc(m[0]) : bar(m[0]));
        last = m.index + m[0].length;
      }
      span.innerHTML = html + esc(t.slice(last));
    } else {
      const m = t.match(/^(\s*)([\s\S]*?)(\s*)$/);
      span.innerHTML = esc(m[1]) + bar(m[2]) + esc(m[3]);
    }
    n.replaceWith(...span.childNodes);
  };
  const textNodes = (el) => { const out = []; const w = document.createTreeWalker(el, NodeFilter.SHOW_TEXT); for (let n; (n = w.nextNode());) out.push(n); return out; };

  // 입력칸 하나: 입력된 글자 폭만큼만 회색 막대 (칸 자체는 그대로)
  const INPUTS = 'input[type=text], input[type=email], input[type=tel], input:not([type]), textarea';
  const cv = document.createElement('canvas').getContext('2d');
  const maskInput = (inp) => {
    const v = inp.value || '';
    if (!v.trim()) return;
    const cs = getComputedStyle(inp);
    cv.font = `${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`;
    const w = Math.min(cv.measureText(v).width, inp.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight));
    const h = parseFloat(cs.fontSize) * 1.25;
    inp.style.setProperty('color', 'transparent', 'important');
    inp.style.setProperty('background-image', `linear-gradient(${COLOR}, ${COLOR})`, 'important');
    inp.style.setProperty('background-repeat', 'no-repeat', 'important');
    inp.style.setProperty('background-size', `${Math.round(w)}px ${Math.round(h)}px`, 'important');
    inp.style.setProperty('background-position', inp.tagName === 'TEXTAREA' ? `${cs.paddingLeft} ${cs.paddingTop}` : `${cs.paddingLeft} center`, 'important');
  };
  // 1) 입력칸: 휴대폰·이메일이 들어 있거나, 이름표가 개인정보(성함·연락처 등)인 칸
  for (const inp of root.querySelectorAll(INPUTS)) {
    const v = inp.value || '';
    // 이름표: 바로 앞 칸(th) 또는 연결된 label 만 본다 (검색 폼 전체의 글자를 보면 날짜 칸까지 가려짐)
    const label = (inp.closest('td')?.previousElementSibling?.textContent || (inp.id && root.querySelector(`label[for="${CSS.escape(inp.id)}"]`)?.textContent)
      || inp.closest('li, .row')?.querySelector('label, dt')?.textContent || '') + ' ' + (inp.placeholder || '');
    // 연동키처럼 보이는 값(소문자+숫자 12자 이상)은 이름표와 상관없이 가림 (상품코드는 대문자라 해당 없음)
    if ((PHONE.test(v) && !KEEP.test(v)) || (EMAIL.test(v) && !KEEP.test(v)) || LABEL.test(label) || hasSecret(v) || KEY.test(v.trim())) maskInput(inp);
  }
  // 2) 표 칸: 머리글이 개인정보인 열의 글자
  for (const table of root.querySelectorAll('table')) {
    // 목록 표만: 머리글 줄이 전부 th 인 표 (검색 폼처럼 한 줄에 th·td 가 섞인 표는 제외)
    const headRow = [...table.rows].find((r) => r.cells.length && [...r.cells].every((c) => c.tagName === 'TH'));
    if (!headRow || headRow.cells.length < 3) continue;
    const heads = [...headRow.cells];
    const cols = new Set();
    let ci = 0;
    for (const th of heads) { const span = +th.colSpan || 1; if (COL.test(th.textContent)) for (let k = 0; k < span; k++) cols.add(ci + k); ci += span; }
    if (!cols.size) continue;
    for (const tr of table.querySelectorAll('tbody tr')) {
      let c = 0;
      for (const td of tr.children) {
        const span = +td.colSpan || 1;
        if (td.tagName === 'TD' && [...Array(span).keys()].some((k) => cols.has(c + k))) { td.dataset.masked = '1'; textNodes(td).forEach((n) => maskText(n, false)); td.querySelectorAll(INPUTS).forEach(maskInput); }
        c += span;
      }
    }
  }
  // 2-1) 표가 아닌 곳의 개인정보 영역 (화면별로 찾아서 여기에 추가)
  //   글자: 회색 막대, 사진: 회색으로 덮음
  const AREAS_TEXT = [
    '.message_list .name', '.message_list .btom_tit', // 상품관리 > 메시지: 대화 상대 이름·마지막 메시지
  ];
  const AREAS_PHOTO = [
    '.message_list .thumb_usr', // 메시지 대화 상대 프로필 사진
  ];
  for (const el of root.querySelectorAll(AREAS_TEXT.join(','))) { el.dataset.masked = '1'; textNodes(el).forEach((n) => maskText(n, false)); }
  for (const el of root.querySelectorAll(AREAS_PHOTO.join(','))) {
    el.style.setProperty('background', COLOR, 'important');
    el.querySelectorAll('img').forEach((img) => img.style.setProperty('visibility', 'hidden', 'important'));
  }
  // 3) 그 밖의 글자 속 휴대폰·이메일 (그 부분만)
  for (const n of textNodes(root)) {
    if (n.parentElement?.closest('[data-masked]')) continue;
    const t = n.textContent;
    const hits = [...t.matchAll(new RegExp(`${PHONE.source}|${EMAIL.source}`, 'g'))];
    if (hits.some((m) => !KEEP.test(m[0])) || hasSecret(t)) maskText(n, true);
  }
}, words);
