# OpenInstinct 아키텍처

macOS launchd 데몬 하나(`openinstinctd`, `daemon/src/main.ts`를 도는 Bun 런타임), 메뉴바 앱 하나, 작은 손쉬운 사용 헬퍼 하나. 모든 상태는 `~/.openinstinct` 아래. root 없음, SIP 켬, `gjc` 외 서드파티 바이너리 없음.

```
~/.openinstinct/
  bin/openinstinctd      bun 런타임 복사본 (재설치해도 TCC 아이덴티티 유지)
  bin/oi-presence        입력 중 / 읽음 헬퍼 (Swift, AX)
  bin/bun → openinstinctd  벤더링된 gjc shim(#!/usr/bin/env bun)이 찾도록
  lib/                   데몬 소스 + node_modules (install.sh가 복사)
  config.json            선택적 소유자 handle, 이름, 모델, 제한

  env                    프로바이더 키 (0600), SDK import 전에 로드
  state.db               SQLite: 커서, 전송, 자식, 모니터, 영수증, 어시스턴트 작업, 알림
  session/               메인 SDK 세션의 cwd (절대 레포 아님)
  children/{work,sessions,journal}/
  memory/                git 저장소, gajae-way 구조
  chrome-profile/        에이전트 전용 Chrome user-data-dir
  secrets/               소유자가 문자로 준 자격 증명 (서비스별 0600)
  logs/daemon.ndjson     구조화 로그, 보존 정책으로 로테이션
  run/control.sock       NDJSON 제어 소켓 (0600)
```

## 부팅과 레인

`env-bootstrap.ts`가 첫 import: `@gajae-code/coding-agent`가 평가되기 *전에* `~/.openinstinct/env`를 `process.env`에 넣습니다. SDK가 모듈 로드 시점에 자동 임포트한 자격 증명을 주입하는데, 소유자 파일이 이겨야 하기 때문입니다. 그 다음 `startDaemon()`:

1. **부트스트랩 머신**이 `config`와 AI 자격 증명을 프로브합니다. 코어 레인을 막는 것은 자격 증명뿐입니다. `config.json`이 없거나 형식이 잘못되어도 시작을 막지 않습니다. `core-config.ts`가 범위별 제품 기본값을 적용하고 폴백을 로그로 남깁니다. 전체 디스크 접근(FDA, `chat.db`)은 Chat만 써도 프로브하는 필수 기본 권한입니다. 거부·미확인·프로브 오류는 OS 기능 제한 진단으로 표시하며 코어를 중단하지 않습니다. FDA는 시스템 설정에서 소유자가 한 번 켜는 macOS TCC 스위치이지 작업별 확인이 아닙니다. 런타임이 스스로 부여할 수 없고 실제 프로브 성공만 접근 근거가 됩니다. 선택적 Messages 권한 프로브는 소유자 handle이 설정된 경우에 실행합니다. 5초마다 재프로브하고 상태를 소켓에 공개합니다.

2. **스토어**가 `state.db`를 엽니다(마이그레이션은 `store/migrations.ts`).
3. **제어 서버**는 코어가 자격 증명을 기다리는 중에도 소켓에서 즉시 리슨하므로 패널이 이유를 보여줄 수 있습니다.
4. 자격 증명 프로브가 통과했거나 `unknown`이면 **코어 레인**을 시작합니다 — 메인 세션, 자식 라이프사이클, 모니터 스케줄러/트리거/전파, 메모리 클로저, 보존. 제어 서버가 응답하는 모든 부트스트랩 상태에서 Chat 허브를 사용할 수 있습니다.

부트스트랩 상태는 `starting`, `credentials_blocked`, `running`, `degraded`입니다. `credentials_blocked`는 AI 계정 또는 관리되는 API 키가 준비될 때까지 코어가 멈춘 상태입니다. `running`은 코어를 시작할 수 있다는 뜻이며 iMessage 번호가 필요하지 않습니다. `degraded`는 프로브나 코어 시작이 예외를 던진 상태입니다. 기존 레인은 건드리지 않고, 다음 5초 평가에서 코어 시작을 다시 시도합니다.

코어 레인과 iMessage 레인은 수명이 분리되어 있습니다:

