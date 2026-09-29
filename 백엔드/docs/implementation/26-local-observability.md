# 로컬 Prometheus 관측성

API와 World의 Micrometer 지표를 Prometheus text format으로 내보내고, 선택형 Compose `observability` 프로필이 두 서비스를 scrape한다. Prometheus는 `127.0.0.1:9090`에서만 열고 15일치 지표를 `prometheus-data` volume에 보관한다. 자체 정적 dashboard는 같은 Prometheus origin의 `/user/hufs-town.html`에 제공되며 1/6/24시간 그래프와 target 상태, command/join queue·tick·API·JVM 요약을 보여준다. 입장 큐는 현재 크기·용량·최근 5분 거절 수와 용량 사용률 추이를 제공한다. 원격 스크립트나 외부 차트 CDN을 요청하지 않는다.

Compose에서는 API/World Actuator를 메인 앱 포트와 분리해 관리 포트 `18082`/`18083`으로 연다. 이 포트들은 host port로 게시하지 않으며 기존 loopback application ports도 바꾸지 않는다. API는 health 및 Prometheus endpoint만 인증 없이 허용하고, `/actuator/info` 등 다른 API 경로는 기존 인증 규칙을 따른다. 로컬 직접 실행기는 loopback에 바인딩되어 있으므로 기존 관리 경로를 유지한다.

경보 규칙은 대상 수집 실패, World tick rolling p95 25ms 초과, command/join queue 각각 80% 초과, command queue rejection, API 5xx 비율 5% 초과를 감시한다. 관련 지표에는 JVM 기본 지표, HTTP 서버 요청 지표와 World의 tick·command/join queue 크기·용량·거절 수·접속자/연결 수가 포함된다.

2026-09-26 join queue 관측 추가: `hufs_world_join_queue_size`, `hufs_world_join_queue_capacity`, `hufs_world_join_queue_rejected_total`을 기존 관측 구성에 연결했다. 로컬 경보는 이제 6개이며, JS dashboard는 queue pressure 추이와 현재 크기/용량 및 최근 거절 수를 보여준다.

2026-09-26 초기 구성 검증: 전체 World 테스트 51개 통과, API SSO 통합 테스트 1/1 통과, API/World `bootJar` 생성 성공. 별도 임의 management port의 Prometheus scrape 내용에 JVM 및 World 지표가 포함되고, 앱 포트의 exporter 경로는 404이며, API `/actuator/info`의 익명 접근은 401임을 확인했다. 초기 `promtool check config`와 `check rules`에서 구성과 5개 경보 규칙이 유효했고 Docker Compose `config --quiet`도 통과했다. 대시보드 JS 구문 검사, 격리 검증 후 Compose Prometheus 실행, 실제 `/user/hufs-town.html`·CSS·JS·`/alerts`·`/targets`의 HTTP 200을 확인했다. 현재 실행 중인 API/World 앱 컨테이너에는 새 management port가 반영되지 않아 두 수집 target은 `connection refused` 상태다. 새 소스 적용 시 접속이 잠시 끊기므로 API/World를 재생성하지 않았다.

2026-09-26 join queue 관측 구성 확인: `promtool check config`에서 Prometheus 설정이 유효하고 `check rules`에서 6개 경보 규칙을 확인했다. Docker Compose `config --quiet`와 `node --check infra/prometheus/dashboard/dashboard.js`도 통과했다.

이 구성은 로컬 수집/경보 규칙과 간단한 로컬 dashboard까지다. Prometheus UI는 loopback 사용자만 접근할 수 있지만 자체 로그인은 없다. 외부 경보 수신자, 운영용 Grafana dashboard, 메트릭 저장 volume 백업, production HTTPS/시크릿/관리 네트워크 및 실제 서비스 복구 검증은 미구성이다. 따라서 T26.2는 계속 미완료다.

2026-09-26 World tick 분해: `hufs.world.tick.phase.duration` Timer는 고정 저카디널리티 `phase` 값(`commands`, `joins`, `simulation`, `room_state`, `maintenance`, `media_policy`, `snapshots`, `publication`)으로 tick 처리 단계를 노출한다. `hufs.world.join.command.duration`은 입장 큐 안 개별 작업의 count/total/max를 제공한다. 격리 100명 입장 burst 분석에서 join batch와 snapshot 생성/전송의 초과 tick을 구분하는 데 사용했다.