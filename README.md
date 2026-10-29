# 스룩페이 가이드북

판매관리자 이용 가이드 사이트. 글은 `content/` 의 마크다운(.md)으로 쓰고, 빌드하면 `dist/` 에 웹페이지가 만들어진다.

**글·화면·메뉴·디자인을 고치는 방법은 [유지보수_가이드.md](유지보수_가이드.md) 를 본다.**

## 빠른 시작

```
npm install
npm run build
npm run serve   # http://localhost:4321
```

## 명령어

| 명령 | 하는 일 |
|---|---|
| `npm run build` | `content/` → `dist/` 웹페이지 생성 (검색 목록 포함) |
| `npm run serve` | 미리보기 서버 (포트 4321) |
| `npm run capture:login` | 캡처용 로그인 (직접 로그인, 세션만 `.auth/` 에 저장) |
| `npm run capture:discover` | 관리자 메뉴 주소 목록 → `capture/admin-menu.json` |
| `npm run capture` | 관리자 화면 캡처 + 지금 이미지와 비교 → `capture/out/<시각>/report.html` |
| `npm run capture -- --apply` | 바뀐 캡처를 `content/` 에 반영 |

## GitHub 에 올리기 (개인정보 점검 필수)

저장소를 처음 내려받았으면 커밋 전 점검을 켠다 (한 번만):

```
git config core.hooksPath .githooks
```

- 커밋할 때마다 `tools/privacy-check.mjs` 가 돌아서, 캡처 원본·로그인 정보, **검토 안 된 이미지**, 휴대폰·이메일이 든 글은 커밋되지 않는다.
- main 에 올리면 GitHub Actions 가 같은 점검을 한 번 더 하고, 통과해야 사이트(GitHub Pages)에 반영된다.
- 새로 찍은 이미지 올리는 순서:
  1. `node tools/privacy-check.mjs --review` (OCR 로 휴대폰·이메일 의심 표시, Windows)
  2. 이미지를 눈으로 보고 이름·아이디·주소·연동키가 가려졌는지 확인
  3. `node tools/privacy-check.mjs --approve <이미지경로> ...` 로 검토 완료 등록 → 커밋
- 공개된 샘플 번호·주소는 `capture/privacy-allow.json` 에 넣는다. 실제 개인 정보는 절대 넣지 않는다.
