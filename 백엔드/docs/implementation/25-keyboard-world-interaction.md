# 월드 오브젝트 키보드 상호작용

월드 캔버스에 포커스가 있을 때 `Enter` 또는 `E`를 누르면 플레이어 주변 1.25타일 안에서 가장 가까운 상호작용 오브젝트를 실행한다. 거리가 같으면 화면 아래쪽 오브젝트, 그다음 오브젝트 ID 순서로 하나를 선택해 매번 같은 결과를 낸다. 현재는 NPC 대화처럼 마우스로만 열 수 있던 상호작용을 키보드로 시작할 수 있다.

월드가 온라인이 아니거나 미디어 전환 중일 때는 실행하지 않는다. 키 반복 입력, 수정 키 조합도 막는다. 입력란이나 대화상자 등 다른 UI에 포커스가 있을 때는 월드 조작이 키를 가로채지 않는다. 월드 조작 안내 텍스트에 가까운 오브젝트를 `Enter` 또는 `E`로 여는 방법을 추가했다.

2026-09-26 검증: 격리 Preview 서버에서 `browser-compat.spec.ts`를 Chromium, Firefox, WebKit으로 실행해 세 브라우저 모두 통과했다. 각 브라우저에서 안내 NPC를 `Enter`와 `E`로 열고 닫았다. 프론트 Vitest 66/66, TypeScript 검사, Prettier, production build도 통과했다. Production build는 기존 Phaser 번들 크기 경고를 출력하지만 성공했다.

전체 키보드 접근성 작업은 계속 진행한다. 실기기 스크린리더 검수와 모든 주요 화면 흐름의 완전한 키보드 검증은 남아 있으므로 T25.1을 완료 처리하지 않았다.

2026-09-27 이중 언어 접근성 회귀: 격리 Preview에서 한국어·영어 각각 Tab만으로 닉네임 입력→Enter 입장→참가자 패널 열기/닫기→첫 안내 건너뛰기→캔버스 포커스와 방향키 이동을 검사해 Playwright 2/2 통과했다. 접근성 트리의 참가 인원·정원·위치·좌표도 두 언어로 확인했다. `accessibility.spec.ts`는 두 언어의 랜딩, 첫 입장 안내, 캠퍼스, 채팅, 지도 화면에 axe-core WCAG 2.1 A/AA 규칙을 적용해 2/2 통과했다. 첫 실행에서는 이전 한국어 위치 안내 문구를 기대하던 회귀 검사가 실제 DOM 문구와 달라 실패해 현재 사용자 문구로 기대값을 갱신하고 재검증했다. 실제 기기 스크린리더와 키보드만으로 수행하는 전체 편집·미디어 운영 흐름은 남아 있어 T25.1은 미완료다.
2026-09-27 bilingual dialog accessibility: Extended the Chromium axe-core suite to the avatar wardrobe and pre-entry media-device dialog in Korean and English. The checks exposed low contrast on the three avatar-part labels and the device disclosure hint; adjusted both colors above the WCAG 2 AA 4.5:1 threshold. `accessibility.spec.ts` passed 2/2 for landing, onboarding, campus, wardrobe, device preflight, chat, and map in both languages. These automated checks do not replace a screen-reader and keyboard-only review on real devices; T25.1 remains open.

2026-09-27 맵 편집기 접근성·대비 보완: editor.spec.ts에 axe-core WCAG 2.1 A/AA 검사를 추가해 기본 도구/에셋 패널, 오브젝트 선택 속성 패널, 게시 이력 대화상자를 검사했다. 낮은 대비로 실패한 작은 도구 라벨·설명·상태 색을 편집기 전용 muted text 색 `#5c7063`으로 조정하고, 비활성 순서 제어도 읽을 수 있는 색으로 바꿨다. 권한 인계 후 읽기 전용으로 바뀐 이전 탭에서 저장을 누르던 기존 E2E 순서를 수정해 권한 인계 전 미저장 변경과 인계 후 복구본 보존을 검증한다. Editor 및 기존 bilingual accessibility 브라우저 검사 23/23, 프론트 Vitest 43개 파일·142개, typecheck/build와 Prettier가 통과했다. 실제 기기 스크린리더·키보드 사용 검수는 남아 T25.1을 완료 처리하지 않는다.

2026-09-28 공통 대화상자 포커스: 모달이 열리거나 최소화 후 복원될 때 닫기 버튼으로 초기 포커스를 옮기고, 최소화된 모달은 복원 버튼에 포커스를 둔다. 기존 호출 버튼 포커스 복귀는 유지한다. 실제 SFU E2E에서 장치 설정을 열어 닫기 버튼 포커스, Tab으로 첫 입력 이동, Escape 후 호출 버튼 복귀를 확인했다. 실기기 스크린리더 검수는 여전히 남아 있다.