- **코어 레인**은 공유 SDK 세션, 자식, 모니터, 메모리, 채팅 화면을 소유합니다. AI 자격 증명만 문턱으로 삼으며 iMessage 설정 없이도 실행됩니다.
- **선택적 iMessage 레인**은 chat.db 워처, 전송 서비스, Messages 발신기, presence 경로를 소유합니다. 코어가 실행 중이고 소유자 handle이 설정되어 있으며 전체 디스크 접근 권한 프로브가 통과할 때 붙습니다. 자동화는 handle이 설정된 경우에만 프로브하고 `status.get`에 표시합니다. Messages 전송에는 자동화가, 입력 중/읽음 표시에는 손쉬운 사용 권한이 필요합니다. handle 없음, FDA 거부/프로브 오류, attach 실패, 코어 중단, 데몬 종료 때 레인이 분리됩니다.

레인 수렴은 부팅 시, 5초 재프로브마다(예: 권한 부여 직후), 소유자 handle이나 자격 증명 설정 변경 직후에 실행됩니다. attach, detach, handle 교체에 데몬 재시작은 필요하지 않습니다. handle을 바꾸거나 지울 때는 항상 이전 handle을 먼저 폐기합니다. 레인을 분리하고 세션을 리로드한 뒤, 새 레인을 붙이기 전에 이전 handle의 pending/in-flight 원장 행을 만료시킵니다. 같은 handle의 권한 분리에서는 이 행을 다음 attach 때 재생하도록 보존하며, 분리된 상태에서 시작한 턴은 전체 수명 동안 채팅 전용으로 남습니다.

### 레인·라우팅 진단용 로그 이벤트

주 NDJSON 로그에는 다음 라이프사이클·라우팅 이벤트가 기록됩니다:

- `core_lane_started`, `core_lane_stopped`: 공유 코어 수명 시작/종료.
- `imessage_lane_attached`, `imessage_lane_detached`,
  `imessage_lane_attach_failed`: 선택적 iMessage 수렴 상태.
- `delivery_skipped_no_imessage_lane`: 레인이 분리되었거나 generation이 바뀌어 소유자 부작용을 버린 기록.
- `deliveries_expired_for_handle`: 이전 소유자 handle과 함께 폐기한 pending/in-flight 원장 행.
- `config_missing_defaults_applied`, `config_invalid_defaults_applied`: 코어를 유지한 채 설정 기본값으로 폴백한 기록.
- `session_reloaded`: 세션 리로드 기록(레인/페르소나 변경 포함).
- `router_initial_user_skipped`: queued steering을 분류할 때 SDK router가 해당 run의 최초 user 메시지를 건너뛴 기록.

## 수신: iMessage와 Chat → 공유 소유자 턴

iMessage 어댑터는 계속 `imessage/reader.ts`로 `chat.db`(읽기 전용, WAL)를 ROWID 커서부터 폴링합니다. 커서는 DB 지문(경로 + 최초 guid)에 묶이고, 첫 접촉이나 아이덴티티 변경 시 `max(ROWID)`에 앵커해서 아무것도 재생하지 않습니다 — 소유자 본인 대화창에 실패 문자 21개를 쏜 사고가 이유입니다. 본문은 `text` 또는 최신 Messages의 `attributedBody` typedstream(`decodeAttributedBody`)에서 가져옵니다. 설정된 번호만 허용하고 나머지는 조용히 버립니다. 빈 행/탭백/U+FFFC만 있는 행은 턴이 되지 않습니다. 이 어댑터는 수신 첨부(≤ 8 MiB)도 읽어 `PromptImage[]`로 전달합니다.

패널의 `chat.send` 제어 verb가 다른 얇은 어댑터입니다. 별도 Chat 창의 텍스트를 받아 트랜스크립트에서 출처를 복원할 수 있도록 `[sent from the Chat window]`를 붙이며, `chat.db`, 허용 목록, Messages presence는 건드리지 않습니다.

두 어댑터 모두 출처에 무관한 `OwnerTurnIngress`를 호출합니다. 이 모듈 하나가 소유자 에코를 내보내고, 일시정지 억제, 바쁠 때 steer, 실패 차단기, 메모리 캡처, 세그먼트 flush, 최종 처리를 두 입력 경로에 똑같이 적용합니다. 달라지는 것은 라우팅뿐입니다. iMessage는 읽음과 Messages presence를 쓸 수 있고, 패널 턴은 Chat 허브 presence를 씁니다. 입력 중 표시는 턴 단위 presence이며 정기 상태 메시지가 아닙니다.

## 메인 세션

`sdk-session/main-session.ts`가 SDK `createAgentSession` 하나를 감쌈. 데몬 시작마다 같은 트랜스크립트 파일 위에서 다시 엽니다(`SessionManager`). 메시지마다 재생성되는 일은 없음.

