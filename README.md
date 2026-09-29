# GDG HUFS 훕스타운

GDG HUFS가 운영하는 실시간 2D 온라인 캠퍼스입니다. 웹 아바타로 공간을 이동하고, 가까운 사람과 대화하며, 카메라·마이크·화면 공유와 채팅을 사용할 수 있습니다.

서비스: [town.gdgoc.com](https://town.gdgoc.com)

## 구성

- `프론트/`: React, TypeScript, Vite, Phaser 기반 웹 클라이언트
- `백엔드/`: Spring Boot API·실시간 월드, Node.js mediasoup 미디어 서버, MariaDB·Redis 구성과 운영 문서
- 사용 중인 브랜드·도트 에셋은 `프론트/public/assets/`에 포함합니다. 원본 `디자인에셋/` 자료는 현재 이용·재배포 권한을 확인할 수 없어 Git 저장소에는 올리지 않습니다.

## 로그인

로그인은 HUFS 통합 인증(SSO)을 사용합니다. 재학생, 휴학생, 졸업생, 교수·강사·교원, 직원·교직원, 공용 계정 및 SSO가 반환하는 미분류 계정 유형을 지원합니다. 첫 정상 SSO 로그인 때 훕스타운 계정이 연결되며, 일반 이메일·비밀번호 회원가입은 제공하지 않습니다. 연결 설정은 [SSO 안내](백엔드/docs/development/hufs-sso.md)와 [계정 유형 정책](백엔드/docs/implementation/32-public-email-accounts.md)을 참고하세요.

## 로컬 실행

필요한 도구와 Docker·SSO 설정을 포함한 Windows PowerShell 시작 안내는 [백엔드 README](백엔드/README.md)에 있습니다. 로컬 SSO 비밀값과 운영 비밀값은 저장소에 넣지 마세요. 자세한 환경 경계와 배포 방법은 [운영 배포 안내](백엔드/docs/operations/production-deployment.md)를 따릅니다.

## 계획과 작업 현황

- [제품·기술 계획](백엔드/docs/planning/README.md)
- [미완료 작업 목록](백엔드/docs/planning/08-task-backlog.md)
- [구현 및 검증 기록](백엔드/docs/implementation/)
