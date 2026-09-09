# OpenInstinct 운영 가이드

일반 사용자는 [사용자 가이드](user-guide.md), 구조는 [아키텍처](architecture.md)를 보세요. 이 문서는 운영 레퍼런스입니다.

OpenInstinct는 모든 운영 상태를 `~/.openinstinct` 아래에 둡니다. 데몬은 `~/.openinstinct/bin/openinstinctd`, 제어 소켓은 `~/.openinstinct/run/control.sock`, 주 로그는 `~/.openinstinct/logs/daemon.ndjson`입니다.

## 선택적 iMessage 계정 (iMessage를 연결하기 전에 읽기)

SIP가 켜진 macOS 26에서 유일한 발신 경로는 로그인한 macOS 사용자의 Messages 앱입니다. 따라서 선택적 iMessage 레인은 그 사용자의 Messages 계정을 씁니다. 내가 개인적으로 쓰는 Messages 계정에 절대 붙이지 마세요. 가재의 모든 답장이 내 대화창에 뜨고 내 메시지에 이어집니다. Chat만 쓰는 설치라면 이 절 전체를 건너뛰면 됩니다.

지원하는 형태는 하나입니다. 이 Mac의 Messages를 에이전트 전용으로 만든 Apple
ID로 로그인해 둡니다(Messages → 설정 → iMessage → 로그아웃 → 로그인). iPhone에는
영향이 없고, 이 Mac에서 내가 Messages를 직접 쓰지 않게 될 뿐입니다. 메뉴바
패널은 보이는 계정을 표시하고, 내 Apple ID로 로그인된 동안은 실행을
거부합니다(`identity_blocked`).

두 번째 macOS 사용자 아래에서 돌리는 것도 가능은 하지만(자체 `~/.openinstinct`, 자체 TCC 권한, 그 세션이 항상 로그인돼 있어야 함) 문서화된 경로는 아닙니다. macOS 26에는 프로그램으로 세션을 전환할 방법이 없고 FileVault 때문에 자동 로그인도 안 되므로, 재부팅 후 사람 손 없이 살아남지 못합니다.

안 되는 것: macOS VM(가상 시리얼에서 iMessage 활성화 실패), 같은 계정에서 자기
자신에게 문자(`is_from_me` 행은 설계상 버림). 새 Apple ID는 인증용 신뢰 전화가
필요하고 iMessage 활성화까지 최대 24시간 걸릴 수 있습니다.

계정과 무관하게 항상 작동하는 안전장치: chat.db에 처음 붙을 때 커서를 최신 행에
앵커하고 아무것도 재생하지 않음; 빈 행/탭백 행은 턴이 되지 않음; 턴이 연속 2회
실패하면 이후 실패 알림은 받은편지함 대신 `daemon.ndjson`으로 보냄.

## 최초 설치와 권한

`~/.openinstinct/bin/openinstinctd`의 전체 디스크 접근 권한은 Chat 전용 설치를 포함한 모든 설치의 기본 OS 권한입니다. 시스템 설정 → 개인정보 보호 및 보안 → 전체 디스크 접근 권한에서 한 번 켭니다. OpenInstinct는 실제 접근 여부를 검사하고 부족한 권한을 표시하되 준비된 Chat 실행을 막지 않으며, macOS TCC 권한을 스스로 부여할 수는 없습니다. 선택적 iMessage 설정은 별도 분기입니다. 런타임 도구 실행에는 액션별 앱 내부 확인이 필요하지 않습니다.

### 일반 사용자 설치

1. `curl -fsSL https://raw.githubusercontent.com/Yeachan-Heo/openinstinct/main/scripts/install-remote.sh | sh`가 최신 릴리스 아카이브를 찾아 `.sha256`을 검증하고 풀어서 `scripts/bootstrap-from-payload.sh`를 실행합니다. 수동으로 하려면 Releases에서 `openinstinct-<version>-darwin-<arch>.tar.gz`를 받아 `tar -xzf`로 풀고 `sh <디렉터리>/scripts/bootstrap-from-payload.sh <디렉터리>`를 실행하세요.
2. 파일을 복사하고 메뉴바 패널을 엽니다. AI 계정이 준비되면 Chat을 바로 쓸 수 있고, **Settings → AI account**에서 기존 구독으로 로그인하거나 키를 붙여넣거나 커스텀 엔드포인트를 설정합니다. 패널의 실시간 설정 UI는 선택적 iMessage 분기를 별도로 보여줍니다.
3. 폰 문자를 추가하려면 **Settings → iMessage**에서 소유자 handle을 입력하고 위의 신원·권한 안내를 따릅니다. Chat 전용 설치라면 이 분기를 완전히 건너뜁니다.