- **직렬 큐**: 턴, 리로드, 컴팩션이 한 번에 하나.
- **스티어링**: `interruptMode=wait`, `steeringMode=all` — 진행 중 툴 호출은 끝내고, 쌓인 소유자 문자는 한꺼번에 들어감.
- **세그먼트**: 어시스턴트 텍스트를 툴 호출 직전과 assistant `message_end`마다 소유자에게 flush. 생각–행동–생각 턴이 마지막에 벽 하나 대신 짧은 문자 여러 개로. 소유자 턴만 스트리밍하고 내부 턴(영수증 후속, 모니터 진단)은 조용함.
- **이미지 포워딩**: 에이전트가 이미지 경로를 `read`하면 그 파일을 소유자에게 첨부로 admit.
- **워치독**: 무활동 기반(기본 300초 동안 SDK 이벤트 *없음*), 스트리밍/툴 호출/스티어가 리셋. 타임아웃 시 abort 또는 dispose + 같은 트랜스크립트 위에 재생성.
- **컴팩션**: SDK 자동 컴팩션 끔; 턴이 끝난 뒤 컨텍스트 ≥ 50 %면 데몬이 컴팩션.
- **리로드**(`session.reload`): 같은 트랜스크립트 위에 dispose + 재생성 → 바뀐 시스템 프롬프트가 히스토리 손실 없이 적용.
- **시스템 프롬프트** = gjc 기본값 그대로 → `persona/GAJAE_SOUL.md`(캐릭터, 버전 관리) → `persona/RUNTIME.md`(환경: iMessage, 플레인 텍스트, 위임 규칙, 모니터 규칙, Chrome 프로파일; `{{ownerHandle}}` 등은 config에서 치환).
- **커스텀 툴**: `delegate_background`, `send_image`, `child_nudge`, `child_status`, `monitor_author`, `memory_search`, `memory_capture`, `memory_audit`, `assistant_work_observe`, `assistant_service_monitor`, `assistant_local_file`, `assistant_work_status`, `assistant_managed_install`, `assistant_managed_http`. 작업/대화형 자식에는 관리형 로컬 파일 툴을, 모니터 자식에는 관찰 및 읽기 전용 서비스 모니터 툴을 제공합니다.
- **익스텐션**: `browser/enforce.ts`는 계정 신원과 동시 탭 충돌 방지를 위해 전용 Chrome 프로파일과 자식 탭 라우팅을 강제합니다. 그 밖의 SDK hard-enforcer 제한은 제거되었습니다. 네이티브 권한 기본값은 allow이며 애플리케이션 경로 금지 목록, Discord API 일괄 금지, 메인 셸 timeout 제한, 고정 툴 호출 횟수, task·subagent·job 금지는 없습니다. OS·서비스 권한은 그대로 적용되며 작업 관련 접근이 비밀 노출을 정당화하지는 않습니다.
- **응답성을 위한 위임**: MainSession은 통합 자식 수명 관리·진행 상황·receipt 보고를 위해 긴 작업에 `delegate_background`를 권장합니다. 유일한 spawner는 아니며 네이티브 task·subagent·job 툴도 사용할 수 있습니다. 적절한 timeout이나 비동기 셸 실행은 작업별 선택입니다. MainSession이 자식 보고를 검토하고 전달하며 백그라운드 worker는 iMessage를 직접 보내지 않습니다.

## 어시스턴트 작업과 관리형 부작용

`assistant-work/`와 `store/assistant-work.ts`는 작업, 관찰, 정규화된 액션 리비전, 실행 시도, 후속 정책, 소유자 알림을 내구성 있게 기록합니다. `assistant_work_observe`는 `system` 또는 `third_party` 출처만 받습니다. 호스트 평가가 무시할 근거, 불확실한 제안, 추적할 명확한 미완료 작업을 가르지만 관찰을 소유자 지시로 바꾸지는 않습니다. `assistant_service_monitor`는 명확한 경우만 중요/진행 중이면 5분, 그 외에는 45분 주기의 서비스 중립적 읽기 전용 모니터로 만들 수 있습니다. 이 읽기 전용 규칙은 협력적 정책이지 OS 수준 격리가 아닙니다.

선택적 관리형 경로는 다음과 같습니다.

- `assistant_local_file`: 정규화된 절대 경로의 일반 파일 쓰기와 명시적 삭제를 제안/실행합니다. 호스트가 대상 인벤토리를 읽고 부작용 등급을 계산합니다.
- `assistant_managed_install`: 절대 작업 디렉터리에 정확한 버전의 Bun 패키지 하나를 제안/설치합니다. 호스트가 Bun 경로와 argv를 소유하고, 기본값 `ignoreScripts=false`로 정상적인 패키지 lifecycle 동작을 사용하며, 한 번의 spawn 전후를 다시 검사합니다.
- `assistant_managed_http`: 제한된 GET을 읽거나 정확한 POST/PUT/PATCH/DELETE 하나를 제안/실행합니다. 변경 요청은 redirect와 자동 재시도 없이 한 번만 실행하고 별도 GET으로 기대 상태를 검증합니다.
- `assistant_work_status`: 작업, 액션 ID/리비전/digest, 시도 상태를 읽기만 하며 실행은 하지 않습니다.

