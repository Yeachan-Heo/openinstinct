# OpenInstinct 사용자 가이드

AI 계정에 로그인하면 바로 Chat 창에서 가재와 대화할 수 있습니다. iMessage는 선택 사항이며, 나중에 폰으로 문자를 보내고 싶을 때 연결하면 됩니다. 이 문서는 설치하고 쓰는 사람용입니다. 기술적인 내용은 [운영 가이드](runbook.md)에 있습니다.

## 선택 사항: iMessage 준비 (한 번, 5분)

Chat만 쓰는 설치라면 이 절을 건너뛰세요. 폰 문자도 쓰려면 가재는 이 Mac의 Messages 계정이 됩니다. 그 계정이 내 계정이면 가재의 답장이 전부 내 대화창에 뜹니다. 그래서:

1. 에이전트용 Apple ID를 새로 만듭니다 (아무 이메일이나. 인증 코드 받을 전화가 필요하지만 그 번호가 가재의 번호가 되는 건 아님).
2. Mac에서 Messages → 설정 → iMessage → 로그아웃 → 새 Apple ID로 로그인. 내 iPhone은 그대로.
3. iPhone 연락처에 새 Apple ID 이메일을 "가재"로 저장해두면 문자 보내기 편합니다.

패널이 이걸 확인해 줍니다. 현재 Messages에 로그인된 계정을 보여주고, 아직 내
Apple ID라면 바꿀 때까지 실행을 거부합니다.

## 설치