패널은 각 단계의 상태를 실시간으로 보여주고, 막힌 단계에서 할 일을 안내합니다. 설치 앱은 없으며 릴리스 아카이브와 curl 진입점이 지원되는 설치 경로입니다.

### 개발자 설치 경로

0. 프로바이더 자격 증명. AI 계정 또는 관리되는 API 키가 준비되면 코어 레인이 시작됩니다. 데몬은 로그인 셸 없이 launchd 아래에서 돌기 때문에 `.zshrc`의 API 키가 닿지 않습니다. `~/.openinstinct/env`에 `KEY=value` 줄로 넣고 `chmod 600` 하세요. 데몬이 시작 시 로드하고(그룹/전체 읽기 가능하면 거부) `env_file_loaded`에 키 이름만 기록합니다. 필요한 키는 `~/.gjc/agent/models.yml`에서 `mainSessionModel`의 프로바이더 `apiKeyEnv`를 따릅니다. 패널 **Settings → AI account**에서도 같은 작업을 할 수 있으며, **Accounts** 탭은 기존 Claude 및 ChatGPT/Codex CLI 자격 증명을 발견하고 소유자가 **Adopt**를 누른 경우에만 채택합니다. 기존 구독으로 과금이 시작될 수 있으므로 자동 채택하지 않습니다.

1. 선택적 iMessage 설정. 코어 레인에는 필수 설정 키가 없습니다. iMessage를 붙이려면 `~/.openinstinct/config.json`에 소유자 handle 하나를 씁니다. 전화번호는 국가번호 포함, 이메일 handle은 소문자로 정규화합니다. 파일이 없으면 유효하며 제품 기본값을 적용합니다. 파일이나 특정 범위의 형식이 잘못되면 그 범위는 기본값으로 돌아가고 `config_invalid_defaults_applied` 로그를 남기므로 Chat을 막지 않습니다.

   ```json
   {
     "allowlistHandle": "+821012345678",
     "ownerName": "나",
     "mainSessionModel": "anthropic/claude-sonnet-4-5",
     "presence": { "enabled": true, "idleSec": 8 }
   }
   ```

   이 키들은 모두 패널 설정 창에서도 편집할 수 있습니다. `allowlistHandle`은 선택적 iMessage 번호이지 Chat 창의 전제 조건이 아닙니다.

2. 레포 루트에서 설치합니다:

   ```sh
   bash scripts/install.sh
   ```

   `~/.openinstinct/bin/openinstinctd`에 안정적인 Bun 실행 파일을, `~/.openinstinct/lib`에 런타임 복사본을 두고 `~/Library/LaunchAgents/co.openinstinct.daemon.plist`를 설치·부트스트랩·킥스타트합니다. 메뉴바 패널도 `~/Applications/OpenInstinctPanel.app`에 설치하고 로그인 시 실행하도록 등록합니다. 데몬 업데이트 후 다시 실행하면 TCC가 같은 실행 경로를 계속 참조합니다(bun이 바뀌지 않으면 inode 유지).

3. iMessage를 연결한다면 **시스템 설정 → 개인정보 보호 및 보안 → 전체 디스크 접근 권한**에서 `+` → `~/.openinstinct/bin/openinstinctd` 추가. 선택적 레인이 `chat.db`를 읽는 데 필요하며 Chat에는 필요하지 않습니다. 5초마다 재프로브하므로 권한을 바꾼 뒤 데몬 재시작은 필요하지 않습니다.

4. iMessage를 연결한다면 macOS가 물을 때 `openinstinctd`가 Messages를 제어하도록 **자동화**를 허용합니다(또는 **개인정보 보호 및 보안 → 자동화**에서 허용). Messages로 문자를 보내는 데 필요한 권한입니다.

5. 선택적 입력 중/읽음 표시가 필요할 때만 `~/.openinstinct/bin/openinstinctd`에 **손쉬운 사용** 권한을 부여합니다(`oi-presence`가 데몬 자식으로 실행). 없어도 전송은 됩니다.

