# Implementation Runtime v1 設計

> **Status: design under review / not implemented**
>
> 本書は、Human が承認した Plan を実装する将来設計である。現在の supported
> runtime は Planning MVP のままであり、approved Plan の後に Implementation は
> 開始しない。本変更では設計ドキュメントだけを更新する。

## 1. 決定サマリー

Planning と Implementation は同じ native Mission を継続して使う。v1 の実行単位は
WorkUnit ではなく、一つの attached foreground workflow とする。

```text
/wf-*
  → Mission
  → Discovery
  → optional Research / clarification
  → Planning
  → Human Plan Review
  → approved planReview.decisionSnapshot
  → Implementation named resource
  → one package-Agent worker run
  → worker が WorkUnit[0..n] を array order のまま実装
  → one ImplementationResultV1
  → package-owned Git inspection
  → Implementation success / blocked / failed
```

v1 の実行モデルは次のとおり。

- trusted local operator
- trusted `pi-workflow` / `pi-subagents` runtime
- one interactive owner session
- one Implementation dispatch per Mission
- one package-owned named resource `pi-workflow.implementation`
- one package Agent file `agents/implementation-worker.md`（resolved name: `pi-workflow.implementation-worker`）
- one worker run
- one active writer
- one shared checkout
- `planReview.decisionSnapshot.implementation.workUnits` を array order のまま処理
- `mode = "single"` のみをサポートし、`lanes` は fail closed
- WorkUnit ごとの child run、progress state、run-key mapping は作らない

`PlanningDecisionV1` は WorkUnit 構造を保持する。将来の parallel execution では分割単位に
できる。v1 は failure collection のため config-object の one-element `runs.all` を一度だけ使うが、
parallel execution、`runs.lanes`、managed worktree は使わない。`runs.all` の item count は常に
1、dynamic fanout はなく、worker と active writer はそれぞれ一つだけである。

### 1.1 v1 の support / trust boundary

v1 が supported execution model として前提にする条件は次のとおりである。

- local operator は trusted である。
- `pi-workflow` と `pi-subagents` の runtime は trusted である。
- 一つの interactive owner session が Mission の control authority を持つ。
- 一つの Mission に対して Implementation dispatch は一回だけ行う。
- Implementation 実行中に、別の Pi、session、editor、automation、process が同じ
  checkout へ書き込まない。
- 実行場所は managed isolation のない shared checkout である。
- Mission state と package-generated Artifact に対する adversarial mutation は v1 の
  security model に含めない。

v1 は次を保証しない。

- cross-process mutual exclusion
- concurrent writer safety
- OS/filesystem sandbox
- malicious extension protection
- malicious local Artifact/state tampering protection

したがって clean-tree check、`writeScope`、child tool allowlist、package-owned Git
inspection を hard security boundary、完全な provenance、排他 lock、OS sandbox と表現しない。
これらは trusted-local runtime の execution gate / conformance check である。

hard isolation が必要な環境では v1 を起動しない。その場合だけ future managed-worktree design で worktree ownership、checkout isolation、
必要な lock を検討する。v1 に lock
manager、sandbox、worktree manager を追加しない。

### 1.2 v1 に含めないもの

- formal Verification、Verification Fix
- test、typecheck、lint、build、package check の worker 実行
- automated Review、Human Code Review
- parallel implementation、`runs.lanes`
- managed worktree、checkout lock manager
- Implementation 実行中の automatic retry、automatic resume、re-dispatch、recovery engine
- running / blocked / failed Implementation の automatic retry / resume
- WorkflowSnapshot、monitoring API、Web UI
- minimal TUI、TUI phase event、restart/resume reconstruction
- commit、push、tag、PR、stash、reset、revert、deployment、release

`focusedVerificationIds` と `finalVerificationIds` は approved decision に残るが、
v1 は command を実行せず、検証済みとは記録しない。

## 2. Source of Truth と public contract

### 2.1 現在の main

現在の repository と supported Planning MVP は次で確認する。

- [basic design](pi-workflow-basic-design.md)
- [implementation specification](pi-workflow-implementation-spec.md)
- [roadmap](pi-workflow-roadmap.md)
- [`src/commands/workflow.ts`](../src/commands/workflow.ts)
- [`src/runtime/workflow-resources.ts`](../src/runtime/workflow-resources.ts)
- [`workflow-scripts/planning.js`](../workflow-scripts/planning.js)
- [`src/core/planning/planning-decision-schema.ts`](../src/core/planning/planning-decision-schema.ts)
- [`src/core/planning/planning-decision.ts`](../src/core/planning/planning-decision.ts)
- [`src/core/state/contracts.ts`](../src/core/state/contracts.ts)

現在の named resource は Discovery、Research、Planning だけで、Mission state に
Implementation envelope はない。この差分は後述の cutover で解消する。本変更では code、
runtime、Skill、test、README、package manifest を変更しない。

### 2.2 `pi-subagents` 0.67.0

SOT は `pi-subagents` 0.67.0 の public docs/source である。