1. 터미널을 열고 아래를 붙여넣은 뒤 엔터를 누릅니다.

   ```sh
   curl -fsSL https://raw.githubusercontent.com/Yeachan-Heo/openinstinct/main/scripts/install-remote.sh | sh
   ```

   (셸로 바로 파이프하기 싫다면 [Releases](https://github.com/Yeachan-Heo/openinstinct/releases/latest)에서 `.tar.gz`를 받아 풀고 `sh <폴더>/scripts/bootstrap-from-payload.sh <폴더>`를 실행하세요.)
2. 파일을 복사하고 메뉴바 패널을 엽니다. AI 계정이 준비되면 Chat을 바로 쓸 수 있습니다. **Settings → AI account**에서 기존 구독으로 로그인하거나 API 키를 넣거나 커스텀 엔드포인트를 설정하세요. 패널의 실시간 설정 UI는 선택적 iMessage 분기를 별도로 보여주며, iMessage 신원·전체 디스크 접근·자동화 화면은 그 분기를 명시적으로 고른 뒤에만 나타납니다.
3. 메뉴바 아이콘에서 **Chat…**을 열어 대화를 시작합니다. 폰 문자를 추가하려면 나중에 **Settings… → iMessage**에서 handle을 입력하고 **Connect**를 누르세요.

패널은 각 단계의 상태를 실시간으로 보여주고, 막힌 단계에서 할 일을 안내합니다.

## iMessage 없이 Chat

Chat 창은 iMessage풍 말풍선과 플레인 텍스트만 쓰는 별도 창입니다:

1. 메뉴바 아이콘 → **Chat…**을 누릅니다.
2. **Settings… → AI account**에서 AI 계정에 로그인하거나 API 키를 넣습니다.
3. 입력하고 보냅니다. Chat에는 전화번호, `chat.db`, 전체 디스크 접근 권한, 자동화, 손쉬운 사용 권한이 필요하지 않습니다.

데몬에 연결할 수 없거나 AI 자격 증명이 없거나 가재가 일시정지된 경우에만 composer가 막힙니다. iMessage 레인이 분리되어도 Chat은 막히지 않습니다. 가재의 답장·세그먼트·이미지가 창에 나타나며, 패널 composer는 텍스트 전용입니다.

## 선택적 iMessage 설정

Chat이 작동한 뒤 폰 문자도 추가하려면:

1. **Settings… → iMessage**를 열고 국가번호를 포함한 전화번호(또는 이메일 handle)를 입력합니다.
2. **Connect**를 누릅니다. 데몬이 `chat.db`의 전체 디스크 접근 권한을 확인하고 가능하면 iMessage 레인을 붙입니다. Messages를 제어해 보내려면 자동화를 허용하고, 입력 중/읽음 표시가 필요하면 손쉬운 사용 권한도 허용합니다.
3. 그 탭에서 iMessage 상태를 봅니다. 연결/분리는 가재를 재시작하지 않으며, 레인이 분리된 동안에도 Chat은 계속 쓸 수 있습니다.
4. 폰 문자를 멈추려면 **Disconnect**를 누릅니다. 번호를 바꾸면 새 레인을 붙이기 전에 이전 번호의 대기 중 전송이 만료됩니다.

## 쓰기

Chat 창에 입력하거나, 선택적 iMessage 레인이 연결된 뒤 폰에서 가재에게 문자를 보내면 됩니다. 잘하는 것들:

- "내일 일정 뭐 있어" / "이 링크 요약해줘" / "이 사진 뭐야" (사진 첨부)
- "매일 아침 9시에 오늘 일정 브리핑해줘" — 예약 작업 생성. 메뉴바의 **Run now**/`monitors.run`으로 예약과 무관하게 한 번 실행할 수도 있습니다.
- "이 페이지 가격 바뀌면 알려줘, 이번 주만" — 기한 있는 감시
- "카카오 선물하기에서 아메리카노 한 잔 보내줘" — 전용 Chrome 사용
- "이거 기억해둬: …" — 메모리에 저장, 나중에 검색. 기존 트랜스크립트는 `memory.backfillCaptures`로 원래 시각에 맞춰 중복 없이 보충할 수 있습니다.
- "그 모니터 꺼" / "지워" — 예약 작업 끄기/삭제

오래 걸리는 일은 "하는 중" 먼저, 결과는 나중에. 마크다운을 쓰지 않고, 내 문자를 인용하지 않고, 내가 쓰는 언어로 답합니다.

### 관리형 액션과 정확한 승인

로컬이나 원격 상태를 바꿀 수 있는 일은 모델의 판단을 권한으로 삼지 않고 내구성 있는 관리형 액션으로 처리합니다. 현재 경로는 다음을 다룹니다.

- 절대 경로의 일반 파일 쓰기 또는 명시적 파일 삭제
- 절대 작업 폴더에 정확한 버전의 Bun 패키지 하나 설치(기본적으로 lifecycle script 비활성)
- 호스트 정책이 허용한 HTTP GET과, 별도 GET 검증이 붙은 정확한 POST/PUT/PATCH/DELETE
- 정확한 툴 입력에 묶인 raw shell, 변경형 browser, 알 수 없는 툴 부작용

모니터와 백그라운드 점검은 system/third-party 근거를 내구성 있는 관찰로 남길 수 있습니다. 명확하고 관련 있는 미완료 작업만 읽기 전용 감시가 될 수 있고, 불확실한 근거는 검토용 제안으로 남습니다. 관찰, 웹페이지, 메시지, 툴 결과는 변경 승인으로 취급되지 않습니다.

실행 전 OpenInstinct는 액션 ID, 리비전, digest를 기록합니다. 파일·설치·HTTP 경로는 호스트 상태나 endpoint 정책을 다시 확인합니다. 일반 로컬 편집과 확인된 관리형 툴 설치는 로컬 정책으로 실행할 수 있지만, 기존 파일/사용자 자산 변경, 코어·계정 변경, 설치 script, HTTP 변경, raw 부작용에는 정확한 소유자 권한이 필요합니다. 이 gate는 실제 메인/백그라운드 SDK 툴 호출에 연결되어 있지만 OS sandbox는 아닙니다.

가재가 명시적 승인을 요구하면 알려준 액션 identity를 그대로 복사해 Chat 또는 설정된 소유자 iMessage 계정에서 첨부 없이 한 줄로 보냅니다.

```text
/approve ACTION_ID REVISION DIGEST
```

거절하려면:

```text
/reject ACTION_ID REVISION DIGEST
```

`REVISION`은 양의 정수, `DIGEST`는 소문자 16진수 64자입니다. OpenInstinct는 관리형 local-file 액션을 식별하고 install/HTTP/raw-tool payload 구조를 검증합니다. 낡거나 형식이 다른 identity는 거부합니다. `/reject`는 해당 리비전을 실행하지 않고 취소합니다. `/approve`는 정확한 승인 하나를 기록하고, 가재는 같은 identity로 알맞은 관리형 executor를 실행하거나 동일한 raw 툴 입력을 한 번만 다시 시도합니다. executor가 검증하기 전에는 성공으로 말하지 않습니다. raw 툴 결과는 독립 검증이 없으므로 가짜 성공 대신 `ambiguous`로 기록하고 맹목적으로 재시도하지 않습니다.

### 정확한 발신 규칙과 후속 실행

관리형 HTTP로 외부 메시지를 보낼 때는 액션별 `/approve`를 쓸 수 있습니다. 특정 recipient/topic/action 조합을 앞으로도 허용하려면:

```text
/allow-send {"recipient":"…","topic":"…","action":"…"}
```

첨부 없이 한 줄의 독립된 텍스트로 보내야 하며 wildcard나 추가 필드는 허용되지 않습니다. 가재가 돌려준 rule ID와 revision으로 이후 사용을 취소합니다.

```text
/revoke-send RULE_ID REVISION
```

이 규칙은 다른 수신자, 주제, 액션, 계정이나 메시지가 아닌 변경을 승인하지 않습니다.

이미 기록되고 확인된 액션에 제한된 후속 정책을 붙일 수도 있습니다.

```text
/followup {"workId":"…","actionId":"…","enabled":true,"intervalMs":60000,"maxAttempts":1}
```
`/followup` JSON도 첨부 없이 한 줄의 독립된 텍스트로 보냅니다.

다섯 필드는 모두 필요합니다. 이 명령은 정책만 저장하고 즉시 실행하지 않으며 원본 액션이 `confirmed`가 된 뒤에만 예약된 실행이 진행됩니다. 반복마다 새 액션 식별자를 만들고 원본 리비전, 현재 권한, 기한, 횟수 상한을 다시 확인한 뒤 실제 관리형 executor를 사용합니다. 현재 권한이 없는 민감한 파생 액션은 자신의 식별자에 대한 새 `/approve`를 기다리며 원본 승인을 재사용하지 않습니다. 정책이나 액션이 바뀌거나 결과가 거절 또는 `ambiguous`면 이후 반복을 멈춥니다. 끄려면 같은 형식에서 `enabled`를 `false`로 설정합니다. 재시작 때 local-file/install/HTTP의 실행 전 단계는 실제 executor로 재개할 수 있지만 이미 실행이 시작된 중단 작업은 `ambiguous`로 조정하고 처음부터 다시 실행하지 않습니다. 명령이나 큐 등록 자체가 아니라 검증된 executor 결과를 완료 신호로 보세요.

### 관리형 HTTP 호스트 설정

관리형 HTTP의 endpoint와 자격 증명 권한은 프롬프트나 웹페이지가 아니라 데몬 호스트 설정에서 옵니다. `OI_HTTP_LOCAL_ORIGINS`는 private/local 주소를 허용할 정확한 `scheme://host[:port]` origin의 JSON 배열입니다. `OI_HTTP_SECRET_BINDINGS`는 툴에 보이는 reference를 정확한 `origin`, `header`, 환경 변수 이름에 연결합니다(예: `{"mailApi":{"origin":"https://api.example","header":"Authorization","environment":"MAIL_API_TOKEN"}}`). 모델은 평문 토큰 대신 `mailApi` 같은 `secretRef`만 전달하며, binding은 origin과 header가 모두 일치할 때만 사용됩니다. 민감한 header, URL query, body에 평문 자격 증명을 넣을 수 없고 공용 평문 HTTP로 secret reference를 보낼 수도 없습니다. redirect는 따라가지 않으며 별도 GET이 기대 상태를 입증해야 변경을 성공으로 기록합니다.
이 호스트 변수는 `~/.openinstinct/env`에 `KEY=value` 줄로 넣고 파일 mode를 0600으로 유지합니다. 대화 중 가재가 새로 만들 수 있는 권한이 아니라 운영자 설정입니다.

### 나를 따라오는 알림

일부 사전 결과는 Chat 트랜스크립트 위 **알림** 영역에 나타납니다. OpenInstinct는 알림을 내구성 있게 보관하고 최근 활동을 기준으로 활성 Chat을 먼저, 아니면 연결된 iMessage를 선택합니다. 둘 다 없으면 전달됐다고 꾸미지 않고 기다립니다.

알림을 보는 것과 확인하는 것은 다릅니다. Chat 경로 알림이 보이면 패널이 렌더링을 기록합니다. iMessage로 먼저 간 알림도 Chat dispatch 행 없이 공유 Chat 히스토리에 표시하고 렌더링할 수 있습니다. 처리한 뒤 **확인**을 누르면 acknowledgement가 기록되어 추가 라우팅을 멈춥니다. Chat에 렌더링됐지만 확인하지 않은 채 Chat이 비활성화되면 iMessage로 fallback할 수 있습니다. iMessage 큐에 넣은 것만으로 전달 완료가 아니며 Messages 원장이 확인해야 합니다. 불확실한 결과는 맹목적으로 다시 보내지 않고 reconcile합니다.

### 입력 중 표시와 읽음 표시 (선택)

입력 중 표시와 읽음 표시는 선택 기능입니다. 사용하려면 시스템 설정 → 개인정보
보호 및 보안 → 손쉬운 사용에서 `~/.openinstinct/bin/openinstinctd`에 **손쉬운
사용** 권한을 주세요. 문자를 보내는 데는 이 권한이 필요하지 않습니다.

### 비밀번호 주기

줘도 됩니다. 로그인 정보를 문자로 보내면 `~/.openinstinct/secrets/`에 (소유자만 읽는 권한으로) 저장하고 다음엔 안 물어보고 씁니다. 비밀번호를 되풀이해 말하지 않습니다. 일회용 코드는 한 번 쓰고 버립니다.

## 메뉴바

아이콘 클릭:

- **상태 줄** — "Awake and listening", "Paused", "Needs setup", "Something's off", "Not running".
- **Chat…** — 항상 쓸 수 있는 Chat 창 열기.

- **Working on** — 진행 중인 백그라운드 작업.
- **Scheduled tasks** — 모든 모니터와 다음/마지막 실행 시각(내 시간대). 토글로 끄고, 꺼진 건 휴지통으로 삭제. 자물쇠 두 개는 내장 메모리 관리라 지울 수 없습니다. 기한 있는 건 "until …", 끝나면 "Ended …".
- **Quick actions…** — 일시정지/재개, 가재 브라우저 열기, 성격 새로고침.
- **Settings…** — 선택적 iMessage 연결을 포함한 설정 창(아래).
- **버전 줄** — 맨 아래에 설치된 릴리즈 버전. 패널이 하루 한 번 GitHub를 확인하고, 새 릴리즈가 있으면 이 줄이 **Update to vX.Y.Z** 버튼으로 바뀝니다. 누르면 설치 스크립트가 백그라운드에서 다시 돌고, 메뉴바 아이콘이 1분쯤 사라졌다가 새 버전으로 돌아옵니다. 대화, 메모리, 권한, 설정은 그대로입니다. **Check for updates**는 지금 바로 확인. 소스 체크아웃으로 설치했다면 버전 줄이 없고, `git pull && bash scripts/install.sh`로 갱신합니다.

뭔가 내가 해야 할 일이 생기면(AI 계정 없음, 연결된 iMessage 레인의 권한 문제) 팝업이 한 번 뜨고 해결될 때까지 아이콘에 주황 점이 붙습니다. 분리된 선택적 레인은 Chat 오류가 아닙니다.

## 설정 창

- **AI account** — 구독 계정으로 로그인(드롭다운, 많이 쓰는 것부터), API 키 붙여넣기, 또는 커스텀 엔드포인트(Base URL + 키 + 모델) 연결. 가재가 쓸 모델을 선택하고, 기존 Claude·ChatGPT/Codex CLI 자격 증명을 **Discover**한 뒤 소유자가 **Adopt**를 눌러 명시적으로 채택할 수도 있습니다. 기존 구독으로 과금이 시작될 수 있으므로 자동 채택하지 않습니다.
- **You** — 내 이름.
- **iMessage** — 전화번호를 선택적으로 연결/분리하고 레인·권한 상태를 봅니다. 연결하지 않아도 Chat은 계속 씁니다.
- **Browser** — "Open Gajae's browser": 가재 전용 프로파일로 Chrome 창이 뜹니다. Gmail, 카카오, 은행 등 가재가 쓸 사이트에 로그인하고 창을 닫으면 됩니다. 내 Chrome은 건드리지 않고, 그 사이트에서 *내가* 로그아웃되지도 않습니다.
- **Limits** — 답장이 조용할 때 몇 분 기다릴지, 백그라운드 작업 동시 개수, 완료 작업 웜 유지 시간, idle 작업 만료 시점, 진행 묶음 주기와 작업별 업데이트 속도.
- **Personality** — 가재를 가재답게 만드는 텍스트. 수정하고 적용하면 대화는 이어진 채로 성격만 바뀝니다.

## 일시정지

Quick actions → **Pause**. 정지 중에 보낸 문자는 보관되고 답장은 안 옵니다. 재개하면 가재가 몇 개 놓쳤는지 알려줍니다.

## 안 될 때

| 보이는 것 | 할 것 |
|---|---|
| "Needs a permission" | iMessage가 연결된 경우 **Settings → iMessage**의 권한 안내를 따릅니다. Chat 자체에는 그 권한이 필요하지 않습니다. |
| "Messages is signed in as you" | Messages에서 로그아웃하고 가재 전용 Apple ID로 로그인하세요. |
| "Gajae has no AI account yet" | Settings → AI account. |
| "iMessage is detached" | **Settings → iMessage**에서 reason을 확인합니다. 고치는 동안에도 Chat을 계속 쓰거나 연결하지 않은 채로 둘 수 있습니다. |
| 작업 중에 답이 끊김 | 할 일 없음. 긴 작업은 5분 무응답 제한이 있고, 포기하면 알려줌. |
| 사진이 캡션만 옴 | Messages가 열려 있어야 하고(숨김은 되지만 종료는 안 됨) `openinstinctd`가 Automation에서 Messages를 제어하도록 허용해야 합니다. |
| "Not running" | 몇 초 기다렸다가, 계속 그러면 설치 다시. |
| "The last update did not finish" | 버전 줄 아래에 로그 끝부분이 보입니다. 원인(대개 네트워크)을 고치고 다시 **Update**, 또는 터미널에서 `sh ~/.openinstinct/src/scripts/update.sh`를 실행하고 `~/.openinstinct/logs/update.log`를 확인하세요. |
| 그 외 | Quick actions → Show log files에서 `daemon.ndjson`을 보내주세요. |

## 삭제

메뉴바 패널에서 **Settings… → Uninstall Gajae…**를 선택하세요. 패널을 열 수
없으면 다음 명령을 대안으로 사용하세요.

`bash ~/.openinstinct/src/scripts/uninstall.sh` (또는 `~/.openinstinct`, `~/Applications/OpenInstinctPanel.app`, `~/Library/LaunchAgents`의 `co.openinstinct.*` 두 파일 삭제). 원하면 권한 목록에서 `openinstinctd`를 제거하세요. 메모리는 `~/.openinstinct/memory`에 있으니 남기고 싶으면 먼저 복사하세요.
