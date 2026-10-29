(() => {
  // 상단 머리글 실제 높이 → CSS 변수 --hdr (왼쪽 메뉴·목차가 머리글 바로 아래에 붙도록)
  const header = document.querySelector('header.top');
  if (header) {
    const setHdr = () => document.documentElement.style.setProperty('--hdr', header.offsetHeight + 'px');
    setHdr();
    new ResizeObserver(setHdr).observe(header);
  }

  // ── 검색 ─────────────────────────────────────────
  // 처음 입력할 때 assets/search.json 을 받아 브라우저에서 찾는다. 띄어쓰기는 무시한다("배송 비" = "배송비").
  const root = document.body.dataset.root || '';
  const input = document.getElementById('q');
  const box = document.getElementById('q-results');
  let index = null, loading = null, hits = [], active = -1;
  const load = () => (loading ||= fetch(root + 'assets/search.json').then((r) => r.json()).then((d) => (index = d.map((e) => ({
    ...e, sq: { h: squash(e.h), p: squash(e.p), g: squash(e.g), x: squash(e.x) },
  })))));
  const squash = (s) => (s || '').toLowerCase().replace(/\s+/g, '');
  const escHtml = (s) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const pattern = (terms) => new RegExp(terms.map((t) => [...t].map((c) => c.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('\\s*')).join('|'), 'gi');
  const mark = (s, re) => escHtml(s).replace(new RegExp(re.source.replace(/&/g, '&amp;'), 'gi'), (m) => `<mark>${m}</mark>`);

  function search(q) {
    const terms = q.toLowerCase().split(/\s+/).filter(Boolean);
    if (!terms.length) return [];
    const whole = squash(q);
    const out = [];
    for (const e of index) {
      let score = 0;
      for (const t of terms) {
        const tq = squash(t);
        const s = (e.sq.h.includes(tq) ? 10 : 0) + (e.sq.p.includes(tq) ? 6 : 0) + (e.sq.g.includes(tq) ? 4 : 0) + (e.sq.x.includes(tq) ? 1 : 0);
        if (!s) { score = 0; break; } // 모든 단어가 있어야 한다
        score += s;
      }
      if (!score) continue;
      if (terms.length > 1 && (e.sq.h + e.sq.x).includes(whole)) score += 5; // 붙여 쓴 그대로 나오면 가산
      if (e.sq.h === whole) score += 8;
      out.push({ e, score });
    }
    return out.sort((a, b) => b.score - a.score).slice(0, 30);
  }

  function snippet(text, re) {
    re.lastIndex = 0;
    const m = re.exec(text);
    if (!m) return escHtml(text.slice(0, 90));
    const start = Math.max(0, m.index - 30);
    return (start ? '…' : '') + mark(text.slice(start, start + 110), re) + (start + 110 < text.length ? '…' : '');
  }

  function render(q) {
    hits = search(q);
    active = hits.length ? 0 : -1;
    const terms = q.toLowerCase().split(/\s+/).filter(Boolean);
    const re = pattern(terms.length > 1 ? [squash(q), ...terms] : terms); // 붙여 쓴 전체를 먼저 강조
    box.innerHTML = hits.length ? hits.map(({ e }, i) => `<li role="option" id="qr-${i}"${i === active ? ' class="on" aria-selected="true"' : ''}>
      <a href="${root}${e.u}"><span class="r-path">${escHtml([e.s, e.p, e.g].filter(Boolean).join(' › '))}</span>
      <b>${mark(e.h || e.p, re)}</b><span class="r-text">${snippet(e.x, re)}</span></a></li>`).join('')
      : `<li class="empty">"${escHtml(q)}"에 대한 결과가 없어요.</li>`;
    box.hidden = false;
  }

  function move(d) {
    if (!hits.length) return;
    box.children[active]?.classList.remove('on');
    active = (active + d + hits.length) % hits.length;
    const li = box.children[active];
    li.classList.add('on');
    li.scrollIntoView({ block: 'nearest' });
  }

  if (input) {
    input.addEventListener('focus', load);
    input.addEventListener('input', async () => {
      const q = input.value.trim();
      if (!q) { box.hidden = true; return; }
      await load();
      if (q === input.value.trim()) render(q);
    });
    input.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowDown') { e.preventDefault(); move(1); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); move(-1); }
      else if (e.key === 'Enter' && hits[active]) { e.preventDefault(); location.href = box.children[active].querySelector('a').href; }
      else if (e.key === 'Escape') { box.hidden = true; input.blur(); }
    });
    input.addEventListener('focus', () => { if (input.value.trim() && box.innerHTML) box.hidden = false; });
    document.addEventListener('click', (e) => { if (!e.target.closest('.search')) box.hidden = true; });
    document.addEventListener('keydown', (e) => {
      if (e.key === '/' && !/^(INPUT|TEXTAREA)$/.test(document.activeElement.tagName)) { e.preventDefault(); input.focus(); }
    });
    // 같은 페이지 안 결과를 누르면 목록을 닫는다
    box.addEventListener('click', () => { box.hidden = true; });
  }

  // 마커에 마우스를 올리면 해당 항목 제목을 툴팁으로 보여준다.
  const titles = {};
  document.querySelectorAll('.item[id^="m-"]').forEach((sec) => {
    titles[sec.id] = sec.querySelector('h3').textContent.replace(/^\d+/, '');
  });
  document.querySelectorAll('.mk:not(.mk-sub)').forEach((mk) => {
    const t = titles[(mk.getAttribute('href') || '').slice(1)];
    if (t) mk.insertAdjacentHTML('beforeend', `<span class="tip">${t}</span>`);
  });

  // 하위 마커(1, 2, 3…) ↔ 같은 항목 안의 번호 목록을 서로 강조한다.
  document.querySelectorAll('.screen-sub').forEach((fig) => {
    const list = fig.closest('.item')?.querySelector('ol');
    if (!list) return;
    const lis = [...list.children];
    const pair = (n, on) => {
      lis[n - 1]?.classList.toggle('hl', on);
      fig.querySelector(`.mk[data-n="${n}"]`)?.classList.toggle('hl', on);
    };
    fig.querySelectorAll('.mk').forEach((mk) => {
      mk.addEventListener('mouseenter', () => pair(+mk.dataset.n, true));
      mk.addEventListener('mouseleave', () => pair(+mk.dataset.n, false));
    });
    lis.forEach((li, i) => {
      li.addEventListener('mouseenter', () => pair(i + 1, true));
      li.addEventListener('mouseleave', () => pair(i + 1, false));
    });
  });

  // 우측 목차: 지금 보고 있는 항목 표시
  // - 머리글 바로 아래 선을 지나간 항목 중 마지막 것
  // - 링크(번호 마커·목차·주소의 #)로 이동했으면 그 항목을 표시하고, 사용자가 스크롤할 때까지 유지
  //   (페이지 끝 근처의 짧은 항목은 선까지 올라오지 못해서, 위치만으로는 앞 항목이 표시되기 때문)
  const tocLinks = [...document.querySelectorAll('.toc a')];
  const items = [...document.querySelectorAll('.item[id]')];
  const hdr = () => parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--hdr')) || 0;
  let pinned = null;
  const pin = () => {
    const id = decodeURIComponent(location.hash.slice(1));
    pinned = items.some((s) => s.id === id) ? id : null;
  };
  // 사용자가 직접 스크롤하면(휠·터치·키보드·스크롤바) 고정을 풀고 위치 기준으로 돌아간다
  const unpin = () => { if (pinned) { pinned = null; spyNow(); } };
  addEventListener('wheel', unpin, { passive: true });
  addEventListener('touchstart', unpin, { passive: true });
  addEventListener('keydown', (e) => { if (/^(Arrow(Up|Down)|Page(Up|Down)|Home|End| )$/.test(e.key) && !/^(INPUT|TEXTAREA)$/.test(document.activeElement.tagName)) unpin(); });
  addEventListener('mousedown', (e) => { if (e.clientX >= document.documentElement.clientWidth) unpin(); });
  const spyNow = () => {
    if (!items.length) return;
    let cur = pinned;
    if (!cur) {
      const line = hdr() + 24;
      cur = items[0].id;
      for (const s of items) { if (s.getBoundingClientRect().top <= line) cur = s.id; else break; }
    }
    tocLinks.forEach((a) => a.parentElement.classList.toggle('on', a.hash === '#' + cur));
  };
  addEventListener('scroll', spyNow, { passive: true });
  addEventListener('hashchange', () => { pin(); spyNow(); });
  pin();
  spyNow();
  // 이미지가 늦게 불려 와 위치가 밀렸으면, 주소의 # 항목으로 다시 맞춘다
  addEventListener('load', () => {
    const t = location.hash && document.getElementById(decodeURIComponent(location.hash.slice(1)));
    if (t) { t.scrollIntoView(); pin(); spyNow(); }
  });

  // 왼쪽 메뉴가 같은 페이지 묶음 바로가기(#g-1 …)일 때(HOME): 지금 보고 있는 묶음 표시
  const sideLinks = [...document.querySelectorAll('.side a[href^="#"]')];
  if (sideLinks.length) {
    const heads = sideLinks.map((a) => document.getElementById(a.hash.slice(1)));
    const mark = () => {
      let cur = 0;
      heads.forEach((h, i) => { if (h && h.getBoundingClientRect().top <= hdr() + 24) cur = i; });
      sideLinks.forEach((a, i) => a.parentElement.classList.toggle('on', i === cur));
    };
    addEventListener('scroll', mark, { passive: true });
    mark();
  }

  // 맨 위로 버튼: 화면 높이의 절반 이상 내려가면 보이고, 누르면 맨 위로
  const toTop = document.querySelector('.to-top');
  if (toTop) {
    toTop.hidden = false;
    const show = () => toTop.classList.toggle('show', scrollY > innerHeight / 2);
    addEventListener('scroll', show, { passive: true });
    show();
    toTop.addEventListener('click', () => scrollTo({ top: 0, behavior: 'smooth' }));
  }

  if (!new URLSearchParams(location.search).has('edit')) return;

  // ── 편집 모드 ─────────────────────────────────────────
  // 마커 드래그로 위치 조정, 빈 곳 클릭으로 다음 번호 추가, Alt+클릭으로 삭제.
  // 아래 칸에 나오는 텍스트를 .md 파일의 ```screen 블록에 그대로 붙여넣으면 된다.
  document.body.classList.add('editing');
  document.body.insertAdjacentHTML('beforeend',
    '<div class="edit-bar">편집 모드 · 마커 드래그 = 이동 · 빈 곳 클릭 = 추가 · Alt+클릭 = 삭제 · 결과를 .md에 붙여넣기</div>');

  document.querySelectorAll('.screen').forEach((fig) => {
    const shot = fig.querySelector('.shot');
    const img = shot.querySelector('img');
    const sub = fig.dataset.style === 'sub';
    const panel = document.createElement('div');
    panel.className = 'edit-panel';
    panel.innerHTML = '<textarea spellcheck="false"></textarea><button type="button">복사</button>';
    fig.append(panel);
    const ta = panel.querySelector('textarea');
    panel.querySelector('button').onclick = () => {
      navigator.clipboard.writeText(ta.value);
      panel.querySelector('button').textContent = '복사됨';
      setTimeout(() => (panel.querySelector('button').textContent = '복사'), 1200);
    };

    const pct = (e) => {
      const r = img.getBoundingClientRect();
      const clamp = (v) => Math.min(100, Math.max(0, v));
      return [clamp(((e.clientX - r.left) / r.width) * 100), clamp(((e.clientY - r.top) / r.height) * 100)];
    };
    const markers = () => [...shot.querySelectorAll('.mk')];
    const sync = () => {
      const lines = [`src: ${fig.dataset.src}`];
      if (img.alt) lines.push(`alt: ${img.alt}`);
      if (fig.dataset.captured) lines.push(`captured: ${fig.dataset.captured}`);
      if (sub) lines.push('style: sub');
      markers().sort((a, b) => a.dataset.n - b.dataset.n).forEach((mk) => {
        lines.push(`${mk.dataset.n}: ${parseFloat(mk.style.left).toFixed(1)} ${parseFloat(mk.style.top).toFixed(1)}`);
      });
      ta.value = '```screen\n' + lines.join('\n') + '\n```';
    };
    const bind = (mk) => {
      mk.addEventListener('click', (e) => e.preventDefault());
      mk.addEventListener('pointerdown', (e) => {
        e.preventDefault();
        e.stopPropagation();
        if (e.altKey) { mk.remove(); sync(); return; }
        mk.setPointerCapture(e.pointerId);
        const move = (ev) => {
          const [x, y] = pct(ev);
          mk.style.left = x + '%';
          mk.style.top = y + '%';
          sync();
        };
        mk.addEventListener('pointermove', move);
        mk.addEventListener('pointerup', () => mk.removeEventListener('pointermove', move), { once: true });
      });
    };
    markers().forEach(bind);
    shot.addEventListener('pointerdown', (e) => {
      if (e.target.closest('.mk')) return;
      const [x, y] = pct(e);
      const n = Math.max(0, ...markers().map((m) => +m.dataset.n)) + 1;
      const mk = document.createElement('span');
      mk.className = 'mk' + (sub ? ' mk-sub' : '');
      mk.dataset.n = n;
      mk.textContent = n;
      mk.style.left = x + '%';
      mk.style.top = y + '%';
      shot.append(mk);
      bind(mk);
      sync();
    });
    sync();
  });
})();