6. 메뉴바 패널 빌드(`swift`가 있으면 install.sh가 함):

   ```sh
   bash scripts/build-panel.sh
   ```

   번들은 `panel/.build/OpenInstinctPanel.app`입니다. 같은 개인 소켓을 보고 Pause/Resume을 제공하며, UI 자동화는 인수에 사용하지 않습니다. iMessage가 분리되어도 **Chat…**에서 코어 채팅을 사용할 수 있습니다.

**삭제:** 메뉴바 패널에서 **Settings… → Uninstall Gajae…**를 선택하세요. 개발자
환경에서는 다음 명령으로 런치 에이전트, 설치 실행 파일, 런타임 복사본을 제거할 수
있습니다:

```sh
bash scripts/uninstall.sh
```

`~/.openinstinct/state.db`, 로그, 메모리, 설정은 지우지 않습니다. 지우기 전에 의도적으로 백업하세요.

## 설정 제한값

코어 레인에는 필수 설정 키가 없습니다. `allowlistHandle`은 선택적이며 iMessage 레인만 켭니다. 아래 제한값은 코어 레인 시작 때 읽고, 생략한 값은 제품 기본값을 씁니다. `config.json`이 없으면 모든 기본값을 적용하고 `config_missing_defaults_applied`를 로그로 남깁니다. 파일이나 범위의 형식이 잘못되면 해당 범위가 기본값으로 돌아가고 `config_invalid_defaults_applied`를 남기며, 자격 증명이 준비된 경우 Chat은 시작합니다.

```json
{
  "allowlistHandle": "+821012345678",
  "delivery": {
    "maxAttempts": 3,
    "retryBackoffMs": [5000, 25000, 125000],
    "timeoutMs": 90000
  },
  "children": {
    "maxConcurrent": 4,
    "conversationalTimeoutMs": 1800000,
    "daemonTimeoutMs": 1800000,
    "warmTtlMs": 600000,
    "idleTimeoutMs": 86400000,
    "maxLive": 16,
    "interimBatchMs": 3000,
    "interimRatePerMinute": 6,
    "interimMaxBytes": 1024,
    "statusListLimit": 20,
    "statusTextMaxBytes": 512,
    "toolLatencyGuardMs": 50
  },
  "mainTurnWatchdogMs": 300000
}
```

`retryBackoffMs`는 밀리초 재시도 사다리이고 `maxAttempts`는 첫 시도도 포함한다.
live child 캡은 대화형과 모니터 자식을 모두 세며 모니터 우선순위는 유지한다.
`maxLive`는 `maxConcurrent` 이상이어야 한다. 모든 명시 캡과 타임아웃은
양의 안전 정수여야 한다.

| 패널 설정 | 원시 `children.*` 키 | 기본값 | 유효 범위 |
|---|---|---:|---|
| 끝난 작업을 warm으로 유지 | `warmTtlMs` | 600초 | 60초–24시간 |
| idle 작업 잊기 | `idleTimeoutMs` | 24시간 | 300초–24시간 |
| live 백그라운드 작업 | `maxLive` | 16 | 1–64, `maxConcurrent` 이상 |
| 작업 업데이트 묶기 | `interimBatchMs` | 3초 | 1–60초 |
| 작업당 분당 업데이트 | `interimRatePerMinute` | 6 | 1–60 |
| 진행 업데이트 크기 | `interimMaxBytes` | 1024B | 128–8192B |
| 백그라운드 작업 상태 목록 제한 | `statusListLimit` | 20 | 1–100 |
| 백그라운드 작업 상태 텍스트 | `statusTextMaxBytes` | 512B | 128–8192B |
| 백그라운드 작업 도구 latency alert threshold | `toolLatencyGuardMs` | 50ms | 5–1000ms |

모든 `children.*` 제한값은 재시작 범위다. 패널은 `*Ms` 키에 밀리초를 써서 저장한 뒤
가재를 재시작하며, 직접 config를 고친 경우에도 데몬을 재시작해야 한다.

## 가재 전용 Chrome 프로파일