메인과 백그라운드 세션은 소유자 작업을 raw 셸·파일·브라우저 등 사용 가능한 툴로 바로 실행하며 작업별 확인이나 관리형 툴로의 강제 전환은 없습니다. 관리형 툴은 내구성 있는 사전 점검과 효과 검증을 위한 선택적 경로입니다. 툴 결과는 실행 근거이지 독립 검증은 아니므로 불확실한 효과를 검증된 성공으로 말하지 않고, 재시도 전에 중복 효과를 확인합니다.

새 관리형 액션은 `planned`로 시작하며 액션 ID, 양의 정수 리비전, 정규 SHA-256 digest로 식별됩니다. 실행은 같은 세 값을 제출해야 합니다. 관리형 executor는 claim 직전과 변경 직전에 호스트 상태를 다시 검사하고, 실제 부작용 전에 `effect_started`를 영속화하며, 검증 근거로 종료 상태를 기록합니다. 이 검사는 데이터 무결성과 취소를 보존하는 절차이지 애플리케이션 허가 교환이 아닙니다. 불확실한 실행 후 결과는 조정 대상이며 맹목적으로 재실행하지 않습니다.

`OwnerTurnIngress`는 로컬 Chat 소켓 또는 설정된 iMessage allowlist를 통해 직접 소유자 메시지를 인증합니다. 정확한 취소 명령은 첨부나 인용 없이 아래 한 줄 그대로여야 합니다.

```text
/reject ACTION_ID REVISION DIGEST
```

`DIGEST`는 소문자 16진수 64자입니다. 알 수 없는 액션, 낡은 리비전/digest, 추가 문구는 거부됩니다. `/reject`는 해당 현재 리비전을 새 효과 없이 취소하지만 이미 시작된 효과를 되돌리지 않습니다. 웹페이지, 메시지, 모니터, 자식 보고, 메모리, 툴 출력, 모델의 판단은 근거이지 인증된 소유자 지시가 아닙니다. 완료는 명령 접수나 관찰된 출력이 아니라 검증된 효과로 판단합니다.

### 후속 정책과 복구

인증된 소유자는 이미 확인된 액션에 첨부 없는 독립된 한 줄의 명령으로 제한된 반복 정책을 붙일 수 있습니다.

```text
/followup {"workId":"…","actionId":"…","enabled":true,"intervalMs":60000,"maxAttempts":1}
```

다섯 필드는 모두 필수이고 추가 필드는 거부됩니다. 정책은 액션의 현재 리비전과 digest를 캡처하며, 비활성 또는 `maxAttempts: 0`이면 예약하지 않습니다. 명령 자체는 액션을 즉시 실행하지 않고, 원본 액션이 `confirmed`가 된 뒤에만 due 실행이 진행됩니다. 런타임은 활성 정책을 폴링하고 ordinal마다 새 `planned` 액션을 만들며, 현재 정책·deadline·work 상태·시도 상한을 다시 확인한 뒤 저장된 payload가 가리키는 실제 local-file/install/HTTP executor를 사용합니다. 정책이나 원본 액션이 바뀌면 이전 경로를 멈추고, `ambiguous` 또는 취소 결과면 이후 반복을 중단합니다. 파생 액션은 작업별 확인 없이 진행합니다.

`AssistantWorkRuntime`은 부팅 시에도 복구합니다. 지원되는 local-file/install/HTTP 액션의 `claimed_pre_effect` 시도는 실제 executor로 재개할 수 있지만, 중단된 `effect_started` 시도는 reconcile-only/`ambiguous`로 표시하고 재실행하지 않습니다. 영속 복구 보고는 소유자 알림 전에 MainSession 내부 턴을 거치며 가짜 성공을 만들지 않습니다. 완료는 정책 저장이나 큐 등록이 아니라 검증된 executor 결과와 실제 사용 경로의 수용 증거로 판단합니다.

### 관리형 HTTP 호스트 정책