- [`docs/agents.md`](https://github.com/nicobailon/pi-subagents/blob/v0.67.0/docs/agents.md)
- [`docs/missions.md`](https://github.com/nicobailon/pi-subagents/blob/v0.67.0/docs/missions.md)
- [`docs/workflows.md`](https://github.com/nicobailon/pi-subagents/blob/v0.67.0/docs/workflows.md)
- [`docs/tool-reference.md`](https://github.com/nicobailon/pi-subagents/blob/v0.67.0/docs/tool-reference.md)
- [`docs/configuration.md`](https://github.com/nicobailon/pi-subagents/blob/v0.67.0/docs/configuration.md)
- [`docs/extension-api.md`](https://github.com/nicobailon/pi-subagents/blob/v0.67.0/docs/extension-api.md)
- [`src/api/preflight.ts`](https://github.com/nicobailon/pi-subagents/blob/v0.67.0/src/api/preflight.ts)
- [`src/agents/agents.ts`](https://github.com/nicobailon/pi-subagents/blob/v0.67.0/src/agents/agents.ts)
- [`src/runs/shared/child-tool-plan.ts`](https://github.com/nicobailon/pi-subagents/blob/v0.67.0/src/runs/shared/child-tool-plan.ts)
- [`src/runs/shared/child-launch-plan.ts`](https://github.com/nicobailon/pi-subagents/blob/v0.67.0/src/runs/shared/child-launch-plan.ts)
- [`src/runs/shared/completion-guard.ts`](https://github.com/nicobailon/pi-subagents/blob/v0.67.0/src/runs/shared/completion-guard.ts)
- [`src/runs/shared/structured-output.ts`](https://github.com/nicobailon/pi-subagents/blob/v0.67.0/src/runs/shared/structured-output.ts)
- [`src/shared/launch-contract.ts`](https://github.com/nicobailon/pi-subagents/blob/v0.67.0/src/shared/launch-contract.ts)
- [`src/shared/types.ts`](https://github.com/nicobailon/pi-subagents/blob/v0.67.0/src/shared/types.ts)
- [`src/workflows/scripted-workflow.ts`](https://github.com/nicobailon/pi-subagents/blob/v0.67.0/src/workflows/scripted-workflow.ts)
- [`src/runs/foreground/subagent-executor.ts`](https://github.com/nicobailon/pi-subagents/blob/v0.67.0/src/runs/foreground/subagent-executor.ts)
- [`src/workflows/workflow-preflight.ts`](https://github.com/nicobailon/pi-subagents/blob/v0.67.0/src/workflows/workflow-preflight.ts)
- [`src/workflows/workflow-resources.ts`](https://github.com/nicobailon/pi-subagents/blob/v0.67.0/src/workflows/workflow-resources.ts)

v1 が依存する public behavior は次のとおりである。

| 項目 | v1 で使用する意味 |
| --- | --- |
| named resource | package-owned resolver が bounded args と fixed workflow を返す。caller-owned `workflowScript` は `pi-workflow.implementation` の代替にならない。 |
| one-element failure collection | config-object の `await runs.all([{ key, ...params }])` を使い、順序付き配列の index 0 を取得する。これは parallel worker execution ではなく、child failure を collection path で受け取るための一回の呼び出しである。`runs.lanes` は使わない。 |
| package Agent | `package.json` の既存 `pi.subagents.agents: ["./agents"]` から file-discovered Agent として解決する。runtime Agent registration API は使用しない。 |
| preflight | `pi-subagents/preflight` の `resolveSubagentLaunchContract()` が同じ file-discovered Agent snapshot から child の effective launch contract を解決する。process-local runtime Agent registry はこの public preflight の discovery source ではない。 |
| context | `context: "fresh"` は launch で明示でき、Agent の default を上書きする。 |
| reads | child launch の `reads: false` は明示 override である。Agent definition に `defaultReads` は設定しない。preflight API にこの input はないため実行時に固定する。 |
| tools | strict allowlist は caller-facing tools を制限する。`structured_output` は `outputSchema` により追加される package-owned internal protocol tool である。 |
| file-only | `outputMode: "file-only"` は `output` に一意な explicit path を必要とする。filename を task 文だけに書かない。 |
| structured output | tool invocation は `{ "value": <schema value> }`、run result の `structuredOutput` は wrapper を外した schema value である。 |
| Mission state | `state.set` は state file lock と key merge を行うが、multi-key CAS / transaction ではない。 |
| Mission lifecycle | attached foreground workflow の completion が native Mission を `completed` にすることがある。これは logical phase とは別である。 |
| foreground control | foreground の状態は native result の `interrupted` / `stopped` として扱う。`action: "stop"` を recovery protocol に使わない。 |
| trust | Extension、tool allowlist、clean check、writeScope は OS sandbox や malicious process への排他を提供しない。 |

`subagent` tool の `preflight` **field** は named workflow resource と併用できない。
v1 が使うのは named workflow metadata ではなく、同じ Pi process の Extension が import する
`resolveSubagentLaunchContract()` public API である。

### 2.3 Pi 0.85.1 public Extension API

参照: [Pi Extensions](https://github.com/earendil-works/pi/blob/v0.85.1/packages/coding-agent/docs/extensions.md)、
[Settings](https://github.com/earendil-works/pi/blob/v0.85.1/packages/coding-agent/docs/settings.md)、
[Environment Variables](https://github.com/earendil-works/pi/blob/v0.85.1/packages/coding-agent/docs/environment-variables.md)、
および [Pi 0.85.1 SettingsManager source](https://github.com/earendil-works/pi/blob/v0.85.1/packages/coding-agent/src/core/settings-manager.ts)。

v1 は `ExtensionAPI` の `session_start`、`session_shutdown`、`tool_call`、
`tool_result`、`pi.events`、`ctx.cwd`、`ctx.sessionManager`、`ctx.modelRegistry` を
必要に応じて使用できる。package Agent は `pi-subagents` の file discovery に従い、
`pi-workflow` は process-local Agent registration / dispose を行わない。既存の Pi object や
ctx を session replacement 後に再利用しない。

Pi Extension は full system permissions で実行される。これは trusted local runtime の
前提を裏付けるが、malicious extension を防ぐ sandbox ではない。v1 では `ctx.mode`、
`setStatus`、`setWidget` を使った TUI projection を実装しない。

## 3. Ownership と dispatch

### 3.1 Main と resource

Main Session は trusted control plane である。Main は次を担当する。

- 同じ `missionId` の approved Plan Review を確認する
- package-owned implementation dispatch gate を通して
  `pi-workflow.implementation` を foreground で dispatch する
- bounded machine result と native run metadata を確認する
- semantic blocked のときに `mission.update(status: "needs_decision")` を行う
- final success を package state、binding、terminal Implementation state から判定する

Main は Plan body、PlanningDecision body、WorkUnit body、任意 script を dispatch args に
コピーしない。resource は同じ Mission の state と Artifact reference を読む。

Implementation resource は次を所有する。

- entry gate と canonical Planning validation の再利用
- approved `planReview.decisionSnapshot` からの bounded execution context 生成
- aggregate state の read/write
- worker launch 前の public preflight gate
- 一回だけの worker launch
- worker structured result の validation
- 全 terminal outcome に対する可能な限りの Git inspection
- package-owned failure handoff

### 3.2 Main からの dispatch contract

cutover 後の public dispatch は次の形に限定する。これは実装ではなく contract の記述である。

```js
subagent({
  workflow: "pi-workflow.implementation",
  args: { operation: "run" },
  missionId,
  cwd,
  async: false,
  isolation: "none",
  chatProgress: "off",
});
```

`planRef`、Plan body、PlanningDecision body、WorkUnit body、caller-owned
`workflowScript` / `workflowScriptPath` は渡さない。`isolation: "none"` は shared checkout
を明示するだけであり、排他 lock を意味しない。

Implementation dispatch は package-owned dispatch gate を通る。gate は public
`resolveSubagentLaunchContract()` と ephemeral package state を使って worker launch
contract を確認するが、別の durable workflow state store は作らない。gate を通過できない
場合は named resource dispatch 自体を block し、worker は起動しない。resource 側にも同じ
固定 contract の fail-closed check を置く。

## 4. Plan Review binding と entry gate

### 4.1 Plan Review binding

Plan Artifact digest/token protocol は v1 から削除する。`planRef` は Artifact の opaque
reference であり、Artifact bytes の cryptographic identity ではない。

`prepare-review` は次を行う。

1. current `planRef` を確認する。
2. current `planningDecision` を canonical `PlanningDecisionV1` validator と
   approval validator で検証する。
3. bounded deep copy を `decisionSnapshot` として保持する。
4. 次の pending binding を同じ Mission state に保存する。

```yaml
planReview:
  version: 1
  status: pending
  round: 1..3
  planRef: <opaque reference>
  decisionSnapshot: <PlanningDecisionV1>
  # reviewId: absent
  # feedbackRef: absent
```

`decisionSnapshot` は `PlanningDecisionV1` そのものであり、別の縮約 schema や digest では
ない。`PlanningDecisionV1` の JSON byte bound は既存の `MAX_PLANNING_DECISION_BYTES`
（32 KiB）を使う。`planReview` 全体の serialized bound は、snapshot を収容できるように
次の derived bound を cutover で採用する。

```text
MAX_PLAN_REVIEW_BINDING_BYTES_V1
  = MAX_PLANNING_DECISION_BYTES
  + 3 * MAX_REFERENCE_BYTES
  + 1 KiB
  = 39,936 bytes
```

`MAX_PLAN_REVIEW_BINDING_BYTES` の既存 8 KiB は snapshot を収容できないため、v1 の
implementation contract と同じ change で上記 bound に置き換える。Mission state 全体は
既存の `MAX_MISSION_STATE_BYTES`（256 KiB）以内でなければならない。

`record-review` は terminal transition の前に、次を順番に検証する。

- current `planRef == pending planReview.planRef`
- current `planningDecision` を canonical validator で検証する
- pending `decisionSnapshot` を同じ canonical validator で検証する
- current `planningDecision` と pending `decisionSnapshot` が deep-equals する
- `status`、`reviewId`、`feedbackRef` が round の contract に適合する

いずれかが失敗した場合は terminal transition を行わず、approval として扱わない。
JSON の object key order ではなく、validated JSON value の field、array order、scalar
value の構造的 deep equality を使う。

approved binding は次の shape になる。

```yaml
planReview:
  version: 1
  status: approved
  round: 1..3
  planRef: <opaque reference>
  decisionSnapshot: <PlanningDecisionV1>
  reviewId: <opaque reference>
  # feedbackRef: absent
```

rejected binding は `reviewId` と non-empty `feedbackRef` を持つ。pending binding は
`reviewId` / `feedbackRef` を持たない。全 binding は `additionalProperties: false` と
する。

Human が承認した Plan と machine execution contract の binding は、次の trusted-local
runtime invariant で成立する。

```text
package-owned Plan renderer
  + pending decisionSnapshot
  + approved review binding
```

Implementation の execution contract は top-level `planningDecision` ではなく、必ず
次の組み合わせである。

```text
planReview.status === "approved"
planReview.decisionSnapshot
```

Plan renderer は package-owned の validated `PlanningDecisionV1` から canonical Plan
Artifact を生成し、Plan Review bridge は `planRef` の Artifact を表示する。Main の prose
から Plan body を復元しない。Plan Artifact の外部悪意ある改変に対する tamper resistance
は v1 security model 外であり、digest、one-time token、cryptographic authorization を
導入しない。

### 4.2 Entry gate

worker を一度も起動する前に、resource は同じ Mission state と current binding を読み、
次をすべて検証する。

| Gate | 必須条件 |
| --- | --- |
| review | `planReview.status === "approved"`、`reviewId`、`decisionSnapshot` が存在する |
| snapshot | `decisionSnapshot` が canonical schema / semantic / byte validation に成功する |
| binding | `planReview.planRef` が current `planRef` と一致する |
| mode | `decisionSnapshot.implementation.mode === "single"`。`lanes` は変換せず reject する |
| WorkUnit | array が 1..`MAX_PLANNING_WORK_UNITS` 件で、各 ID と cross-reference が valid である |
| order | dependency は earlier array item のみを参照し、unknown、self、重複がない |
| writeScope | 全 entry が v1 exact path contract に適合する |
| worker | package Agent と effective launch contract が preflight で期待値に一致する |
| worker override | user/project settings に対象 Agent の exact override key が存在しない。存在確認は field value を解釈せず行う |
| checkout | worker 起動直前の fixed clean check が成功する |
| state | 初回 dispatch では `implementation` key が存在しない |
| operating precondition | 別 Pi/session/editor/automation が shared checkout に書き込まない |

entry gate では top-level `planningDecision` を execution context の source にしない。
state schema がそれを保持している場合は canonical validator で読み取り整合性を検査するが、
worker context は approved `decisionSnapshot` からだけ構築する。

gate の失敗は `lanes` を `single` に変換する理由にならない。v1 capability に適合する
Planning は `single` を生成し、既存 `lanes` decision は Plan Review または Implementation
entry で fail closed にする。

### 4.3 Gate の順序と blocked

1. Main または `/wf-resume` が approved `missionId` だけを package-owned dispatch gate に渡す。
2. gate が public preflight を実行し、documented user/project settings の target-Agent
   override absence を確認し、resource が state、binding、snapshot、mode、WorkUnit、
   `writeScope` を canonical contract で検証する。
3. worker 起動直前に fixed clean check を行う。
4. gate failure では worker を起動しない。target-Agent override を含む entry precondition、
   Human decision、unsupported mode のような semantic precondition は可能なら bounded
   `implementation.status = "blocked"` を保存する。
   state write が失敗した場合は blocked と偽装せず failure evidence を残す。
5. すべて成功した場合だけ、後述の ordering で `implementation` state と
   `phase: "implementation"` を保存して worker を起動する。

通常の approved binding では `planRef` と `reviewId` を Implementation envelope に含める。
pre-binding failure を execution state として作らないため、未承認状態の envelope に
bindings を省略する例外は設けない。

## 5. Canonical Planning validation

Implementation 固有の semantic validator は作らない。意味のある PlanningDecision 検証は
`PlanningDecisionV1` の canonical semantic validator に集約し、Plan 生成、Plan Review 前、
`record-review`、Implementation entry のすべてで同じ validator を再利用する。

### 5.1 v1 の semantic invariants

既存 bound を優先する。

| Contract | 既存 bound |
| --- | ---: |
| PlanningDecision serialized JSON | `MAX_PLANNING_DECISION_BYTES = 32 KiB` |
| WorkUnit count | `MAX_PLANNING_WORK_UNITS = 32` |
| dependency / scope / cross-reference count | `MAX_WORK_UNIT_REFERENCES = 16` |
| identifier | `MAX_PLANNING_IDENTIFIER_BYTES = MAX_IDENTIFIER_BYTES = 64` UTF-8 bytes |
| text | `MAX_PLANNING_TEXT_BYTES = MAX_REGULAR_TEXT_BYTES = 1 KiB` UTF-8 bytes |
| command / `writeScope` entry | `MAX_PLANNING_COMMAND_BYTES = MAX_COMMAND_ENTRY_BYTES = 2 KiB` UTF-8 bytes |
| JSON depth | `MAX_JSON_DEPTH = 8` |

`mode = "single"` では少なくとも次を canonical semantic validator で検証する。

- WorkUnit IDs are unique
- dependency IDs exist
- no self dependency
- no duplicate dependency
- dependency references only earlier WorkUnits in the same array
- earlier-only rule により cycle は不可能である（別の cycle state を作らない）
- `writeScope` は v1 の mechanically decidable exact path contract である
- acceptance criteria / focused verification / final verification の IDs が存在する
- 既存の array count、UTF-8、serialized JSON、`additionalProperties: false` bounds を満たす

unknown dependency、self dependency、duplicate dependency、later dependency があれば
Plan Review 前に reject する。earlier-only rule を通過した graph に cycle は存在しないため、
cycle のための別 validator や runtime graph state は導入しない。

### 5.2 最小 `writeScope` path contract

v1 は glob を導入しない。各 `writeScope` entry は repository root からの exact file path
だけを表す。

- repository-relative である
- `/` separator を使う。入力はこの canonical form にしてから検証する
- empty string、empty component、`.`、`..`、trailing `/` を許可しない
- absolute path、Windows drive prefix、NUL、control character を許可しない
- directory prefix、glob、pattern を許可しない
- `*`、`?`、`[`、`]`、`{`、`}` など glob syntax を許可しない
- まだ存在しない new file も exact file path として表現できる
- path text は `MAX_PLANNING_COMMAND_BYTES` の UTF-8 bound 内である

この contract は Plan Review 前と Implementation entry で同じ機械判定を行う。symlink の
real target、checkout 外への escape、ignored file はこの path parser が hard に解決する
対象ではない。

## 6. Implementation worker Agent

### 6.1 package Agent file

前回の process-local runtime Agent registration 案と、runtime Agent として解決する案は
撤回する。v1 の worker は package-owned Agent file として
`agents/implementation-worker.md` に追加予定である。`package.json` に既にある
`pi.subagents.agents: ["./agents"]` から通常の package Agent discovery に乗せる。

frontmatter の runtime identity は既存 package Agent と同じ規則で定義する。

```yaml
---
name: implementation-worker
package: pi-workflow
description: Trusted local Implementation worker for an approved Plan
tools: read, grep, find, ls, edit, write, contact_supervisor
systemPromptMode: replace
inheritProjectContext: false
inheritGlobalContext: false
inheritSkills: false
defaultContext: fresh
completionGuard: false
acceptanceRole: writer
extensions:
---

Implement only the supplied approved decision context and return ImplementationResultV1.
```

`name` は local name、`package` は package identity であり、discovery 後の
`agent.name` は `pi-workflow.implementation-worker`、`agent.localName` は
`implementation-worker`、`agent.packageName` は `pi-workflow`、`agent.source` は
`package` になる。`filePath` は `<pi-workflow package root>/agents/implementation-worker.md`
でなければならない。runtime Agent registration API、登録 event、process-local registry は
この worker に使用しない。

空の `extensions:` は ambient extension を明示的に無効にする。`subagentOnlyExtensions`、
`skills`、`defaultReads` は Agent file に記載しない。`defaultReads:false` は Agent frontmatter
に書かない。`contact_supervisor` は native coordination tool、`structured_output` は
`outputSchema` を指定した run にだけ pi-subagents が追加する internal protocol tool である。
したがって caller-facing の Agent tools は上記 7 個だけで、`structured_output` は file に
手書きしない。

worker には次を与えない。

- `bash`
- `powershell`
- `subagent`
- `subagent_supervisor`
- shell execution capability
- 任意の MCP tool
- ambient extension tools
- 任意の caller-owned Skill

この strict allowlist は delegation を許可しない。tool allowlist は child capability boundary
であるが、OS sandbox、malicious extension protection、別 process writer の排他ではない。

### 6.2 public preflight による execution safety gate

Implementation dispatch gate は `pi-subagents/preflight` の次の public API を使う。

```ts
import { resolveSubagentLaunchContract } from "pi-subagents/preflight";

const result = await resolveSubagentLaunchContract({
  agent: "pi-workflow.implementation-worker",
  agentScope: "both",
  context: "fresh",
  cwd,
  outputMode: "file-only",
  outputSchema: ImplementationResultV1Schema,
  availableModels: ctx.modelRegistry.getAvailable(),
  parentSessionFile: ctx.sessionManager.getSessionFile(),
  parentLeafId: ctx.sessionManager.getLeafId(),
});

if (!result.ok) throw new Error(result.message);
const contract = result.contract;
```

`resolveSubagentLaunchContract()` は `discoverAgentSnapshot()` の file-discovered source
から Agent を解決する。process-local runtime Agent registry をこの public preflight の
source として解決しないため、runtime registration を preflight 可能な worker identity と
して使わない。

実装時は、preflight と実際の one-element `runs.all` item に同じ Agent、context、cwd、
outputMode、outputSchema、bridge/ceiling の値を与える。`task` と nonce 付き `output` は package-owned
resource が生成する動的値であり、preflight で検証する固定 capability fields とは分ける。
preflight は side-effect-free であり、child session、run、Mission state、別の state store を
作らない。`preflight` field を named resource に付ける代替実装はしない。

named resource の `resolve` は同期の bounded resolver で、workflow sandbox から host API を
import することもできない。そのためこの gate は `pi-workflow` Extension の host-side
dispatch path（Pi 0.85.1 の `tool_call` interception または同じ package-owned command
path）で、named resource が実行される前に行う。preflight が実行不能、`ok: false`、または
後述の expected fields と不一致なら、hook は dispatch を block する。これは resource と
worker の間に別の workflow state store を置くことを意味しない。

worker を起動する前に、少なくとも次を exact expected contract と比較する。

| Contract field | 期待値 |
| --- | --- |
| `contract.agent.name` | `pi-workflow.implementation-worker` |
| `contract.agent.localName` | `implementation-worker` |
| `contract.agent.packageName` | `pi-workflow` |
| `contract.agent.source` | `package` |
| `contract.agent.filePath` | `<pi-workflow package root>/agents/implementation-worker.md` と同一の canonical path |
| `contract.agent.shadowedCandidates` | `pi-workflow.implementation-worker` identity に一致する `user` / `project` candidate が存在しない。該当 shadowing は reject する |
| `contract.context` | `fresh` |
| `contract.systemPromptMode` | `replace` |
| `contract.inheritProjectContext` | `false` |
| `contract.inheritGlobalContext` | `false` |
| `contract.inheritSkills` | `false` |
| `contract.skills.requested` / `resolved` / `missing` | すべて empty |
| `contract.tools.declaredBuiltin` | `read, grep, find, ls, edit, write, contact_supervisor` の exact allowlist |
| `contract.tools.effectiveAllowlist` | `read, grep, find, ls, edit, write, contact_supervisor, structured_output` のみ |
| `contract.tools.internalTools` | `structured_output` のみ |
| `contract.tools.mcp` / `effectiveMcpTools` | empty |
| `contract.tools.toolExtensionPaths` / `configuredExtensions` | empty |
| `contract.tools.runtimeExtensions` / `extensionArgs` | 0.67.0 が child protocol に必要とする pi-subagents 内部 runtime extension のみ。第三者・MCP extension はない |
| `contract.tools.disableAmbientExtensions` | `true` |
| `contract.tools.fanoutAuthorized` | `false` |
| definition projection / digest | opaque identity evidence。decode、再実装、`completionGuard` / `defaultReads` の判定には使わない |

`contract.agent.shadowedCandidates` は public preflight が返す候補情報である。selected candidate
が package Agent であっても、同じ identity の user/project Agent が候補に残っていれば trusted
runtime boundary を成立させず、worker を起動しない。ただし、この候補情報は settings の
`agentOverrides` の存在を表さない。

0.67.0 public source の settings override resolution は `completionGuard` を overrideable な
field として扱う。`SubagentLaunchContract` に `completionGuard` の独立 field はない。
`definitionDigest` は opaque な launch identity であり、decode や `projectAgentDefinition()` などの
internal API の再実装を
行わない。`completionGuard: false` の保証は、package Agent file の declared contract と、
次の target-Agent override absence gate の組み合わせで成立させる。public preflight から
直接確認できない値を prose、digest、error text から推測しない。

#### v1 target-Agent override absence gate

Implementation dispatch 前に、package-owned host-side gate は Pi / `pi-subagents` の
public/documented settings root resolution に従って user と project の settings source を確認する。
環境依存の path を組み立てる独自規則は持たない。

- user settings は Pi の resolved agent config root にある `settings.json` を読む。
  `PI_CODING_AGENT_DIR` が設定されていればそれを使い、未設定時は documented default の
  `~/.pi/agent` を使う。Pi public `getAgentDir()` の resolution を source of truth とする。
- project settings は dispatch の `cwd` に対する `pi-subagents` の documented project-root
  resolution を使う。既定は `.pi` または `.agents` を持つ nearest parent であり、
  `subagents.projectRootResolution: "git-root"` / `"nearest"` が documented に指定されている
  場合はその規則に従う。resolved project root の Pi `CONFIG_DIR_NAME` 配下の `settings.json`
  が対象で、standard Pi では `<project-root>/.pi/settings.json` となる。root が解決できない
  場合、project settings source は存在しない。

各 settings JSON について、値を解釈せず、次の canonical runtime name の own property だけを
機械的に検査する。

```text
subagents.agentOverrides["pi-workflow.implementation-worker"]
```

0.67.0 source が解決する provider-scoped source も対象にする。
`agentOverridesByProvider` が存在する場合は、各 provider bucket の次の exact key を検査する。

```text
subagents.agentOverridesByProvider[<provider>]["pi-workflow.implementation-worker"]
```

`<provider>` は provider name の値として扱うだけで、override field や値は解釈しない。直接
override は canonical `agent.name` で match されるため、`implementation-worker` の local name、
alias、prose は matching key ではない。user と project の precedence は安全な override を
作らないため、どちらか一方でも target key が存在すれば、値が空・無効・`completionGuard: true`
であるかを問わず worker を起動しない。blocked report には固定の
`unsupported worker override` を明示する。これは「値を見て safe / unsafe に分類する」処理
ではなく、v1 の全面禁止である。

settings file の documented root を解決できない、read / JSON parse ができない、または対象の
settings container を機械的に確認できない場合は、override がないと推測しない。worker を起動
せず、`UNRESOLVED` の fail-closed precondition evidence とする。valid な settings source に
対象 key がない場合だけ absence gate を通過する。この gate は settings の field value、error
prose、`definitionDigest` を parse せず、別の workflow state store も作らない。

`reads: false` は preflight API の input field ではないため、実際の child launch params に
毎回明示する。`context: "fresh"` と併せて package-owned launch builder が他の値を生成した
場合は worker を起動しない。この preflight と override gate は launch contract の safety gate
であり、別 workflow state store、durable claim、approval token ではない。

## 7. Worker execution と context

### 7.1 approved context

worker に渡す execution context は approved `planReview.decisionSnapshot` からだけ構築
する。少なくとも次を bounded に含める。

- request summary、in-scope / out-of-scope、non-goals
- constraints と risks
- `implementation.mode = "single"`
- 全 WorkUnit の `id`、`title`、`objective`、`dependsOn`、`writeScope` を original array order のまま
- acceptance criteria の bounded text
- focused verification / final verification は定義情報としてのみ渡す

渡さないもの:

- Main Session transcript
- canonical Plan Markdown body
- top-level `planningDecision` を再解釈した context
- 未承認 decision
- caller-owned arbitrary script
- WorkUnit ごとの child run / progress mapping

worker は array の先頭から各 WorkUnit を処理する。dependency graph を再ソートせず、
WorkUnit ごとに別 run を作らない。material な product、architecture、policy、risk
acceptance を勝手に決めず、安全に続けられない場合は `contact_supervisor` で escalation
する。supervisor message を machine state として parse しない。

### 7.2 一回の worker run

Implementation resource は一つの named resource と、exactly one item の config-object
`runs.all` 呼び出しだけを持つ。これは parallel worker execution ではない。`runs.all` の
item count は常に 1、dynamic fanout はなく、worker と active writer は一つだけである。
config-object 形式を使うことで、pi-subagents 0.67.0 の failure collection path が child
failure を ordered result として返す。

概念上の child launch は次のとおりである。

```js
const [worker] = await runs.all([
  {
    key: "implementation",
    agent: "pi-workflow.implementation-worker",
    context: "fresh",
    reads: false,
    progress: false,
    task: boundedApprovedExecutionContext,
    output: uniqueExplicitWorkerOutputPath,
    outputMode: "file-only",
    outputSchema: ImplementationResultV1Schema,
    acceptance: { level: "none", reason: "v1 は automated Review / Verification を実行しない" },
  },
]);
```

実際の resource script はこの one-element `runs.all` を一度だけ実行し、`runs.lanes`、
複数の未 await promise、`runs.steer`、`resume`、rolling retry、WorkUnit ごとの child run を
使わない。`runs.all` の ordered result index 0 が `worker` であり、WorkUnit id を key にしない。
outer resource と child は foreground に限定し、shared checkout を使用する。

## 8. Normative Implementation state

### 8.1 `ImplementationEnvelopeV1`

Mission state に保存する Implementation progress は aggregate envelope 一つだけである。
WorkUnit progress、attempt、child mapping、run identity は複製しない。

```ts
type ImplementationEnvelopeV1 = {
  version: 1;
  planRef: ReferenceValue;
  reviewId: ReferenceValue;
  status: "running" | "completed" | "blocked" | "failed";
  blockKind?: "entry_precondition" | "human_decision" | "unsupported_mode";
  failureKind?: "runtime" | "interrupted" | "conformance" | "state_inconsistent";
  blockers?: string[];
};
```

normative constraints は次のとおりである。

| Field | Constraint |
| --- | --- |
| envelope | JSON object、`additionalProperties: false`、`MAX_JSON_DEPTH = 8` 以下 |
| `version` | literal `1`（numeric、string length constraint なし） |
| `planRef` | non-empty opaque reference、既存 `MAX_REFERENCE_BYTES = 2,048` UTF-8 bytes 以下 |
| `reviewId` | non-empty opaque reference、既存 `MAX_REFERENCE_BYTES = 2,048` UTF-8 bytes 以下 |
| `status` | `running` / `completed` / `blocked` / `failed` のみ、literal の最大長は `completed` の 9 UTF-8 bytes |
| `blockKind` | optional。`entry_precondition` / `human_decision` / `unsupported_mode` のみ。enum literal は ASCII で最大 18 UTF-8 bytes |
| `failureKind` | optional。`runtime` / `interrupted` / `conformance` / `state_inconsistent` のみ。enum literal は ASCII で最大 17 UTF-8 bytes |
| `blockers` | `blocked` / `failed` では required、1..`MAX_HUMAN_INPUT_ENTRIES`（8）件。各 text は `MAX_REGULAR_TEXT_BYTES`（1 KiB）UTF-8 bytes 以下 |
| `blockers` on `running` | absent |
| `blockers` on `completed` | absent または empty array。どちらも同じ completed state である |
| serialized envelope | `MAX_IMPLEMENTATION_ENVELOPE_BYTES = MAX_RESOURCE_ARGS_BYTES = 16 KiB` 以下 |
| complete Mission state | 既存 `MAX_MISSION_STATE_BYTES = 256 KiB` 以下 |

`blockers` は bounded blocker metadata であり、transcript、Plan body、diff、run id、status
object、session path を含めない。文字列は JSON value のみで、NUL/control character や
unbounded nested object を許可しない。`blockKind` / `failureKind` は enum discriminator
であり、`blockers`、`error`、worker prose の内容から推測しない。unknown discriminator と
unknown property は reject する。

state invariants は次のとおりである。

- `implementation.planRef === planReview.planRef`
- `implementation.reviewId === planReview.reviewId`
- `planReview.status === "approved"`
- `planReview.decisionSnapshot` が存在し、canonical validator に通る
- `implementation.status === "running"` のとき、`blockKind` / `failureKind` / `blockers` は absent
- `implementation.status === "completed"` のとき、`blockKind` / `failureKind` は absent、
  `blockers` は absent または empty で、worker verdict は `completed`、post-run Git
  inspection が成功している
- `implementation.status === "blocked"` のとき、`blockKind` は必須、`failureKind` は absent、
  `blockers` は non-empty で、semantic precondition または worker semantic block の bounded
  reason を持つ
- `implementation.status === "failed"` のとき、`failureKind` は必須、`blockKind` は absent、
  `blockers` は non-empty で、runtime、interruption、inspection、state、Artifact、scope の
  failure evidence を bounded に持つ
- `running`、terminal status から `running` への自動復帰はない
- `completed`、`blocked`、`failed` から worker を自動起動しない
- `runId`、native run status、session path は envelope に入れない

`planRef` / `reviewId` がない pre-binding failure は Implementation envelope に変換しない。
初回 gate failure を state に残す場合も、approved binding が既に存在する場合だけこの
normative envelope を使う。

### 8.2 Machine-readable failure classification

`blockKind` と `failureKind` が Implementation の classification authority である。
`blockers` は bounded evidence / display metadata に過ぎず、Main はその内容を解析しない。
`UNRESOLVED` は新しい `status` / discriminator ではなく、terminal machine result を得られない
場合の out-of-band な fail-closed label である。
`error`、`output`、`message`、`isError`、worker prose、exception text は action decision の
入力にしない。

正常に control を返せる resource は、既存の named-resource result / handoff 経路で
`ImplementationEnvelopeV1` の bounded plain-JSON result を Main に返す。Main が次の action
を決めるために読むのは `status`、`blockKind`、`failureKind` だけである。`planRef`、
`reviewId`、`blockers` は binding / report のために保持できるが、自然言語の解釈は行わない。
package-owned failure（outer workflow の `isError`）は transport outcome であり、classification
の代替ではない。

`ImplementationEnvelopeV1` を形成・保存できない persisted state failure では、無効な envelope
を捏造しない。可能なら `status: "failed"` と `failureKind: "state_inconsistent"` を持つ
bounded machine handoff を返し、state を書き換えられない場合はその handoff 自体を未保存の
fail-closed evidence とする。この handoff も `version`、`status`、optional discriminator、
optional bounded `blockers` 以外の property を許可しない。machine handoff の serialized JSON も
`MAX_IMPLEMENTATION_ENVELOPE_BYTES`（16 KiB）以下、JSON depth は `MAX_JSON_DEPTH` 以下とする。

#### Native result flags

v1 の child launch は config-object の one-element `await runs.all([...])` である。
`runs.all` は ordered array を返すため、`worker` はその index 0 の public
`WorkflowScriptChildResult` である。config-object の failure collection path では ordinary
child failure も `ok: false` の result として収集される。一方、直接の `runs.run` failure
boundary の Promise rejection は v1 の child launch に使わない。

`WorkflowScriptChildResult` で使用する実在の fields は `key`、`ok`、`output`、`error`、
`interrupted`、`stopped`、`structuredOutput`、`terminalOutcome`、`results` である。
`timedOut` は `WorkflowScriptChildResult` の field ではないため、one-element result の
`results[0]` にある public `SingleResult.timedOut` を読む。必要な nested `SingleResult`
fields は `interrupted`、`stopped`、`timedOut`、`exitCode`、`processSignal`、`error` とする。
`WorkflowReceipt.state` / `terminalOutcome` を使う場合も、host が実際に取得した public
receipt の値だけを対象にする。

この v1 one-element `runs.all` path の `WorkflowScriptChildResult` / `SingleResult` に
native `cancelled` flag はない。したがって `cancelled` という名前を推測して追加しない。
foreground の cancellation / stop は native `stopped`、interrupt は native
`interrupted` として扱う。`processSignal`、`exitCode`、`error` だけでは interruption の
種類を決めない。

#### Deterministic mapping

次の順序で判定する。同じ terminal observation に複数の条件があるときは、明記された
優先順位に従う。post-run conformance が確認できる場合は worker の semantic verdict より
優先し、scope 外 mutation を `blocked` に変換しない。

| 判定点 | 機械的な条件 | Implementation outcome |
| --- | --- | --- |
| persisted package state | phase/envelope の impossible combination、または malformed / incomplete `ImplementationEnvelopeV1` | `failed` / `failureKind: state_inconsistent`。valid envelope を保存できなければ fail-closed handoff。worker を起動しない |
| entry gate | dirty working tree、または public preflight が `ok: false` を返す、または effective Agent contract が期待値と不一致 | `blocked` / `blockKind: entry_precondition` |
| target-Agent override gate | user/project settings の exact target key が一つでも存在する | `blocked` / `blockKind: entry_precondition`。override value は解釈せず、worker を起動しない |
| target-Agent override gate unavailable | documented settings root / file / container の absence を機械的に確認できない | `UNRESOLVED` fail closed。worker を起動せず、new discriminator を保存しない |
| preflight infrastructure | public preflight が throw / unavailable で contract を返せない | machine result を返せる場合は `failed` / `failureKind: runtime`。返せない場合は `UNRESOLVED` fail closed。worker を起動しない |
| mode gate | `implementation.mode === "lanes"` | `blocked` / `blockKind: unsupported_mode` |
| worker semantic result | `worker.ok === true` かつ schema-valid な unwrapped `worker.structuredOutput.verdict === "blocked"` | `blocked` / `blockKind: human_decision` |
| worker interruption | `worker.interrupted === true` または `worker.stopped === true`、または underlying `worker.results[0].interrupted` / `.stopped` が `true` | `failed` / `failureKind: interrupted` |
| worker timeout | underlying `worker.results[0].timedOut === true`、または native `worker.terminalOutcome` が `{ state: "partial", reason: "timeout" }` | `failed` / `failureKind: runtime` |
| worker ordinary failure | worker の `ok === false`、structured result missing / invalid、または timeout / interruption 以外の ordinary runtime / tool failure | `failed` / `failureKind: runtime` |
| post-run inspection | `writeScope` violation、required inspection failure、inspection truncation / unknown により conformance を establish できない | `failed` / `failureKind: conformance` |
| valid success | `worker.ok === true`、schema-valid `verdict: "completed"`、post-run conformance success | `completed`（`blockKind` / `failureKind` なし） |

worker の valid `blocked` result は semantic block である。ただし同じ terminal outcome の
post-run inspection が scope violation または conformance unknown なら、上表の
`failureKind: conformance` を採用する。structured result の missing call、wrapper / schema /
byte violation は `human_decision` ではなく `runtime` である。

`WorkflowScriptChildResult` の `results[0]` が存在しないまま child が `ok: false` を返した
場合は、利用可能な child result として `runtime` に分類する。resource 自体が abort され、
terminal result を返せない場合は、利用可能な native structured result / event の範囲だけを
次のように使う。

- native `WorkflowReceipt.state === "stopped"` または child の native `stopped: true` が
  観測できる場合は `failed` / `interrupted` とする。
- native `SingleResult.timedOut === true`、または `WorkflowReceipt.terminalOutcome` が
  `{ state: "partial", reason: "timeout" }` の場合は `failed` / `runtime` とする。
- `state: "paused"` / detached、generic `state: "failed"`、`isError`、prose、error text、
  `processSignal` だけ、または receipt / result が存在しない場合は分類しない。bounded
  `UNRESOLVED` として fail closed にする。この範囲の classification は unavailable であり、
envelope に新しい enum 値として保存せず、automatic retry / resume / redispatch もしない。
persisted `running` / inconsistent evidence を自動修復せず、`needs_decision` に変換しない。

#### Main action mapping

Main は native Mission status と `ImplementationEnvelopeV1.status` を同じものとして扱わず、
次の machine result mapping だけで action を決める。

| Implementation machine result | Main action |
| --- | --- |
| `status: "completed"`（`blockKind` / `failureKind` なし） | `mission.close(completed)` |
| `status: "blocked"` と valid `blockKind` | `mission.update(needs_decision)`。automatic retry / redispatch はしない |
| `status: "failed"` と valid `failureKind` | automatic retry はしない。`needs_decision` へ黙って変換せず、`failureKind` と `status` を machine-readable に報告する |
| persisted `status: "running"`、または inconsistency / `UNRESOLVED` | automatic redispatch / state repair はしない。native evidence と bounded unresolved state を owner に報告する |

`blocked/*` は enum のいずれかであることを検証し、unknown discriminator は reject する。
`failed/*` は `failureKind` を検証する。Main は native Mission の `completed` / `failed` /
`needs_decision` を Implementation envelope にコピーせず、逆方向にもコピーしない。

### 8.3 State transition と write ordering

logical package phase は `discovery | research | planning | plan-review | implementation`
である。native Mission status はここに複製しない。

- 初回 entry 前: `implementation` は absent
- approved gate の semantic failure: 可能なら `implementation.status = "blocked"` とし、
  `blockKind` は 8.2 の deterministic mapping に従い、phase は `plan-review` のままにする
- gate 成功: `implementation.status = "running"`、phase を `implementation` にする
- valid `completed` result + scope inspection success: `completed`（discriminator なし）
- valid worker `blocked`: `blocked` / `blockKind: human_decision`
- runtime failure、native interruption / timeout、state / Artifact failure: `failed` とし、
  `failureKind` は `runtime` または `interrupted` のいずれかを 8.2 に従って保存する
- scope violation、inspection不能、scope unknown: `failed` / `failureKind: conformance` とする

`state.set` は key 単位で latest state を merge するが、multi-key CAS / transaction ではない。
v1 は別 state engine を追加しない。ordering は次のとおりである。

1. state、approved binding、snapshot、mode、WorkUnit、writeScope、preflight を検証する。
2. fixed clean check が成功した後、`state.set("implementation", runningEnvelope)` を行う。
3. 次に `state.set("phase", "implementation")` を行う。
4. 二つの write が成功してから one worker run を起動する。
5. worker が terminal になったら、成功・blocked・失敗のいずれでも可能な限り Git inspection を行う。
6. inspection と result の判定後、terminal envelope を `state.set("implementation", ...)` する。

2 と 3 の間に interruption / write failure が起きた場合、`implementation=running` と
`phase=plan-review` の不整合を自動修復しない。3 の後に worker launch ができない場合も
retry しない。terminal status の state write が失敗した場合も success としない。定義済み
transition にない state は `recovery-required` として fail closed にする。

`runId` と native `run status` の authoritative data は pi-subagents Mission/run metadata
に残す。Mission state へ複製しない。state envelope の `status` は package logical outcome
であり、native run metadata の代替ではない。

## 9. Shared checkout と `writeScope`

### 9.1 Operating precondition

v1 は `isolation: "none"` の shared checkout を使う。cross-process / cross-session
exclusive lock は存在しない。

> Implementation 実行中に別 Pi、session、editor、automation、process が同じ checkout に
> 書き込まないこと。

同一 resource 内で worker は一つだけなので package が意図する active writer は一つである。
しかし clean check は check と first write の間の lock ではない。cross-process concurrent
dispatch は v1 で support しない。

この precondition を満たせない場合は v1 を起動しない。hard checkout isolation は future
managed-worktree design に送る。v1 に lock manager、sandbox、worktree manager、CAS claim
を追加しない。

### 9.2 `writeScope` の意味

`writeScope` は security sandbox ではない。v1 では次の二つの意味だけを持つ。

1. approved edit boundary
2. post-run conformance boundary

全 WorkUnit の exact path の union を approved boundary とする。WorkUnit ごとの runtime
progress や physical write enforcement は作らない。worker は array order のまま処理する。

package-owned Git inspection は、clean baseline と post-run state を比較し、少なくとも次を
対象にする。

- tracked modification / deletion
- rename の old endpoint と new endpoint
- 通常の Git status で見える untracked path

次のどれかなら `success` にしない。また worker の `verdict=blocked` であっても
semantic-blocked として扱わない。

- actual visible repository changes に scope 外 path が一つでもある
- Git inspection が失敗する
- inspection output が切り詰められるなど、scope 判定が不可能である
- scope が absent、malformed、または不明である

inspection不能、scope不明、scope violation は partial mutation を伴う failure として
fail closed にする。利用可能な bounded evidence（native run metadata、cwd、branch/ref、
inspection error、partial diff の有無）だけを返し、rollback、reset、stash、revert はしない。

`writeScope` は誤った `edit` / `write` path、symlink、checkout 外 write、別 process の
concurrent mutation を hard に防げない。Git inspection も ignored files を必ずしも表示
せず、checkout 外の変更を完全には観測せず、symlink escape や concurrent external mutation
の provenance を証明しない。これらは v1 trust boundary 外である。

### 9.3 Git policy

worker と package policy は次を禁止する。

- commit / push / tag / PR
- stash / reset / checkout / revert
- branch 操作、release、deployment

worker に `bash` / `powershell` / shell tool はない。resource が使用できる Git operation は
package が固定した read-only clean/status/diff inspection だけであり、caller から command、
flag、cwd を受け取らない。inspection failure 時に cleanup や automatic rollback を行わず、
partial edits を evidence として残す。

## 10. Worker result contract

### 10.1 `ImplementationResultV1Schema`

Worker の machine result は次の normative schema である。

```json
{
  "type": "object",
  "properties": {
    "version": { "const": 1 },
    "verdict": { "enum": ["completed", "blocked"] },
    "blockers": {
      "type": "array",
      "minItems": 0,
      "maxItems": 8,
      "items": { "type": "string", "minLength": 1, "maxLength": 1024 }
    }
  },
  "required": ["version", "verdict", "blockers"],
  "additionalProperties": false
}
```

Schema / semantic / byte rules:

- `version` は literal `1`
- `verdict` は `completed | blocked` のみ、literal の最大長は `completed` の 9 UTF-8 bytes
- `blockers` は必須 array、最大 8 件（既存 `MAX_HUMAN_INPUT_ENTRIES`）
- blocker text は各 1 KiB UTF-8 bytes 以下（既存 `MAX_REGULAR_TEXT_BYTES`）
- `completed` では `blockers` は空 array
- `blocked` では blocker を少なくとも 1 件持つ
- result 全体の serialized JSON は `MAX_IMPLEMENTATION_RESULT_BYTES = MAX_RESOURCE_ARGS_BYTES`
  （16 KiB）以下
- JSON depth は `MAX_JSON_DEPTH` 以下、`additionalProperties: false`
- `workUnitId`、runId、Plan body、transcript、test output は追加しない

### 10.2 structured output envelope

`outputSchema: ImplementationResultV1Schema` を指定した worker では、pi-subagents の
internal `structured_output` tool を使う。

**tool invocation**:

```json
{
  "value": {
    "version": 1,
    "verdict": "blocked",
    "blockers": ["approved scope だけでは安全に継続できない"]
  }
}
```

**one-element `runs.all` result element**:

```js
const [worker] = await runs.all([
  {
    key: "implementation",
    agent: "pi-workflow.implementation-worker",
    context: "fresh",
    reads: false,
    progress: false,
    task: boundedApprovedExecutionContext,
    output: uniqueExplicitWorkerOutputPath,
    outputMode: "file-only",
    outputSchema: ImplementationResultV1Schema,
    acceptance: { level: "none", reason: "v1 は automated Review / Verification を実行しない" },
  },
]);
// worker.structuredOutput === {
//   version: 1,
//   verdict: "blocked",
//   blockers: ["approved scope だけでは安全に継続できない"],
// }
```

`worker.structuredOutput` は `<ImplementationResultV1>` そのものであり、
`worker.structuredOutput.value` ではない。missing call、wrapper/schema/byte violation、
または current contract 不一致は semantic blocked ではなく `failed` /
`failureKind: runtime` とする。worker prose を fallback parse しない。

resource が Main に返す blocked handoff も unwrapped value shape とし、`status: "blocked"`、
`blockKind: "human_decision"`、bounded `blockers` を持つ machine result として返す。
resource はこの bounded machine details/event を残してから package-owned failure（outer
workflow の `isError` / failed result）を返す。Main は `isError` や failure prose ではなく
machine result の discriminator を読む。これにより child が valid blocked result を返しても
outer attached workflow が無条件に native `completed` になることを避ける。

### 10.3 file-only output

`outputMode: "file-only"` を使う場合、resource は package-owned Artifact root に一意な
nonce を含む explicit output path を生成し、`output` field で渡す。

```text
output: <package-owned-artifact-root>/implementation-worker-<unique-id>.md
outputMode: file-only
```

固定 filename、task 文だけの filename、caller が指定する output path は使わない。
structured output の internal `output.json` と file-only final output Artifact は別物である。

resource は `outputReference`、`outputPathMapping`、`artifactPaths` などの public machine
metadata を evidence として扱う。`Output saved to: ...` 表示文や file-only failure 時の
inline debugging text を state 判定のために parse しない。output save failure、structured
output failure、worker failure は `failed` / `failureKind: runtime` とし、success にしない。

## 11. Execution outcome / lifecycle

### 11.1 Resource execution

`pi-workflow.implementation` は次を一回だけ順番に行う。

1. approved binding、snapshot、canonical PlanningDecision、single mode、WorkUnit、
   `writeScope`、state、preflight、clean check を検証する。
2. `implementation=running`、次に `phase=implementation` を state に保存する。
3. config-object の one-element `runs.all` を一回 await し、ordered result の index 0 を `worker` として受け取る。これは parallel execution ではなく、failure collection path を使うためである。
4. structured result を `ImplementationResultV1` として検証する。
5. worker terminal outcome のいずれでも、可能な限り package-owned Git inspection を行う。
6. 8.2 の deterministic mapping で `status` と discriminator を決める。worker prose、
   `error`、`isError` は判定に使わない。
7. `completed` の場合は scope inspection 成功時だけ `implementation=completed` にする。
8. `blocked` の場合は `blockKind` と bounded blockers を保存し、machine-readable blocked
   handoff を emit して package-owned failure で終了する。
9. `failed` の場合は対応する `failureKind` と bounded evidence を保存し、success としない。

### 11.2 全 terminal outcome の inspection

worker の terminal outcome は次のいずれでも、可能な限り Git inspection を行う。

- `completed`
- `blocked`
- native `interrupted` / `stopped`
- nested `SingleResult.timedOut` または `WorkflowScriptChildResult.terminalOutcome` による timeout
- runtime failure

worker が structured result を返さない、launch が失敗する、process が中断されるなどの
場合も、resource の `finally` 相当の package-owned path で inspection を試みる。inspection
自体が不可能なら、変更なしと推測せず `failed` / `failureKind: conformance` として bounded
failure evidence を返す。ただし resource 自体が terminal result を返せない場合は、8.2 の
native structured evidence が不足する限り `UNRESOLVED` とし、`running` を自動で別 status に
変換しない。

### 11.3 Native Mission lifecycle と logical phase

native Mission status と pi-workflow の logical `phase` / `implementation.status` は分離する。

- Planning または Plan Review の attached foreground workflow completion により native
  Mission が `completed` になることがある。これは pi-subagents の native semantics として
 受け入れる。logical phase を native status にコピーしない。
- Implementation dispatch は同じ `missionId` に attachment する。attachment により native
  lifecycle が Mission を active に戻す動作は pi-subagents に任せる。
- Implementation resource が成功して返ると、attached foreground workflow の native behavior
  により native Mission が `completed` になり得る。v1 では Implementation が terminal なので
  これは logical state と矛盾しない。
- blocked / failed resource は native failure として観測され得る。Main は bounded machine
  handoff の `status` / discriminator を確認し、`blocked` の場合だけ `needs_decision` とする。
- final workflow success は native status だけで決めず、package state、approved binding、
  `implementation.status = completed`、post-run scope inspection から判定する。
- 独自 Mission lifecycle engine、second lifecycle store、Implementation 専用の
  `mission.close` engine を作らない。

native `completed` は次を意味しない。

```text
Formal Verification: not run
Automated Review: not run
Human Code Review: not run
Merge readiness: undetermined
Deployment / release readiness: undetermined
```

### 11.4 Failure / cancellation table

| 状況 | worker | package state | resource / native outcome | Main |
| --- | --- | --- | --- | --- |
| approved entry semantic precondition blocked | 起動しない | `blocked` / `blockKind: entry_precondition`、phase は `plan-review` | package-owned failure、native はまず failure | machine handoff 後に `needs_decision` |
| `implementation.mode === "lanes"` | 起動しない | `blocked` / `blockKind: unsupported_mode` | package-owned failure、native はまず failure | machine handoff 後に `needs_decision` |
| worker semantic blocked | valid run 一回 | `blocked` / `blockKind: human_decision` と blockers | package-owned failure、native はまず failure | machine handoff 後に `needs_decision` |
| worker result invalid / missing | 一回の child failure | `failed` / `failureKind: runtime` を保存できれば保存 | runtime/infrastructure failure | `needs_decision` に変換しない |
| launch / host / Artifact failure | 起動なし、または途中停止 | `failed` / `failureKind: runtime`、または既存 `running` の evidence | native failure | retry しない |
| malformed / impossible persisted state | 起動しない | `failed` / `failureKind: state_inconsistent`、または fail-closed handoff | native failure | redispatch しない |
| scope violation / inspection unknown | 完了しても success にしない | `failed` / `failureKind: conformance` | native failure | close / success にしない |
| native `interrupted` / `stopped` | 完了扱いにしない | `failed` / `failureKind: interrupted` | native paused/failed semantics を保持 | retry / automatic resume しない |
| nested `SingleResult.timedOut` / `WorkflowScriptChildResult.terminalOutcome` の timeout | 完了扱いにしない | `failed` / `failureKind: runtime` | native failure | retry しない |
| material Plan / binding change | 続行しない | `failed` または semantic `blocked`。該当する discriminator を必ず付ける | native failure | re-plan / re-review は別 decision |

runtime / infrastructure failure は semantic `blocked` に変換しない。可能な範囲で native
run metadata と resource failure details に次を残す。classification は 8.2 の machine result
から読み、次の evidence を補助情報として bounded に保持する。

- run identity と native status
- repository `cwd`、worktree、branch/ref
- structured output / output reference の有無
- partial diff / inspection の有無
- state write / Artifact write / preflight の failure

foreground control は native `interrupted` / `stopped` と記述する。`cancelled` という
未定義 flag を追加せず、`action: "stop"` を recovery 手段として設計・記述しない。

## 12. Dispatch / concurrency boundary

`implementation` absent check は CAS ではない。`state.set` の file lock も absent check と
write を一つの atomic claim にしない。

v1 の operating precondition は次のとおりである。

- one owner session
- one Implementation dispatch per Mission
- cross-process concurrent dispatch は support しない
- shared checkout に別 writer がいない
- package-owned runtime が trusted である

同一 process/session 内で duplicate invocation を package 内の ephemeral `Set<missionId>`
などで防ぐことは許可する。ただしその guard は process restart で消え、durable SOT、atomic
claim、cross-process lock ではない。guard の状態を Mission state に複製しない。

cross-process exclusive claim / lock manager は deferred である。absent check が競合を
検出できないことを隠れた guarantee としない。

## 13. Explicit recovery

automatic recovery engine は作らない。ただし Plan Review 承認後、Implementation 開始前の
session/process interruption から same Mission を継続するため、次の explicit recovery
entrypoint を v1 に追加する。

```text
/wf-resume <missionId>
```

`/wf-resume` は owner が明示的に実行する command であり、new Mission を作らない。native
Mission の `missionId` に named resource を attachment し、pi-subagents の native Mission
lifecycle が既存 Mission を active に戻す動作を使う。

v1 が support する resume case は最低限、次のすべてを満たす場合だけである。

- `planReview.status === "approved"`
- approved `planReview.decisionSnapshot` が存在する
- `decisionSnapshot` が canonical schema / semantic / byte validator に通る
- approved binding の `planRef` / `reviewId` が valid である
- `implementation` state が absent

この場合、`/wf-resume` は次の package-owned dispatch と同等の一回だけの Implementation
attachment を行う。

```js
subagent({
  workflow: "pi-workflow.implementation",
  args: { operation: "run" },
  missionId,
  async: false,
  isolation: "none",
  chatProgress: "off",
});
```

top-level `planningDecision` は execution context の source にしない。state に残っている
場合は canonical state invariant を検証し、mismatch / malformed state は fail closed にする。

次は v1 の resume case ではない。

- `implementation.status === "running"` の automatic resume / retry
- `implementation.status === "blocked"` の automatic resume / retry
- `implementation.status === "failed"` の automatic resume / retry
- partial mutation 後の WorkUnit 単位 retry
-別 worker への re-dispatch
- native run metadata からの推測による state repair

これらは owner decision または later recovery design に送る。

## 14. TUI / Web projection boundary

Implementation Runtime v1 では TUI/Web を実装しない。維持するのは machine-readable
observability constraint だけである。

- state は bounded JSON contract である
- `ImplementationResultV1` は structured output である
- worker prose や Main natural-language parsing を machine state にしない
- native Mission/run metadata が run identity/status の source of truth である
- future TUI/Web は package state、native Mission/run metadata、Artifact references から
  projection できる

v1 で定義しないもの:

- live phase event の schema / delivery
- restart / resume 後の phase reconstruction
- `setWidget` / `setStatus` の ownership / lifecycle
- custom TUI component、Web server、WebSocket、SSE

## 15. Cutover

本設計を承認しても、cutover は別の同一 change として行う。Implementation runtime を
有効化する change では、次を同時に更新する必要がある。

- `src/commands/workflow.ts`
- `skills/pi-workflow/SKILL.md`
- `docs/pi-workflow-basic-design.md`
- `docs/pi-workflow-implementation-spec.md`
- `docs/pi-workflow-roadmap.md`
- implementation resource registration / script
- state / planning / implementation contracts
- tests

この同一 change に含める runtime contract は次である。

- `pi-workflow.implementation` named resource の registration / bounded resolver
- `agents/implementation-worker.md` の package Agent definition と discovery
- `ImplementationEnvelopeV1` と `ImplementationResultV1Schema`
- canonical PlanningDecision validator の single-mode invariants
- `prepare-review` の `decisionSnapshot` binding と `record-review` deep-equals check
- public launch preflight gate
- fixed clean check と全 terminal outcome の package-owned Git inspection
- exact path `writeScope` validator / post-run conformance
- blocked handoff、native result handling、`needs_decision` mapping
- `/wf-resume <missionId>` の supported recovery case

Implementation runtime assets がすべて成立するまで、旧 Planning MVP の次の文言を残す。

```text
Stop after the approved Plan; do not start Implementation, Verification, or Code Review.
```

Plan approval 直後の `mission.close(completed)` も、次のすべてが同じ cutover change に成立
するまで残す。

- resource registration / script
- package Agent discovery / public preflight gate
- state / planning / implementation contracts
- worker result / preflight / inspection behavior
- Main dispatch / blocked handling / `/wf-resume`
- tests と package/public documentation

partial cutover を禁止する。特に docs だけ先に Implementation を supported と書く、または
`workflow.ts` の kickoff guard だけを外す変更は行わない。lock manager、sandbox、worktree
manager、TUI/Web、Verification、Review、parallel lanes、automatic recovery は cutover の
不足を埋めるために追加しない。

## 16. Review findings disposition

2 回目の Design Review findings は、指定された四つの disposition のいずれかで追跡する。
P1-3 / P1-4 の hard guarantee を v1 の新規機構で実装しないことを明示する。

| ID | Finding / concern | Disposition | 本設計での扱い |
| --- | --- | --- | --- |
| P1-1 | Plan approval binding が Artifact digest に依存し、Human-approved Plan と execution contract の binding が不明確 | **RESOLVED BY DESIGN** | digest/token を削除し、`prepare-review` の bounded `decisionSnapshot`、`record-review` の current `planRef` と deep-equals、approved `planReview` を execution contract とする。 |
| P1-2 | Implementation worker の identity、package Agent file、default reads、tool / completion contract | **RESOLVED BY DESIGN** | `agents/implementation-worker.md` を package Agent として追加予定。`pi-workflow.implementation-worker`、exact allowlist、`reads:false`、package source/path/shadowing の public preflight gate、documented user/project settings の exact target-key absence gate、package file の `completionGuard:false` を定義し、runtime registration と digest decode は使わない。 |
| P1-3 | shared checkout に cross-process lock / concurrent-writer hard guarantee がない | **ACCEPTED V1 LIMITATION** | trusted local operator、one owner session、one dispatch、別 writer がいない operating precondition を support boundary にする。clean check は lock と表現せず、lock manager / sandbox / worktree manager は v1 に追加しない。 |
| P1-4 | `writeScope`、OS/filesystem sandbox、symlink / checkout 外 / ignored file / malicious Artifact-state tampering に対する hard guarantee | **ACCEPTED V1 LIMITATION** | exact path を approved edit boundary / post-run conformance boundary として使うが、security sandbox や tamper resistance とは主張しない。P1-3/P1-4 の hard guarantee は future managed-worktree design に deferred する。 |
| P1-5 | Planning semantic validation が Implementation 固有 validator に分裂し、dependency / path invariant が不足 | **RESOLVED BY DESIGN** | canonical `PlanningDecisionV1` validator に unique ID、existing dependency、self / duplicate / earlier-only dependency、cycle impossible、exact path contract を追加し、Plan Review 前と entry で再利用する。 |
| P1-6 | Implementation state が oversized / progress duplicate / run metadata duplicate になり、phase write が atomic と誤解される | **ACCEPTED V1 LIMITATION** | normative `ImplementationEnvelopeV1` を binding、status、bounded blockers だけにし、runId/status は native metadata に残す。`state.set` は key atomic だが multi-key transaction ではなく、ordering と `recovery-required` を定義する。 |
| P1-7 | absent check が CAS でなく duplicate dispatch / cross-process claim を保証できない | **ACCEPTED V1 LIMITATION** | absent check は operating precondition と明記する。同一 process/session の ephemeral guard は許可するが durable SOT としない。cross-process claim / lock は deferred。 |
| P1-8 | interruption 後の recovery、running/blocked/failed retry、native Mission lifecycle の責任境界 | **RESOLVED BY DESIGN** | automatic recovery/retry を作らず、approved binding + valid snapshot + implementation absent だけを `/wf-resume <missionId>` で support する。native Mission status と logical phase を分離し、独自 lifecycle engine を作らない。 |
| P1-9 | worker result、file-only output、structured output envelope、全 terminal inspection、cutover が不明確 | **RESOLVED BY DESIGN** | bounded `ImplementationResultV1Schema`、explicit unique output path、unwrapped `structuredOutput`、one-element `runs.all` の failure collection、completed/blocked/interrupted/stopped/timeout/runtime failure 全ての可能な inspection、同一 change の cutover list を定義する。 |
| P2-1 | TUI phase events / restart reconstruction | **DEFERRED** | Implementation Runtime v1 では実装せず、machine-readable state/result/native metadata だけを維持する。 |
| P2-2 | Web/TUI projection、operational observability surface | **DEFERRED** | custom TUI、Web、live event、`setWidget` / `setStatus` lifecycle は dogfood 後の別 design decision とする。 |

追加の既存 review theme は上表に次のように含まれる。

- file-only output: P1-2 / P1-9 の explicit `output` binding
- completion guard: P1-2 の package file の declared `completionGuard: false`、target-Agent override absence gate、structured result / scope の個別検証
- builtin `worker` の `defaultReads`: P1-2 の package Agent + explicit `reads:false`
- native Mission `completed`: P1-8 の native/logical separation
- forbidden Git operation: P1-2 / P1-4 / P1-9 の no-bash worker と fixed read-only inspection
- structured output availability / wrapper: P1-2 / P1-9 の 0.67.0 public contract

### 16.1 Latest blocking findings

最新 Design Review の対象 blocking finding は次のとおりである。

| Finding | Disposition | Evidence |
| --- | --- | --- |
| effective implementation Agent contract / runtime Agent preflight mismatch | **RESOLVED BY DESIGN** | `agents/implementation-worker.md` を既存 `pi.subagents.agents: ["./agents"]` で discover し、resolved name/source/path を固定する。public `resolveSubagentLaunchContract()` の file-discovered snapshot、`shadowedCandidates`、fresh/replace/inheritance/exact tools を entry gate で fail closed に検証し、documented user/project settings の exact target-key presence も別の host-side absence gate で reject する。`completionGuard` は独立 preflight field とせず、package file の declared `false` と override absence の組み合わせで保証する。definitionDigest は decode しない。 |
| failure classification not machine-readable | **RESOLVED BY DESIGN** | exactly one config-object item の `runs.all` failure collection から得る `WorkflowScriptChildResult` の実在 fields、nested `SingleResult` の `interrupted` / `stopped` / `timedOut`、`terminalOutcome`、enum の `blockKind` / `failureKind`、status invariants、Main action mapping、判定不能時の `UNRESOLVED` fail-closed を定義した。自然言語 error/prose parsing は不要である。 |

### 16.2 Remaining true blockers

最新 review に対する **UNRESOLVED な design blocker はない**。ただし、次は実装・cutover
前の true delivery blocker として残る。

- 現在の supported runtime は Planning MVP であり、Implementation runtime assets は未実装である。
- `src/commands/workflow.ts`、Skill、basic/spec/roadmap、resource/script、contracts、tests
  を同一 cutover change で更新する必要がある。
- hard isolation が必要な環境では shared-checkout v1 を support できず、future
  managed-worktree design が必要である。

これらは本設計の UNRESOLVED finding ではなく、明示した implementation boundary / deferred
work である。

---

本書は Implementation Runtime v1 の Design Review へ再提出するための SOT である。承認・
実装・cutover が完了するまで current supported runtime の仕様を変更しない。