브라우저 툴은 소유자의 개인 Chrome을 절대 건드리지 않음. 모든 브라우저 호출은 `app.browser = "chrome"`, `user_data_dir = ~/.openinstinct/chrome-profile`에 고정됨(런타임 프롬프트 + 익스텐션 강제): CDP 포트로 뜨는 전용 영구 프로파일(Chrome 136+는 비기본 데이터 디렉토리에서만 허용). 패널의 "Open Gajae's browser"(소켓 `browser.open`)로 그 프로파일을 눈에 보이게 열고, 가재가 쓸 사이트에 로그인하고 창을 닫음 — 로그인이 유지되고 내 세션과 격리되어 토큰 회전 사이트(카카오, 은행)가 나를 로그아웃시키지 않음. 프롬프트는 순차 작업에 탭 하나("main")를 재사용하도록 고정.

## Presence (입력 중, 읽음)

`~/.openinstinct/bin/oi-presence`(Swift, beeper/platform-imessage MIT 기법 차용)가 실행 중인 Messages.app을 손쉬운 사용으로 조작: `typing <handle> on|off`는 작성창 초안을, `read <handle>`은 스레드를 열고 안 읽었으면 ⌘⇧U. Messages를 ~300ms 전면에 띄워야 해서 포커스를 뺏으므로, 키보드/마우스를 `presence.idleSec`(기본 8초) 동안 안 건드렸을 때만 — 즉 Mac이 아니라 폰을 볼 때만 — 돌아감. `config.json`에 `"presence": {"enabled": false}`로 완전히 끌 수 있음. `openinstinctd`가 손쉬운 사용에 있어야 하며, 없거나 바이너리가 없으면 조용히 no-op이고 전송엔 영향 없음. 스레드 답장은 일부러 구현하지 않음 — 그 경로가 깨지기 쉬운 곳.

## 페르소나 (가재 소울)

`daemon/src/persona/GAJAE_SOUL.md`가 모든 메인/자식 세션의 gjc 시스템 프롬프트 뒤에 붙음. 세션 생성 시 디스크에서 읽으므로, 편집하고(`soul-version` 주석 올리기) 패널의 "Refresh personality" 또는 소켓 `session.reload`를 보내면 재시작 없이 같은 트랜스크립트 위에 세션이 재구성됨. 응답에 현재 `soulVersion`이 담김.

## gjc를 처음 쓰는 사람의 첫 실행

릴리스 아카이브는 gjc 사전 설정이 필요 없음(벤더링된 SDK 버전에 고정된 `gjc` 바이너리를 함께 담고 있음). 설치 후 패널 Settings → AI account 탭이 `gjc auth-broker login <provider>`(Claude/ChatGPT 등 OAuth, 브라우저 콜백이 Mac에 못 닿을 때 코드 붙여넣기 폴백)를 돌리거나 API 키를 `~/.openinstinct/env`에 저장. 첫 성공 로그인이 그 프로바이더의 공개 기본 모델을 고르고, 모델 선택기는 `gjc --list-models`가 닿는 전부를 나열. 계정이 될 때까지 데몬은 "Gajae has no AI account yet"을 보고하고 패널이 Settings를 권함.

## 체크인 (heartbeat)

첫 부팅에 `heartbeat` cron 모니터를 시드(기본 10분, `config.json`의 `heartbeatMinutes`로 조정, `0`이면 시드 안 함). 자식이 지난 체크인 이후 새로 생긴 것만 — 오늘 노트의 시간 있는 할 일, `tasks/` 마감, 마지막 실행이 실패한 모니터, 가재 Chrome에 로그인된 서비스의 안 읽은 메시지 — 살펴보고, 알릴 게 있을 때만 한두 문장을 보냄. 없으면 조용함(`[[no-owner-message]]`). 패널에서 끄거나 지울 수 있고, 지우면 다시 시드하지 않음. 간격을 바꾸면 다음 부팅에 반영.

이것은 주기적인 사전 알림 모니터이며 턴마다 보내는 입력 중 표시 heartbeat가 아닙니다. 입력 중 표시는 턴 단위 presence이며 정기 상태 메시지를 보내지 않습니다.

## 일일 제안

첫 부팅에 데몬이 `computer-usage-insight` cron 모니터(매일 09:00 로컬)를 시드. 자식이 지난 일주일의 셸 히스토리, git 활동, Downloads/Desktop 변화, 캘린더, 최근 앱을 살펴보고 구체적 자동화 제안을 최대 3개 먼저 문자로 보냄; 아무것도 수정하지 않음. 원치 않으면 패널이나 `monitors.toggle`로 끔. 첫 실행은 부팅 캐치업으로 온보딩 당일에.