`main.ts`는 `configuredHttpAccess()`와 함께 관리형 HTTP 툴을 등록합니다. `OI_HTTP_LOCAL_ORIGINS`는 private/local 주소 해석을 허용할 정확한 `scheme://host[:port]` origin의 JSON 배열이며, cloud metadata endpoint는 항상 차단됩니다. `OI_HTTP_SECRET_BINDINGS`는 호스트가 소유하는 JSON 객체로, 각 reference 값에는 정확히 `origin`, `header`, `environment`가 있어야 합니다(예: `{"mailApi":{"origin":"https://api.example","header":"Authorization","environment":"MAIL_API_TOKEN"}}`). 툴 호출은 비밀 값이 아니라 `mailApi` 같은 `secretRef`만 전달합니다. 데몬은 지정된 환경 변수 값을 스냅샷하고 origin과 header가 모두 정확히 맞을 때만 풉니다. 민감한 header, query parameter, body key에는 평문 자격 증명을 넣을 수 없습니다. 공용 평문 HTTP로 secret reference를 보낼 수 없고, redirect를 따라가지 않으며, DNS 결과를 검증해 연결 주소를 고정합니다. 변경 뒤 별도 GET이 기대 상태를 입증하지 못하면 성공이 아니라 `ambiguous`입니다.
호스트 운영자는 이 값을 데몬의 비공개 `~/.openinstinct/env` 파일에 `KEY=value` 형식으로 넣고 mode 0600을 유지합니다. 프롬프트 내용은 이 호스트 정책을 바꿀 수 없습니다.

### 적응형 소유자 알림

메인 세션이 작성한 사전 알림은 안정 ID로 영속화하며 생성만으로 전달됐다고 간주하지 않습니다. `ChatActivity`는 최근 샘플에서 Chat 창이 전면이고 마지막 입력이 2분 이내일 때만 활성으로 봅니다. 활성 Chat을 먼저 선택하고, 아니면 연결된 iMessage를 선택하며, 둘 다 없으면 알림은 기다립니다.

Chat 경로의 목록 조회는 전달이 아닙니다. 패널이 실제 렌더링을 확인할 때까지 경로는 `uncertain`이고, 렌더링과 소유자 확인도 서로 다릅니다. iMessage가 먼저 선택된 알림도 공유 Chat 히스토리에 표시되고 Chat dispatch 행 없이 렌더링 시각을 기록할 수 있습니다. 소유자가 **확인**을 누르면 acknowledgement가 기록되어 추가 라우팅을 멈춥니다. Chat 경로가 렌더링됐지만 확인되지 않은 채 Chat이 비활성화되면 iMessage로 fallback할 수 있습니다. iMessage 큐 admission도 전달 확인이 아니며 Messages 원장이 확인해야 `delivered`입니다. 중단되거나 불확실한 경로는 맹목적으로 다시 보내지 않고 reconcile-only로 남깁니다.

제어 표면은 `assistant.notifications.list` (`{}`), `assistant.notifications.rendered` (`{notificationId}`), `assistant.notifications.ack` (`{notificationId}`)입니다. 목록은 내구성 있는 `{id, text, acknowledged}` 행을 반환하며 패널은 확인된 행을 화면에서 제외합니다.

## 발신: ChatHub, 적응형 알림, 선택적 iMessage

`ChatHub`가 소유자 에코, 어시스턴트 세그먼트, 최종 어시스턴트 메시지, 이미지, presence를 제어 소켓 구독자에게 fan-out합니다. 모든 이벤트에는 데몬 수명 동안 단조 증가하는 `seq`가 있습니다. `chat.history`는 공유 트랜스크립트에서 소유자에게 보이는 최근 50개 행을 읽고, 운영자 메모·영수증 후속·모니터 트리아지를 걸러내며, orientation 텍스트를 제거하고, 끝의 `[sent from the Chat window]` 표식으로 출처를 복원합니다. 응답에는 시퀀스 워터마크와 메시지만 담은 tail이 있어 구독자가 현재 스냅샷과 실시간 이벤트를 빠짐이나 중복 없이 합칠 수 있습니다.

`OwnerOutbox`는 소유자 턴의 iMessage 경계입니다. 선택적 iMessage 레인이 붙어 있으면 현재 번호를 고정하고 텍스트·이미지를 내구성 있는 `DeliveryService` 원장으로 보내며, 읽음·입력 중 표시는 Messages presence 경로를 사용합니다. 분리 중에도 소유자 턴 출력은 ChatHub에 도착하고 직접 iMessage admission/presence만 건너뜁니다. 메인 세션이 작성한 사전 출력은 버리지 않고 어시스턴트 알림 원장에 넣어 활성 Chat에 표시하거나 확인된 iMessage로 보내거나 경로가 생길 때까지 기다립니다. 턴별 binding은 레인 generation을 캡처하므로 분리 상태에서 시작한 턴은 중간 attach를 따라가지 않고, detach로 무효화된 턴의 남은 iMessage 부작용도 버립니다. 영수증·모니터·메모리 감사·운영자 메모 출력은 보통 대화 말풍선을 우회해 알림 경로를 쓰며, 소유자 메시지가 내부 run을 승격하면 그 시점 이후 출력만 소유자에게 보입니다.