2026-09-28 카메라·화면공유 창 키보드 조작: 실제 SFU 두 참가자 Chromium E2E에서 화면공유·카메라 RTP 수신을 유지한 채 각 창 제목에 포커스해 화살표 키로 위치를 바꾸고, 크기 조절 버튼에 포커스해 창 크기를 조절하는 동작을 확인했다. 같은 화면의 두 창에 axe-core WCAG 2.1 A/AA 검사를 실행해 위반 0건을 확인했고, 기존 창 경계 보정도 유지된다. 검사는 1/1 통과했다([증거](evidence/25-media-window-keyboard-2026-09-28.json)). 브라우저 가짜 장치를 사용했으며 실제 스크린리더·기기 접근성 검수는 남아 T25.1을 미완료로 유지한다.

2026-09-28 모바일 모달 크기와 접근성: 한국어·영어 axe-core 회귀를 390×844에서도 실행하고 아바타 옷장 대화상자가 뷰포트 안에 표시되며 문서 가로 넘침이 없는지 검사했다. 검사에서 모바일 하단의 아이콘 전용 공간 나가기 버튼에 접근성 이름이 없던 문제를 발견해 현재 언어의 `campus.leave` 라벨을 연결했다. 한국어·영어 랜딩/캠퍼스/옷장/채팅/지도 접근성 및 모바일 모달 검사 2/2, Prettier가 통과했다. 실기기 스크린리더와 기기별 모달 검수는 남아 T25.1을 미완료로 유지한다.

2026-09-29 행사 도구 초기화 정책: 기본 대화와 미디어를 우선하는 요청에 맞춰 저장 설정 키를 v6로 올리고, 기존 v5까지의 행사/발표 도구 활성화 값을 초기화한다. 업데이트 전 켰던 브라우저도 기본 도구만 표시하고, 사용자가 새 설정에서 다시 켠 경우에만 행사 도구 패널을 노출한다. 마이크·카메라·화면공유·근거리 채팅 설정은 이 값과 분리되어 있다. 선호 설정 단위 검사 2/2, 전체 Vitest 159/159, TypeScript/Vite production build 및 Prettier 검사가 통과했다. `localhost:5173`의 SSO 백엔드와 `localhost:5174`의 tailnet-origin Preview는 브라우저 E2E Origin과 맞지 않아, 별도 loopback Origin으로 격리 Preview(API 18100·World 18101·web 5190)를 실행했다. Chromium 행사 도구 E2E 2/2에서 기본 숨김과 v6 명시적 선택 후 표시, 핵심 미디어·근거리 채팅 접근성을 통과시켰으며 검증 후 임시 서버를 종료했다([실행 증거](evidence/25-event-tools-preference-reset-2026-09-29.json)).

2026-09-29 지도 편집기 대화상자 통일: 지도 생성·복제 이름 입력, 삭제·저장·전환·에셋 가져오기·승인/거절·게시 이력 복원 확인을 브라우저 기본 `prompt`/`confirm`에서 공통 `Dialog`로 옮겼다. 기존 창 크기·숨김·복원과 포커스 복귀를 공유하고, 모바일 화면 안에 맞는 이름 입력 및 숨긴 뒤 입력값 보존, 한국어·영어 확인 문구를 추가했다. MapEditor 안에 남은 브라우저 기본 확인/입력 호출이 없는 것을 검색으로 확인했다. Editor Chromium 회귀 26/26, 프론트 Vitest 47개 파일·159개, TypeScript, production build와 Prettier가 통과했다. 전체 E2E의 공동 편집 테스트는 묶음 실행에서 일시 시간초과가 한 번 있었지만 같은 테스트 단독 및 후속 전체 실행은 통과했다. 실제 기기 스크린리더 검수는 남아 T25.1을 미완료로 유지한다.

2026-09-29 앱 전반 확인·이름 입력 모달 통일: 공간 보관/복제, 소유권 이전, 그룹 대화 멤버 관리/나가기, DM 삭제, 신고 처리, 행사·회의실 예약 취소, 공유 화이트보드 비우기와 맵 편집 권한 인계의 브라우저 기본 확인창을 공통 숨김/복원 모달로 옮겼다. 공간 이름 입력도 같은 모달로 제공하고 한국어·영어 리소스, 입력 포커스, 모바일 레이아웃을 적용했다. 안내 문구를 dialog의 accessible description으로 연결해 제목과 함께 읽히게 하고, DM 삭제 확인 및 공간 이름 입력에서 실제 접근 가능한 설명을 E2E로 확인했다. 캠퍼스와 채팅 패널 각각에 확인 기능을 연결하고, DM 삭제 취소 시 원문 유지·그룹 멤버 제거·공간 보관/복제·소유권 이전 흐름을 격리 Chromium에서 확인했다. 후속 취소/확정 브라우저 검사 7/7은 행사 취소, 한국어·영어 회의실 예약 취소, 화이트보드 비우기를 검증했다. 취소 상태 예약 카드의 낮은 글자 대비를 수정하고 WCAG 2.1 A/AA 검사를 한국어·영어 모두 통과했다. 390×844 화면에서 이름 입력 모달이 뷰포트 안에 있고 문서 가로 넘침 없이 표시되며, 모달 WCAG 2.1 A/AA 위반 0건과 숨김/복원 후 입력 보존을 확인했다. 프론트 Vitest 47개 파일·159개, TypeScript와 production build가 통과했다. 실제 기기 스크린리더 검수는 남아 T25.1은 미완료다.