## 모니터 결과와 삭제

모니터 발화는 소유자에게 직접 문자하지 않음. 자식의 터미널 리포트가 영구 메인 세션에 진단 턴으로 넘어감: 실패하면 가재가 진단하고, `monitor_author`로 직접 고치거나 끄고, 바꾼 내용을 메모리에 남긴 뒤 소유자에게 플레인 한 줄 — 일시적이고 스스로 해결된 잡음이면 침묵. 원시 에러 코드와 페이로드는 소유자에게 절대 가지 않음.
백그라운드 구성 요소는 공유 내부 Chat/MainSession에 내부 이벤트와 triage 리포트만
제출합니다. 이 경로만 소유자에게 보이는 작성자·통신 권한자이며 background worker는
iMessage를 직접 보내지 않습니다.

`monitors.run`은 예약된 일정과 무관하게 즉시 한 번 실행하는 수동 요청입니다. 비활성·보호 모니터도 같은 전파 경로로 처리하며, 고유 occurrence key를 사용해 예약 실행 deduplication에 삼켜지지 않습니다. 모니터 일정이나 enabled 상태는 바꾸지 않습니다.

꺼진 모니터는 패널(휴지통) 또는 채팅("그 모니터 지워줘")으로 삭제. 삭제는 리비전 펜싱되며 자식이 실행 중이면 거부(`monitor_busy`); 먼저 끄고 잠시 후 재시도. 내장 메모리 모니터(`memory-canonicalize`, `memory-audit`)는 끄거나 지울 수 없음. 선택적 `expiresAt`이 있으면 만료 시 스케줄러가 건너뛰고 durably 끔(`cron_expired`).

## 일시정지와 재개

메뉴바 패널의 **Pause** / **Resume**. 일시정지는 `state.db`에 durable: 소유자 메시지는 턴 없이 커서만 전진하고, 모니터 전파는 재개까지 작업을 보관. 재개하면 모니터 런타임 새로고침과 drain이 재시작. 패널 상태 뷰에서 `session.paused`로 확인.

제어 verb는 `daemon.pause` / `daemon.resume`. `daemon.paused` 메타 키를 직접 편집하지 말 것.

## 부트스트랩 상태와 조치

자격 증명 프로브가 `passed` 또는 `unknown`이면 코어가 시작하며, iMessage 번호는 필요하지 않습니다. 설정이 없거나 형식이 잘못되어도 제품 기본값으로 처리하므로 Chat을 막지 않습니다.

| `bootstrap.state` | 흔한 원인 | 조치 |
| --- | --- | --- |
| `starting` | 시작 프로브 진행 중. | 다음 상태 갱신을 기다림; 계속 머물면 `daemon.ndjson` 확인. |
| `credentials_blocked` | AI 계정 또는 관리되는 API 키가 없음. | **Settings → AI account**에서 로그인하거나 키를 추가; 다음 자격 증명 갱신 뒤 코어가 시작됨. |
| `running` | 코어 레인을 시작할 수 있음. 선택적 iMessage 레인은 별도로 붙거나 분리됨. | 폰 전송은 아래 iMessage 진단표를 사용; 세션이 일시정지되지 않았다면 Chat은 준비됨. |
| `degraded` | 프로브나 코어 레인 시작이 예외를 던짐. | `status.get.bootstrap.remediation`과 대응하는 `daemon.ndjson` 이벤트를 읽고 원인을 고친 뒤 다음 5초 재시도를 기다림. |

### iMessage 레인 진단

`status.get`에는 `imessage.state`가 있고, 분리된 경우 `imessage.reason`, `detail`, 설정된 `handle`이 있습니다. reason을 키로 다음 표를 사용합니다.