`delivery/service.ts`는 `state.db`의 내구성 있는 outbox입니다. `admit()`이 멱등 키와 함께 행을 쓰고, flush 루프가 제한된 재시도 사다리로 보내며 `confirmed` / `expired` / `failed_ambiguous`를 기록합니다. 모든 텍스트와 캡션은 `toPlainText()`(마크다운 제거)를 거칩니다 — 프롬프트가 플레인 텍스트를 부탁하고 새니타이저가 보장합니다.

`imessage/sender.ts`는 Messages 자체 AppleScript 브릿지(`send <text|file> to participant`)로 보냅니다. 브릿지가 그 외엔 노출하지 않아서 답장은 플랫(reply-to 없음)이고, 입력 중/읽음은 바이너리가 있을 때 `oi-presence`에 위임합니다. 첨부는 `~/Pictures/OpenInstinct/`에 스테이징하고 `mdimport` 먼저 — `imagent`가 Spotlight 메타데이터 없는 파일을 거부하기 때문입니다. 확인자는 `chat.db`에서 발신 행을 감시합니다.

`oi-presence`는 Messages를 ~300ms 전면에 띄워야 해서, 소유자가 `presence.idleSec`(기본 8초) 동안 입력이 없을 때만 돌고 포커스를 돌려줍니다.

## 자식

`children/lifecycle.ts`는 대화형과 모니터 우선순위 작업을 동시성 캡(기본 4)과
live-child 캡(기본 16) 아래에서 admit한다. live 캡은 종료되지 않은 모든 자식을
세며, 새 작업을 받기 전에 가장 오래된 `idle` 또는 `cold` 자식을 종료하고,
내보낼 자식이 없으면 admission을 거부한다.

`delegate_background` 자식(`kind: task_tool`)은 대화형이다. 외부에 보이는 내구성
수명은 `running → idle → cold → terminated`다. `idle` 동안에는 warm TTL까지 SDK
세션 객체를 유지하고, 이후에는 객체만 dispose하되 session-file 트랜스크립트는
보존한다. `cold` 넛지는 그 트랜스크립트를 다시 열고, idle timeout은 자식을
종료한다. 메인 세션의 `child_status`는 미리 계산한 메모리 상태 스냅샷만 읽고
`child_nudge`는 메모리 lifecycle 큐만 바꾼 뒤 pump을 예약한다. 두 툴은 호출 시
SQLite나 자식 SDK 세션에 들어가지 않는다. latency alert threshold는 탐지 telemetry이며
선점 보장이 아니다. 대화형 자식만 `report_progress`를 받으며, 업데이트는 내구적으로
저장되고 UTF-8 경계로 잘리며, 기본 3초 배치와 자식별 레이트 리밋을 거쳐 owner turn
steer 또는 메인 내부 turn으로 주입된다.

모든 자식 kind의 실패와 재시작 orphan은 interim 배치를 건너뛰고 내구성 receipt가
됩니다. 모든 receipt는 영속 MainSession의 내부 triage turn으로 먼저 갑니다. 대화형·사전 텍스트는 MainSession이 작성하고, 인증된 host 경로는 `/reject`·`/followup` 같은 결정적 명령 결과를 반환할 수 있습니다. background worker는 iMessage를 직접 보내지 않습니다. 메인 에이전트는 retry/resume/redelegate/repair/정리/침묵을 선택할 수 있고, 소유자의 판단이 필요할 때만 간결한 자연어 한 줄을 보냅니다. 원시 state 토큰, provider error code, stack, 경로와 receipt projection은 내부 근거로만 남으며 소유자에게 절대 가지 않습니다.
## 모니터

`monitors/store.ts`가 리비전 펜싱과 함께 스펙을 `state.db`에 보관. 트리거: `cron`(IANA tz, 명시적 DST 규칙), `watcher`(파일 루트), `webhook`(토큰), `script`(간격, 스크립트 루트만). 선택적 `expiresAt`이 만료 시 모니터를 끔. `memory-canonicalize`, `memory-audit`, `computer-usage-insight`는 한 번 시드되고 앞의 둘은 보호됨.

