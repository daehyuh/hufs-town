# ADR 0001 — 첫 구현의 런타임과 로컬 범위

상태: 채택. 미디어 엔진 선택은 이 ADR에 포함하지 않는다.

- Java 21 / Spring Boot 3.5.16 / Gradle Wrapper 8.14.3.
- React 19.3.0 / Vite 7.3.1 / TypeScript 5.9.3 / Phaser 3.90.0. 전체 버전은 프론트 package.json과 lockfile로 고정한다.
- MariaDB 11.4.10 / Redis 7.4.8 Docker 구성을 채택했다. 최초 Docker 미기동 오류는 해결됐고 실제 컨테이너 통합 검사 2개, Spring API `local` 프로필과 Flyway V1 적용을 확인했다.
- 초기 로컬 개발은 API `preview` 프로필로 영속 저장소를 명시적으로 비활성화할 수 있다. DB를 사용하는 `local` 프로필과 혼동하지 않는다. H2·메모리 저장소로 DB 검사를 통과시키지 않는다.
- 이름 기반 임시 접속은 loopback 주소에 바인딩한 local 월드에서만 등록한다. 기본 프로필에서는 bootstrap·테스트 WebSocket 경로를 제공하지 않는다. 운영 인증으로 사용하지 않는다.
- G0는 하나의 테스트 맵, 20Hz 시뮬레이션, 10Hz snapshot이다. 스냅샷은 연결별 ACK 기준으로 full/delta를 구성하며, 교체 가능한 송신 큐에서도 확인된 기준 상태 이후 변경분만 병합한다. 기준이 맞지 않으면 full snapshot으로 복구한다. AOI·다중 맵 소유권·Redis 정원 예약은 후속 태스크다.
- 서버가 이동과 충돌을 권위 있게 처리한다. 클라이언트는 로컬 예측을 부드럽게 보정하고, 순번 입력을 제한된 큐에 두어 서버 ACK 이전의 최신 held-input만 짧게 재적용한다. 입력 ACK는 플레이어 공용 레코드가 아닌 해당 수신자의 스냅샷 메타데이터에 담는다.
- 확인되지 않은 스냅샷은 1.5초 뒤 full로 다시 맞춘다. 연속 3회 ACK 동기화에 실패한 연결은 종료해 같은 full snapshot이 반복되는 상황을 제한한다. 재접속 token과 15초 자리 유지는 그대로 활용한다.
- 미디어가 없으므로 PRIVATE/SILENT 표시는 지도 구역 판정만 의미한다. 통화 연결 대상이나 개인정보 보호가 검증됐다는 표시를 하지 않는다.
- 사용자 폴더명을 보존하고 빌드 산출물만 상위 `.build/backend`의 ASCII 경로에 둔다. 실제로 발생한 Windows Gradle 테스트 worker의 ClassNotFound 오류가 이 구성에서 해소됐다. [Gradle 공식 이슈](https://github.com/gradle/gradle/issues/30391).

Spring 버전의 Java/Gradle 호환은 [공식 요구사항](https://docs.spring.io/spring-boot/3.5/system-requirements.html)과 Maven Central의 실제 BOM을 확인했다. 버전 선택은 전체 제품의 처리량 검증을 의미하지 않는다.