| `status.get.imessage.reason` | 의미 | 운영자 조치 |
| --- | --- | --- |
| `no_owner_handle` | 전화번호/이메일 handle이 없어서 Chat 전용 모드. | Chat에는 조치가 필요 없음. 폰 문자를 추가하려면 **Settings → iMessage**에서 handle을 입력하고 **Connect**를 누름. |
| `fda_denied` | 데몬이 전체 디스크 접근 권한으로 `chat.db`를 읽지 못함. | **개인정보 보호 및 보안 → 전체 디스크 접근 권한**에서 `~/.openinstinct/bin/openinstinctd`를 허용. 5초 재프로브를 기다리며 재시작은 필요 없음. |
| `fda_probe_error` | FDA 프로브가 단순 거부가 아닌 오류를 반환함. | `probes.fda.reason`과 `daemon.ndjson`을 읽고 설치된 데몬 경로와 `~/Library/Messages/chat.db` 읽기 가능 여부를 확인한 뒤 다음 프로브를 기다림. |
| `attach_failed` | 레인 사전 점검 또는 구성에 실패함. | `imessage_lane_attach_failed`의 `message`를 확인하고 보고된 Messages/Automation 또는 경로 문제를 고친 뒤 다음 재시도를 기다림. |
| `core_lane_down` | 공유 세션이 실행 중이어서 iMessage를 붙일 수 없음. | `bootstrap.state`와 remediation을 확인. `credentials_blocked`면 AI 자격 증명을 복구하고, `degraded`면 `core_lane_start_failed`를 확인; 컨트롤러가 자동 재시도함. |
| `starting` | 데몬이 레인을 수렴하는 중. | 다음 상태 갱신을 기다림. 계속되면 `daemon.ndjson`의 부팅/프로브 이벤트를 확인. |
| `handle_changed` | 설정된 번호를 교체하는 중. | 수렴을 기다리고 Settings에서 새 번호를 확인. 교체 전에 이전 번호의 대기 행은 만료됨. |
| `shutdown` | 데몬이 종료 중. | launchd가 마무리하도록 둠. 정상 launchd/설치 경로로 데몬을 시작하고 레인을 직접 붙이지 말 것. |

분리된 턴이나 사전 알림이 버려진 증거는 주 로그에서 `delivery_skipped_no_imessage_lane`를 검색합니다. 이 행에는 reason과 턴 binding이 들어 있습니다. 번호 폐기는 `deliveries_expired_for_handle`로 기록됩니다.

### 재시작과 종료

정지, 시그널, `daemon.restart`는 이제 하나의 동일한 fenced 종료 경로로 들어갑니다. 레인 작업 중지, iMessage 분리, 코어 중지, 제어 소켓과 스토어 종료, 프로세스 종료 순서입니다. 워처·전송 서비스·패널만 따로 죽여 재시작하지 말 것. 순서는 라이프사이클 컨트롤러가 소유합니다.

## 롤백

이 기능이 출시된 뒤에는 데몬과 패널을 **같은 릴리스 아카이브에서 함께** 롤백해야 합니다. `BootstrapState`와 `status.get` 변경은 한 계약으로 묶여 있어서 데몬/패널 버전이 다르면 Swift 디코딩이 큰 소리로 실패하고 패널에 데몬이 오프라인으로 표시됩니다.

Chat 전용 설치에는 `allowlistHandle`이 없습니다. 이를 이전 기능 데몬으로 롤백하면 그 데몬은 예전처럼 필수 handle을 요구하므로 이전 구성 차단 상태에 머뭅니다. `~/.openinstinct/config.json`에 유효한 handle을 쓴 뒤 launchd를 통해 재시작하는 것이 해결책이며, 그러면 이전 데몬이 요구하는 구성을 복구합니다.

## 보존과 로그 로테이션

`running` 동안 데몬은 24시간마다 보존 작업을 실행. 7일 지난 정산된 전송 원장 행, 터미널 모니터 이벤트, 전달된 자식 영수증을 삭제. `daemon.ndjson`은 32 MiB 초과 시에만 로테이션하며 `.1`~`.5` 보존.

`maintenance.run`이 수동 제어 verb. `ran`, 세 가지 prune 카운트, `logRotated`를 반환. 데몬이 안 돌면 `ran: false`이고 아무것도 바꾸지 않음. 상태 행을 수동 삭제하거나 활성 NDJSON 파일을 직접 로테이션하지 말 것.

## 장애 드릴

레포 루트에서 격리된 복구 드릴:

```sh
bash scripts/drills/failure-drills.sh
```