발화 → `propagation.ts` 상태 머신: `admitted → batched → dispatched(자식) → authored → delivered`, 리스 펜싱, 재시작 후에도 재생 안전. "Authored"는 자식의 터미널 리포트를 **메인 세션에 진단 턴으로** 넘김: 가재가 진단하고, `monitor_author`로 모니터를 고칠 수 있고, 소유자에게 플레인 한 줄을 씀 — 스스로 해결된 잡음이면 침묵. 원시 에러 코드는 소유자에게 절대 가지 않음.

수동 `monitors.run` 요청은 예약 deduplication에 삼켜지지 않도록 고유 occurrence key를 사용하며, 비활성·보호 모니터를 포함해 같은 전파 경로로 즉시 한 번 실행합니다. 모니터 일정이나 enabled 상태는 바뀌지 않습니다.

## 메모리

`memory/vendor/`는 gajae-way 메모리 엔진 그대로(레지스트리, 독트린, 오토링크, 밸리데이터, BM25 검색), `PROVENANCE.md`에 핀. `adapters/`가 환경 제공: 모든 소유자 턴이 캡처 인텐트로 큐잉되어 `daily/`에 쓰이고 커밋; 정규화(6시간마다)가 people/projects/decisions로 승격; 일일 감사가 구조 문제를 보고. 툴은 벤더링된 함수의 얇은 래퍼.

기존 트랜스크립트는 `memory.backfillCaptures` 제어 verb로 캡처 축과 다시 맞출 수 있습니다. 데몬은 소유자 메시지와 뒤따르는 어시스턴트 답장을 짝지어 원래 시각을 보존하고, 데몬이 주입한 프롬프트는 건너뛰며, 결정적 매칭으로 반복 실행도 안전하게 만듭니다.

## 제어 프로토콜

`control/schema.ts`가 NDJSON 프레임(hello/negotiate, request, response, error, event)과 verb 목록을 정의합니다. `daemon/test/fixtures/control/`의 픽스처가 골든 소스이며 `scripts/sync-control-fixtures.sh`가 Swift 테스트 타깃으로 복사해서 패널 코덱을 바이트 단위로 검증합니다. 주요 verb: `status.get`(부트스트랩, 세션, 자식, 모니터, `attention`), `monitors.*` 및 `monitors.run`, `daemon.pause/resume/restart`, `session.compact/reload`, `settings.get/set`, `models.list`(10분 캐시; `{"refresh": true}`를 보내면 `gjc --list-models`를 다시 실행하고 TTL을 초기화 — 패널의 새로고침 버튼이 이 요청을 보냄), `accounts.*`(`gjc auth-broker login`을 통한 OAuth, 코드 붙여넣기 폴백), `providers.custom`(`~/.gjc/agent/models.yml`에 프로바이더 블록 기록), `browser.open`, `memory.backfillCaptures`, `chat.activity`, `assistant.notifications.list`, `assistant.notifications.rendered`, `assistant.notifications.ack`.

`accounts.discover`는 기존 Claude 및 ChatGPT/Codex CLI 자격 증명을 찾아 채택 가능한 계정으로 나열합니다. `accounts.adopt`는 소유자가 **Adopt**를 누른 뒤에만 데몬이 선택한 자격 증명을 바꾸며, 기존 구독으로 과금이 시작될 수 있으므로 자동 채택하지 않습니다. `monitors.run`은 모니터 일정이나 enabled 상태를 바꾸지 않고 즉시 한 번 실행합니다.

Chat 화면은 `chat.send` (`{text}`), `chat.history` (`{limit}`), `chat.subscribe` (`{}`)를 사용합니다. 구독은 opt-in인 `chat.message`와 `chat.presence` 이벤트 토픽을 받습니다. 모든 Chat 이벤트 payload에는 숫자형 단조 증가 `seq`가 있고, 턴의 최종 어시스턴트 `chat.message`에는 `final: true`가 붙습니다. `chat.history` 응답은 `{messages, seq, tail, inFlight?, truncated?, tailTruncated?}`이며 `tail`에는 메시지 이벤트만 들어가므로 클라이언트가 히스토리와 실시간 이벤트를 손실·중복 없이 합칠 수 있습니다.

`status.get`에는 최상위 iMessage 레인 상태(`attached` 또는 `detached`와 reason, detail, 선택적 handle)와 자격 증명 프로브도 담깁니다. 번호가 설정되지 않은 채팅 전용 설치에서는 FDA와 Automation 프로브 항목 자체가 빠집니다.

## 패널