임시 `HOME`, `OI_DRILL_MODE=1`, 결정적 가짜 어댑터, `OI_DRILL_HOLD` 심 마커를 쓰며 실제 `bun daemon/src/main.ts` 프로세스를 죽였다 살려 일곱 재시작 케이스를 검증: 턴 중, 자식 중, 저널 후/영수증 전, 클로저 중, 전파 중, 중간 배치 중, 일시정지 상태 재시작. 이후 재시작하지 않는 live-only `child-tools-while-held` 케이스를 실행한다. 마지막 케이스는 자식 턴을 붙잡은 채 메인 세션의 상태 조회·넛지·release를 호출하고 SDK 경계 latency telemetry를 확인한다. 이 환경 훅은 `OI_DRILL_*` 없이는 비활성이며 런치 에이전트 plist에 절대 넣지 말 것.

## Soak 절차

프로덕션 데몬을 띄운 뒤:

```sh
bun scripts/soak/soak-monitor.ts --hours 24
```

`lsof`가 소켓 소유자를 특정 못 하면 `--pid <daemon-pid>`. 짧은 로컬 스모크는 `--minutes 2`. 60초마다 `~/.openinstinct/logs/soak.ndjson`에 샘플 추가. 최종 게이트: RSS 1.5 GiB 미만, RSS 증가 50 MiB/시간 미만, FD 델타 10 이하, `status.get` p99 250ms 미만, 터미널 자식 완료율 99% 이상. 마지막 줄은 `METRIC soak_verdict=pass|fail`.

### Soak 실패 후 어댑터 교체 의무

게이트 실패는 재시작·재샘플링으로 면제되지 않음. 새 소유자/모니터 작업을 멈추고, 실패한 NDJSON/soak 증거와 선택된 PID를 보존하고, 해당 통합을 정상 배포 변경 절차로 알려진 정상 대체 어댑터로 바꾸고, 재시작해서 깨끗한 기준선에서 새 24시간 soak를 돌림. 이전 어댑터, 대체, 실패 게이트, 새 soak 지표를 인시던트 기록에 남김. 통과 판정 후에만 작업 재개. 제어 소켓에 어댑터 교체 verb는 없으며, 문서화되지 않은 state-db 편집은 어댑터 교체가 아님.

## 라이브 인수 절차

TCC를 부여하고 두 번째 iMessage 번호를 준비한 뒤:

```sh
OI_ACCEPTANCE_SECOND_HANDLE='+821000000002' \
OI_ACCEPTANCE_SEND=1 \
bun scripts/acceptance/run-acceptance.ts
```

하네스는 `AC-1`~`AC-10`, 증거 줄, `METRIC acceptance_pass=<n>/10`을 출력. 전제가 없으면 절대 통과로 치지 않음. 권한·빌드된 패널·두 번째 기기·명시적 모니터·알려진 자식 id가 필요한 시나리오는 `SKIP(reason)`.

AC-7은 잠시 토글해도 되는 모니터를 `OI_ACCEPTANCE_MONITOR_ID=<id>`로; 하네스가 원상복구. AC-8은 고유 토큰을 `OI_ACCEPTANCE_INBOUND_TOKEN=<token>`으로 두고 하네스가 기다리는 동안 두 번째 기기에서 정확히 그 토큰을 보냄. AC-9는 실제 소유자 채팅에서 백그라운드 작업을 만들게 한 뒤 admit 후 `OI_ACCEPTANCE_CHILD_ID=<child-id>`. `--wait-seconds N`, `--socket PATH`, `--home PATH`, `--panel-app PATH`로 대상 인스턴스를 명시.

## 메모리 격리 복구

격리된 메모리 인텐트는 durable 포렌식 증거로 보존; 감사를 깨끗해 보이게 하려고 상태 행, 캡처 파일, 영수증, Git 히스토리를 지우지 말 것. 데몬을 일시정지하고 `state.db`, `memory-receipts.jsonl`, 메모리 Git 히스토리를 보존한 뒤 `daemon.ndjson`이 가리키는 스토리지/레지스트리/Git 문제를 고침. 재개 후 수정된 새 소유자 캡처나 유지보수 요청을 제출하면 새 멱등 키를 받아 정상 재생됨. 복구 선언 전에 메모리 감사(AC-10)를 다시 실행. 원래 격리 행은 인시던트 검토를 위해 의도적으로 남음.

기존 트랜스크립트의 소유자 교환은 `memory.backfillCaptures`로 캡처 축에 보충할 수 있습니다. 원래 시각을 보존하고 데몬 주입 프롬프트를 건너뛰며 결정적 매칭을 사용하므로 반복 실행해도 중복되지 않습니다.