`panel/`은 명시적 `NSStatusItem` + `NSPopover`에 호스팅된 SwiftUI(`MenuBarExtra`는 macOS 26 launchd 아래에서 안 뜸)입니다. `status.get`을 폴링해 상태를 쉬운 말로 렌더링하고 `attention` 항목엔 1회성 `NSAlert`를 띄웁니다. 팝오버에는 **Chat…**이 항상 있고, 누르면 iMessage풍 말풍선과 플레인 텍스트만 쓰는 별도 `ChatWindowController` `NSWindow`가 열립니다. 데몬에 연결할 수 없거나 자격 증명이 없거나 세션이 일시정지된 경우에만 composer를 막으며, 선택적 iMessage 레인이 분리된 것은 막는 이유가 아닙니다. `SettingsWindow.swift`는 일반 탭 창이고, iMessage 탭에서 연결/분리와 권한 상태를 보여줍니다. 번호 변경은 데몬을 재시작하지 않습니다.

Chat 창은 내구성 있는 어시스턴트 알림도 폴링합니다. 알림은 트랜스크립트 위 **알림** 영역에 나타나며, 행이 보이면 패널이 `rendered`를 재시도하고 **확인** 버튼은 `ack`를 보냅니다. iMessage가 먼저 선택된 알림도 Chat dispatch 행 없이 공유 히스토리에 표시·렌더링할 수 있습니다. `ChatActivityReporter`는 5초마다 창이 전면인지와 마지막 입력 후 경과 시간만 샘플링해 Chat/iMessage 경로 선택에 씁니다. event tap을 설치하거나 키 입력 내용을 읽지 않습니다.

Account 탭도 OAuth/API 키 계정을 나열하고, 기존 CLI 자격 증명에 대해 명시적인 발견과 **Adopt**를 제공합니다. 소유자 동의 없이는 절대 채택하지 않습니다. iMessage 탭은 선택적 분기이며 handle이 설정된 경우에만 신원과 TCC 프로브를 표시합니다.

`co.openinstinct.panel`이 `open -W`로 로그인 시 실행해서 정상 Aqua 세션을 얻습니다.

## 설치와 패키징

`scripts/install.sh`가 레포를 `~/.openinstinct/lib`에 복사, 프로덕션 의존성 설치, bun이 바뀌지 않았으면 데몬 바이너리 inode 유지(TCC 권한 유지), `~/.local/bin`이 포함된 PATH로 launchd plist 렌더링, 패널과 presence 헬퍼 설치/실행.

`scripts/build-release.sh`가 패널과 presence 헬퍼를 컴파일하고, 그 페이로드에 bun 런타임과 벤더링된 SDK 버전에 고정된 `gjc` 바이너리를 담아 `dist/openinstinct-<version>-darwin-<arch>.tar.gz`와 `.sha256`을 만듦.

`scripts/install-remote.sh`가 curl 진입점: 릴리스 자산을 찾아 체크섬을 검증하고 아카이브를 풀어 그 디렉터리를 `bootstrap-from-payload.sh`에 넘기며, 그것이 소스를 `~/.openinstinct/src`에 스테이징한 뒤 `install.sh`를 호출. 설치 앱도 공증 단계도 없음 — Gatekeeper는 `com.apple.quarantine`이 붙은 파일만 검사하고 그 속성은 브라우저가 붙이지 curl은 붙이지 않으므로, 서명 없는 빌드도 승인 프롬프트 없이 설치·실행됨.

## 알아둘 안전 속성

- 히스토리 재생 없음; 소유자 외에는 답하지 않음; 설정 안내상 개인 Messages 계정에서 보내지 않음.
- 연속 턴 실패 2회 → 이후 실패 알림은 받은편지함이 아니라 로그로.
- 비밀: env 파일 0600, 더 느슨하면 거부; 설정 스냅샷은 키 존재 여부만 보고; 소유자가 문자로 준 자격 증명은 서비스별 저장, 절대 되풀이 안 함.
- 브라우저는 에이전트 전용 Chrome 프로파일에서만(권고가 아닌 강제).
- iMessage로 묶인 부작용은 내구성 있고 멱등적인 전송 원장 행으로 남고, Chat 허브 이벤트는 fire-and-forget으로 seq를 붙여 전달됩니다.
- system/third-party 관찰은 읽기 전용 추적을 제안하거나 예약할 수 있지만 소유자 출처를 만들거나 변경을 승인하지 못합니다.
- 선택적 관리형 효과는 호스트 사전 점검, 정확한 리비전/digest 펜싱, 취소, 실행 기록, 효과 검증을 사용합니다. raw 툴은 직접 사용할 수 있고 OS 권한은 macOS가 별도로 적용합니다.
