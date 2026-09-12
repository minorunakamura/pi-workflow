# pi-workflow Implementation Runtime v1 Implementation Specification

> **Status: normative implementation specification**
>
> 本書は、承認済みの
> `docs/pi-workflow-implementation-runtime-v1-design.md` を現在の codebase に
> 実装するための仕様である。Design Review の結果は確定しており、本書は design を
> 再設計しない。
>
> 本変更では本書だけを作成する。コード、runtime、Skill、test、README、
> `package.json`、`pnpm-lock.yaml` は変更しない。

## 0. Normative language and source of truth

本書の `MUST` / `MUST NOT` は実装上の必須条件、`SHOULD` / `SHOULD NOT` は
既存 codebase の実装規約である。

優先順位は次のとおりとする。

1. `docs/pi-workflow-implementation-runtime-v1-design.md`
2. 本書
3. 現在の実装と public contract の接続確認

接続確認対象は次のとおりである。

- `docs/pi-workflow-basic-design.md`
- `docs/pi-workflow-implementation-spec.md`
- `docs/pi-workflow-roadmap.md`
- `skills/pi-workflow/SKILL.md`
- `skills/pi-planning/SKILL.md`
- `agents/researcher.md`
- `src/commands/workflow.ts`
- `src/core/state/contracts.ts`
- `src/core/planning/planning-decision-schema.ts`
- `src/core/planning/planning-decision.ts`
- `src/core/phases/args.ts`
- `src/core/phases/definitions.ts`
- `src/runtime/workflow-resources.ts`
- `workflow-scripts/planning.js`
- `tests/`
- `package.json`
- `pnpm-lock.yaml`

External contract の実装根拠は、現在 install されている次の version と、それに対応する
public source/docs とする。

- `pi-subagents` `0.67.0`
- `@earendil-works/pi-coding-agent` `0.85.1`

`pi-subagents/src/...` や Pi の private runtime API を package runtime から import
してはならない。public API の field が確認できない場合は推測せず、実装前に
`BLOCKED / UNRESOLVED` と報告する。

## 1. Scope

### 1.1 Included

Implementation Runtime v1 の一つの cutover change に次を含める。

- same-Mission Planning → Implementation continuation
- approved `planReview.decisionSnapshot` binding
- canonical `PlanningDecisionV1` validation 強化
- `phase = "implementation"`
- `ImplementationEnvelopeV1`
- `ImplementationResultV1`
- package Agent `pi-workflow.implementation-worker`
- effective Agent precondition
- clean checkout entry gate
- named resource `pi-workflow.implementation` 一つ
- worker 一つ
- config-object の one-element `runs.all` 一回
- 一つの worker 内で WorkUnit を array order で sequential に処理
- machine-readable terminal classification
- `writeScope` conformance inspection
- limited `/wf-resume <missionId>`
- Planning-MVP terminal policy から Implementation terminal policy への atomic cutover
- deterministic tests
- cutover に必要な docs / Skill 更新

### 1.2 Excluded

次は本 change に含めない。

- formal Verification
- Verification Fix
- automated Review
- Ponytail
- Human Code Review
- parallel workers / `runs.lanes` runtime
- managed worktree
- lock manager
- OS sandbox
- automatic retry
- partial Implementation automatic recovery
- TUI
- Web monitoring
- deployment / release
- commit / push / tag / PR
- stash / reset / checkout / revert
- branch operation

`focusedVerificationIds` と `finalVerificationIds` は approved decision に保持するが、
Implementation worker は command を実行せず、検証済みとは記録しない。

### 1.3 Supported execution model

v1 の support boundary は design と同じである。

- trusted local operator
- trusted `pi-workflow` / `pi-subagents` runtime
- one interactive owner session
- one Implementation dispatch per Mission
- one active writer
- one shared checkout
- `isolation: "none"`
- managed worktree なし
- cross-process lock なし
- 別の Pi、session、editor、automation、process が同じ checkout に書き込まない

clean check と `writeScope` は hard security boundary ではなく、execution gate / conformance
check である。OS isolation、malicious extension protection、concurrent writer safety、
symlink escape protection、ignored file の完全な観測、Artifact/state tamper resistance は
保証しない。

## 2. Current codebase への接続

### 2.1 Current flow

現在の `src/commands/workflow.ts` は `/wf-feature`、`/wf-bug`、`/wf-chore`、
`/wf-hotfix` を登録し、Main Session に kickoff message を送るだけである。Mission の
作成、resource dispatch、Plan Review、close は `skills/pi-workflow/SKILL.md` の Main
policy が担当する。

現在の named resource は次の三つである。

```text
pi-workflow.discovery
pi-workflow.research
pi-workflow.planning
```

現在は次で終了する。

```text
Plan Review approved
  → mission.close(completed)
  → STOP
```

cutover 後は次になる。

```text
Plan Review approved
  → pi-workflow.implementation
  → one implementation-worker
  → Implementation terminal result
  → completed の場合だけ mission.close(completed)
```

`src/index.ts` は registration-only のまま維持し、Implementation Agent gate の登録を
registration call として追加する。`src/core` は Pi adapter / command / runtime bridge に
依存しない。

### 2.2 Exact file impact: New

Implementation 時に追加する新規ファイルは次のとおりとする。

| File | Responsibility |
| --- | --- |
| `agents/implementation-worker.md` | package-owned writer Agent の frontmatter と normative worker prompt |
| `workflow-scripts/implementation.js` | same-Mission state gate、one-element `runs.all`、terminal inspection、classification、state handoff |
| `workflow-scripts/planning-validation.js` | Planning と Implementation が共有する sandbox 用 canonical Planning validation template。別 ruleset は持たない |
| `runtime/implementation-git-inspection.mjs` | package-owned、引数なし、read-only Git status helper |
| `src/core/implementation/implementation-contract.ts` | `ImplementationEnvelopeV1` / `ImplementationResultV1` の schema、type、bounds、semantic validator |
| `src/runtime/implementation-agent-gate.ts` | host-side target override absence gate、public preflight、effective Agent contract gate、blocked-result projection |
| `tests/core/implementation-contract.test.ts` | Implementation contract の deterministic schema / bounds / legal combinations |
| `tests/runtime/implementation-agent-gate.test.ts` | Agent discovery / shadow / override / effective contract の isolated tests |
| `tests/runtime/implementation-inspection.test.ts` | temporary Git repository に対する helper と path comparison の deterministic tests |
| `tests/workflow-scripts/implementation-resource.test.ts` | VM 上の Implementation resource、worker count、state/write/classification tests |
| `tests/contract/implementation-runtime-contract.test.ts` | Agent、resource、script、cutover の source/package contract tests |

`workflow-scripts/planning-validation.js` は新しい semantic policy ではない。sandbox に
TypeScript module を import できない現在の workflow-script boundary のため、core の
canonical validator と同一の rules を一箇所から Planning / Implementation script に
embed するための source template である。Planning 専用と Implementation 専用に同じ
rule を別実装してはならない。

### 2.3 Exact file impact: Modify

#### Runtime / core

| File | Required change |
| --- | --- |
| `src/index.ts` | `registerImplementationAgentGate(pi)` を registration-only entry point に追加 |
| `src/commands/workflow.ts` | approved Plan 後の continuation kickoff 更新、`/wf-resume` 登録 |
| `src/core/phases/args.ts` | `implementation` phase args と `ImplementationArgsV1` を追加 |
| `src/core/phases/definitions.ts` | Implementation resource の foreground / output policy を既存 policy に追加 |
| `src/core/state/contracts.ts` | `phase`、`planReview.decisionSnapshot`、`implementation` state、cross-key invariants、new bound |
| `src/core/planning/planning-decision-schema.ts` | 構造 schema の shape は変更しない。path rule は canonical semantic validation に置くため、通常は file modification 不要 |
| `src/core/planning/planning-decision.ts` | duplicate dependency、earlier-only dependency、exact path `writeScope` を canonical validator に追加 |
| `src/runtime/workflow-resources.ts` | fourth named resource、implementation script expansion、unique worker output、fixed host grants |
| `workflow-scripts/planning.js` | shared validation template の利用、Plan Review snapshot binding、deep-equals、replan binding 更新 |

#### Documentation / Skill

| File | Required cutover change |
| --- | --- |
| `docs/pi-workflow-basic-design.md` | current supported flow を Implementation terminal まで更新 |
| `docs/pi-workflow-implementation-spec.md` | current implementation の normative runtime spec に更新 |
| `docs/pi-workflow-roadmap.md` | Implementation Runtime v1 を Current に移し、Implementation を Deferred から除外 |
| `skills/pi-workflow/SKILL.md` | Plan approval 後の Implementation dispatch、machine result、resume policy に更新 |
| `skills/pi-planning/SKILL.md` | Planning runtime は `single` を生成し、ordered dependency / exact path を守るよう更新 |

`docs/pi-workflow-implementation-runtime-v1-design.md` は design evidence として保持し、
実装時にも書き換えない。

#### Existing tests to modify

| File | Required change |
| --- | --- |
| `tests/commands/workflow.test.ts` | `wf-resume` の登録、exact-one-id parsing、usage、new kickoff を追加 |
| `tests/runtime/entry-point.test.ts` | `wf-resume` と `tool_call` / `tool_result` gate registration を反映 |
| `tests/runtime/workflow-resources.test.ts` | resource count 4、Implementation args / host grants / worker script contract を追加 |
| `tests/workflow-scripts/planning-resource.test.ts` | snapshot の required shape、record-review deep-equals、round/replan transition を更新 |
| `tests/core/planning-decision.test.ts` | ordering、duplicate dependency、invalid path、lanes retained を追加 |
| `tests/core/plan-review-binding.test.ts` | snapshot required、status combination、new total bound を更新 |
| `tests/core/bounds.test.ts` | state key、snapshot、Implementation bounds を反映 |
| `tests/core/bounded-contracts.test.ts` | `implementation` resource args と state envelope を反映 |
| `tests/core/planning-args-v2.test.ts` | existing Planning args regression を維持し、Implementation operation を追加 |
| `tests/contract/architecture-contract.test.ts` | package Agent が二つになったこと、new host layer の boundary を反映 |
| `tests/contract/mission-lifecycle-contract.test.ts` | `implementation` phase、Implementation terminal policy を反映 |
| `tests/contract/planning-flow-contract.test.ts` | Plan approval が immediate close ではなく dispatch に続くことを反映 |
| `tests/contract/package-contract.test.ts` | new Agent / scripts が package contents に含まれることを反映 |
| `tests/contract/pi-subagents-compatibility.test.ts` | public preflight / result fields の versioned compatibility assertions を補強 |
| `tests/packed/package-resources.test.ts` | new Agent、workflow script、Git helper、shared validation asset を archive に確認 |

`tests/contract/research-agent-contract.test.ts` など Research 固有 tests は、Implementation
cutover に無関係な範囲を変更しない。

### 2.4 Files that do not need modification

`package.json` は既存の次の package manifest により追加 asset をすでに収容する。

```json
{
  "files": [
    "src",
    "runtime",
    "workflow-scripts",
    "skills",
    "agents",
    "README.md"
  ],
  "pi": {
    "subagents": { "agents": ["./agents"] }
  }
}
```

したがって `package.json` は変更しない。`pnpm-lock.yaml` も変更しない。新しい npm
dependency、runner、Plannotator package、verification package は追加しない。

`README.md` は今回の要求どおり変更しない。Implementation cutover documentation は
指定された docs と Skill に限定する。

## 3. Canonical PlanningDecisionV1 validation

### 3.1 Ownership

`src/core/planning/planning-decision.ts` の `validatePlanningDecision()` を唯一の
canonical Planning semantic validator とする。

同じ validator の意味を使う場所は次のとおりである。

- Planning reviewer result の resource boundary
- Plan Artifact を生成する前
- `validatePlanningDecisionForApproval()`
- `prepare-review`
- `record-review` の transition 前
- Mission state の `planningDecision` read validation
- Mission state の `planReview.decisionSnapshot` read validation
- Implementation entry gate

Implementation 専用の Planning semantic validator、dependency graph validator、path
validator を別に作ってはならない。sandbox script では
`workflow-scripts/planning-validation.js` の一つの embedded fragment を両 resource が使う。

### 3.2 Structural schema

`PlanningDecisionSchema` の field shape は維持する。

- `implementation.mode` は `single | lanes`
- `implementation.workUnits` は 1..`MAX_PLANNING_WORK_UNITS`
- `writeScope` は array
- `lanes` は schema から削除しない

schema の `Type.String` bounds では code unit と UTF-8 byte の差を完全に判定できない
ため、既存の `boundedIssues()` と serialized JSON bound を継続して併用する。

### 3.3 Semantic invariants

すべての mode で次を検証する。

- acceptance criterion IDs are unique
- verification IDs are unique
- WorkUnit IDs are unique
- unresolved decision IDs are unique
- WorkUnit の `writeScope` は少なくとも一つ
- WorkUnit の `acceptanceCriteriaIds` は定義済み ID のみ
- WorkUnit の `focusedVerificationIds` は定義済み ID のみ
- `finalVerificationIds` は定義済み verification ID のみ
- dependency target は同じ decision の WorkUnit ID として存在する
- self dependency はない
- 同じ WorkUnit の `dependsOn` に同じ ID を二度入れない
- `writeScope` の各 entry は exact path grammar に適合する
- 既存の UTF-8、array count、serialized JSON、JSON depth、
  `additionalProperties: false` bound を満たす

`mode = "single"` ではさらに次を検証する。

- dependency は同じ array の earlier WorkUnit だけを参照する
- `dependsOn` の target index は current WorkUnit index より小さい
- earlier-only rule により cycle は発生しない
- cycle detection 用の別 state、topological re-sort、graph normalization は作らない

`mode = "lanes"` は schema 上維持する。既存の意味どおり lane WorkUnit に dependency を
持たせない validation は維持する。Planning runtime の current capability は `single`
だけを生成し、Implementation v1 は valid な `lanes` であっても fail closed する。
`lanes` を `single` に変換してはならない。

### 3.4 Dependency validation order

WorkUnit array を original order のまま一度走査し、先に `id -> index` map を作る。
各 `dependsOn` entry に対して次の順で issue を作る。

1. target が map にない場合: unknown dependency
2. target が current WorkUnit ID と同じ場合: self dependency
3. 同じ `dependsOn` 内で既出の場合: duplicate dependency
4. `mode = "single"` で target index が current index 以上の場合: later dependency

一つの不正 entry に対する複数 issue の扱いは既存 validator の issue collection 方針に
従うが、unknown ID を index として推測してはならない。

### 3.5 Exact writeScope path grammar

v1 は glob を導入しない。`writeScope` entry は repository root からの exact file path
だけである。

各 entry は次をすべて満たす。

- repository-relative
- canonical separator は `/`
- non-empty
- component が empty でない
- `.` component がない
- `..` component がない
- trailing `/` がない
- leading `/` がない
- Windows drive prefix（例: `C:`）がない
- backslash `\\` がない
- NUL、ASCII control character、DEL がない
- `*`、`?`、`[`、`]`、`{`、`}` がない
- directory prefix、directory marker、pattern として解釈されない
- まだ存在しない file path は許可する
- UTF-8 byte length は `MAX_PLANNING_COMMAND_BYTES` 以下

実装は component 単位の機械判定を使う。`fs.stat` で file の存在を要求してはならない。
path grammar は Plan Review 前と Implementation entry で同じ結果になる必要がある。
symlink の real target、checkout 外 escape、ignored file の観測はこの parser の責任に
しない。

### 3.6 Planning runtime generation policy

`workflow-scripts/planning.js` の reviewer context と `skills/pi-planning/SKILL.md` は、
current supported capability として次を明示する。

- Planning result の `implementation.mode` は `single` にする
- WorkUnit array order は integration order であり、resource が re-sort しない
- dependencies は earlier WorkUnit の ID だけを使う
- no dependency は `dependsOn: []`
- `writeScope` は exact canonical path のみ
- `lanes` は schema compatibility のため存在するが v1 runtime では選ばない
- machine-verifiable technical uncertainty は `unresolvedDecisions` に入れない

reviewer が `lanes` を返した場合に Planning resource が `single` に書き換えない。
canonical validator を通過する lane decision は validation 上保持できるが、Implementation
entry で `unsupported_mode` として reject する。

## 4. Plan Review binding

### 4.1 PlanReviewBindingV1 shape

`PlanReviewBindingSchema` を次に変更する。

```ts
type PlanReviewBindingV1 = {
  version: 1;
  status: "pending" | "approved" | "rejected";
  round: 1 | 2 | 3;
  planRef: ReferenceValue;
  decisionSnapshot: PlanningDecisionV1;
  reviewId?: ReferenceValue;
  feedbackRef?: ReferenceValue;
};
```

`decisionSnapshot` は全 status で required である。snapshot は別の縮約 schema、Plan
Markdown、digest、token ではない。

全 binding は `additionalProperties: false` とする。

| status | Required | Forbidden |
| --- | --- | --- |
| `pending` | `version`, `status`, `round`, `planRef`, `decisionSnapshot` | `reviewId`, `feedbackRef` |
| `approved` | pending の全 field + `reviewId` | `feedbackRef` |
| `rejected` | pending の全 field + `reviewId`, non-empty `feedbackRef` | なし（上記以外の property） |

`decisionSnapshot` は `validatePlanningDecisionForApproval()` を通過しなければならない。
したがって pending / approved / rejected binding に unresolved Human decision を保存しない。

### 4.2 Bounds

既存の `MAX_PLAN_REVIEW_BINDING_BYTES = 8 KiB` は snapshot を収容できないため、
Implementation cutover と同じ change で次の derived bound に置き換える。

```text
MAX_PLAN_REVIEW_BINDING_BYTES
  = MAX_PLANNING_DECISION_BYTES
  + 3 * MAX_REFERENCE_BYTES
  + 1 KiB
  = 32,768 + 6,144 + 1,024
  = 39,936 bytes
```

実装では existing export name `MAX_PLAN_REVIEW_BINDING_BYTES` を維持し、値を 39,936 に
する。別名を増やして二つの bound を併存させない。

- `decisionSnapshot` の serialized JSON: `MAX_PLANNING_DECISION_BYTES`（32 KiB）以下
- `planRef` / `reviewId` / `feedbackRef`: existing `ReferenceValue` bound 以下
- binding 全体: 39,936 serialized UTF-8 bytes 以下
- JSON depth: `MAX_JSON_DEPTH` 以下
- Mission state 全体: `MAX_MISSION_STATE_BYTES`（256 KiB）以下

reference は existing `validateReferenceValue()` の semantics と bound を再利用する。

### 4.3 prepare-review

`prepare-review` は zero-child state operation とする。入力は current resource args
contract のまま、Main は `planRef` と `round` だけを渡す。

operation は次の順で行う。

1. same-Mission state を全 key read する。
2. state schema / byte bound を検証する。
3. current `planRef` が supplied `planRef` と一致することを検証する。
4. current `planningDecision` が存在し、canonical validator と approval validator を
   通過することを検証する。
5. round relationship を検証する。
6. current `planningDecision` の bounded deep copy を作り、`decisionSnapshot` とする。
7. pending binding を作る。
8. state を検証してから、必要な key を write する。

round relationship は次のとおりである。

- round 1: current Plan の `planReview` が absent の場合だけ新しい pending を作る
- round 2 / 3: current state の previous `planReview` が `rejected` で、
  `previous.round === round - 1`、`previous.reviewId`、`previous.feedbackRef` が存在する
- current round の pending binding がすでに同じ `planRef` / `round` で存在する場合は、
  snapshot を再生成せず idempotent に扱い、phase を `plan-review` にする
- approved binding、stale round、別 `planRef`、不完全 pending binding は reject する

pending binding の exact shape は次のとおりである。

```yaml
planReview:
  version: 1
  status: pending
  round: 1..3
  planRef: <current planRef>
  decisionSnapshot: <current validated PlanningDecisionV1>
  # reviewId absent
  # feedbackRef absent
```

Plannotator の `reviewId` は pending state に保存しない。Main が bridge から受け取った
`reviewId` は `record-review` に渡す。したがって `review-status` は pending binding の
存在を表示できるが、pending binding の review recovery identity を作らない。

### 4.4 record-review

`record-review` は terminal transition を一回だけ行う。transition 前に次を順番に
検証し、一つでも失敗したら write しない。

1. current `planRef` が input `planRef` と一致する
2. `planReview` が存在する
3. binding が current `round` / `planRef` の pending binding である
4. current `planningDecision` が canonical validator と approval validator を通過する
5. pending `decisionSnapshot` が同じ canonical validator と approval validator を通過する
6. current `planningDecision` と `decisionSnapshot` が structural deep-equal である
7. input `reviewId` が valid reference である
8. `status` が `approved | rejected` である
9. rejected の場合は non-empty `feedbackRef` が valid reference である
10. approved の場合は `feedbackRef` が存在しない
11. next binding と Mission state 全体の bounds を検証する

deep equality は次の semantics である。

- object key order は無視する
- array order は意味を持ち、順番まで一致させる
- scalar value は値一致
- property の追加・欠落は不一致
- digest、JSON text 比較、key sorting による hash は使わない

approved shape:

```yaml
planReview:
  version: 1
  status: approved
  round: 1..3
  planRef: <current planRef>
  decisionSnapshot: <validated decision>
  reviewId: <opaque review id>
  # feedbackRef absent
```

rejected shape:

```yaml
planReview:
  version: 1
  status: rejected
  round: 1..3
  planRef: <current planRef>
  decisionSnapshot: <validated decision>
  reviewId: <opaque review id>
  feedbackRef: <file-backed feedback reference>
```

rejected binding の snapshot はその review round の decision として保持する。次の replan
では old snapshot を execution source にせず、new Planning round の
`decisionSnapshot` で binding を置き換える。

### 4.5 Replan relationship

Planning round 2 / 3 は次の条件をすべて満たす previous feedback だけを受け取る。

- input `round > 1`
- input `feedbackRef` が存在する
- existing `planReview.status === "rejected"`
- existing `planReview.round === input.round - 1`
- existing `planReview.reviewId` が存在する
- existing `planReview.feedbackRef === input.feedbackRef`

新しい Planning result が ready であっても、Planning operation 自体は old rejected
binding を current-round pending に書き換えない。`planRef` と `planningDecision` を更新し、
phase を `planning` にする。Main が current `prepare-review` を呼び、そこで new
`decisionSnapshot` を bind して phase を `plan-review` にする。

unresolved decision を含む replan は current-round pending binding を作らない。old rejected
binding は feedback lineage のために残すが、Implementation source として読んではならない。

## 5. Mission state

### 5.1 MissionStateV1 keys

`MissionStateSchema` の package-owned key は次のとおりとする。

```text
version
requestType
request
phase
humanDecisions
discoveryRef
discoveryMeta
researchRef
researchMeta
planRef
planningDecision
planReview
implementation
```

`runId`、native run status、session path、child result object は state key に追加しない。

### 5.2 Phase

`MissionPhaseSchema` は次の五つを許可する。

```text
discovery
research
planning
plan-review
implementation
```

native Mission status は package phase と別であり、state に複製しない。

### 5.3 ImplementationEnvelopeV1 schema

`src/core/implementation/implementation-contract.ts` に次の type / TypeBox schema を
定義する。

```ts
type ImplementationEnvelopeV1 = {
  version: 1;
  planRef: ReferenceValue;
  reviewId: ReferenceValue;
  status: "running" | "completed" | "blocked" | "failed";
  blockKind?:
    | "entry_precondition"
    | "human_decision"
    | "unsupported_mode";
  failureKind?:
    | "runtime"
    | "interrupted"
    | "conformance"
    | "state_inconsistent";
  blockers?: string[];
};
```

schema の normative rules は次のとおりである。

| Field | Rule |
| --- | --- |
| envelope | JSON object、`additionalProperties: false`、JSON depth <= `MAX_JSON_DEPTH` |
| `version` | numeric literal `1` |
| `planRef` | required、non-empty `ReferenceValue` |
| `reviewId` | required、non-empty `ReferenceValue` |
| `status` | `running`, `completed`, `blocked`, `failed` のみ |
| `blockKind` | optional、上記三つの literal のみ |
| `failureKind` | optional、上記四つの literal のみ |
| `blockers` | optional schema field、各 string non-empty、最大 8 件 |
| blocker text | 各 `MAX_REGULAR_TEXT_BYTES`（1 KiB）UTF-8 bytes 以下 |
| serialized envelope | `MAX_IMPLEMENTATION_ENVELOPE_BYTES = MAX_RESOURCE_ARGS_BYTES = 16 KiB` 以下 |

reference の byte semantics は existing `validateReferenceValue()` を使用する。enum
literal の最大 UTF-8 byte は `entry_precondition` の 18 bytes、failure enum は
`state_inconsistent` の 17 bytes である。enum は有限集合なので arbitrary string を
accept しない。

### 5.4 Envelope legal combinations

schema validation 後に `validateImplementationEnvelope()` が次を検証する。

| status | Required fields | Forbidden / permitted optional fields |
| --- | --- | --- |
| `running` | `version`, `planRef`, `reviewId`, `status` | `blockKind`, `failureKind`, `blockers` はすべて absent |
| `completed` | `version`, `planRef`, `reviewId`, `status` | `blockKind` / `failureKind` absent。`blockers` は absent または empty array |
| `blocked` | running の required fields + `blockKind` + non-empty `blockers` | `failureKind` absent |
| `failed` | running の required fields + `failureKind` + non-empty `blockers` | `blockKind` absent |

次はすべて illegal である。

- unknown status / discriminator
- `blockKind` と `failureKind` の同時存在
- running に blockers を付けること
- completed に discriminator を付けること
- blocked で `blockKind` を欠くこと
- failed で `failureKind` を欠くこと
- blocked / failed の empty blockers
- blockers の item count / UTF-8 / serialized bound 超過
- unknown property

`blockers` は display/evidence metadata であり、transcript、Plan body、diff、runId、
status object、session path を入れない。Main は blockers の prose を parse しない。

### 5.5 Cross-key state invariants

`validateMissionState()` に既存 nested validation と別の package semantic issues を追加し、
次を fail closed にする。

- `implementation` が存在する場合、`planReview.status === "approved"` である
- `implementation.planRef === planReview.planRef`
- `implementation.reviewId === planReview.reviewId`
- approved `planReview.decisionSnapshot` が存在し、approval validator を通過する
- `phase === "implementation"` の場合、`implementation` が存在する
- `implementation.status` が `running | completed | failed` の場合、phase は `implementation`
- `implementation.status === "blocked"` かつ `blockKind` が `entry_precondition` または
  `unsupported_mode` の場合、phase は `plan-review`
- `implementation.status === "blocked"` かつ `blockKind === "human_decision"` の場合、
  phase は `implementation`
- `implementation` が存在して phase が `discovery | research | planning` の状態は invalid

`planning` phase 中の old rejected `planReview` は replan lineage のために current
`planRef` と一致しないことがある。この transition を generic state validator が stale
binding として誤拒否しないよう、rejected binding の current-round replacement は
`planning.js` の round-aware operation で検証する。approved binding と pending current
binding の transition は必ず current `planRef` と一致させる。

generic state validator は top-level `planningDecision` が存在する場合に canonical
validation を行うが、Implementation の execution source はそれを使わない。approved
snapshot と current top-level decision の equality は `record-review` で保証し、entry では
snapshot を唯一の execution source とする。

### 5.6 State write ordering and non-atomicity

`state.set` は key 単位の file lock と merge を行うが、multi-key CAS / transaction ではない。
Implementation は次の順序を MUST とする。

1. state、approved binding、snapshot、mode、WorkUnit、writeScope、existing state を検証する
2. clean check 成功後に `state.set("implementation", runningEnvelope)` を行う
3. 2 が成功した後に `state.set("phase", "implementation")` を行う
4. 2 と 3 の両 write が成功してから worker を起動する
5. worker が terminal になったら、result に関係なく可能な範囲で Git inspection を行う
6. inspection と result を classification し、terminal envelope を
   `state.set("implementation", terminalEnvelope)` する

次の状態を自動修復してはならない。

- `implementation=running` と `phase=plan-review` の組み合わせ
- `phase=implementation` と `implementation` 欠落
- terminal envelope と phase の不一致
- terminal state write failed 後の running state
- process interruption 後の incomplete state

2 と 3 の間で interruption / write failure が起きた場合、worker は起動しない。
3 の後に launch が失敗しても retry しない。terminal state の write が失敗した場合は
success とせず、existing state を owner の recovery evidence として残す。

invalid / impossible persisted state は `failed / state_inconsistent` として扱う。ただし
状態を上書きして valid に見せてはならない。valid envelope を保存できない場合は
bounded out-of-band fail-closed handoff にとどめる。

## 6. Implementation contract args and named resource

### 6.1 Public args

`src/core/phases/args.ts` に `ImplementationArgsSchema` を追加する。

```json
{
  "operation": "run"
}
```

`operation` は required literal `"run"` とする。schema は
`additionalProperties: false`。`planRef`、Plan body、PlanningDecision body、WorkUnit
body、`workflowScript`、`workflowScriptPath`、`output`、`outputSchema`、`task` は public
args に存在してはならない。

`RESOURCE_ARGS_PHASES` と `ResourceArgsSchemas` に `implementation` を追加する。
resource args 全体は既存の `MAX_RESOURCE_ARGS_BYTES`、JSON depth、plain JSON bound を
再利用する。

### 6.2 Named resource registration

`src/runtime/workflow-resources.ts` の resource list は canonical order で次の四つにする。

```text
pi-workflow.discovery
pi-workflow.research
pi-workflow.planning
pi-workflow.implementation
```

resource version は既存と同じ `1`。Implementation definition の `resolve()` は同期で
bounded validation と string construction だけを行う。

`resolveImplementation()` は次を行う。

- `validateResourceArgs("implementation", args)` を使う
- `operation === "run"` 以外を reject する
- unique nonce を生成する
- package-owned worker output path を生成する
- package-owned fixed Git helper command を生成する
- implementation script template を入力 schema / bounds / paths とともに展開する
- `hostCommands` に固定 key/command pairs を付ける

resource resolver は state、Mission、Agent discovery、Git、Pi ctx、settings を読まない。
それらは resource script または host-side gate の責任であり、sync resolver に押し込まない。

### 6.3 Main dispatch contract

cutover 後、`/wf-*` approval path と `/wf-resume` が使用できる public dispatch は次だけ
とする。

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

Main は次を渡してはならない。

- `planRef`
- `planningDecision`
- Plan body / Plan Markdown
- WorkUnit body
- Main transcript
- `workflowScript`
- `workflowScriptPath`
- caller-owned output path
- caller-owned output schema
- caller-owned worker Agent
- `worktree: true`
- `resume`

`missionId` は native Mission の attachment target であり、Implementation state の
authority は同じ Mission の package state である。

## 7. Package Agent

### 7.1 Exact Agent file

`agents/implementation-worker.md` の frontmatter は次とする。

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
```

次を frontmatter に置いてはならない。

- `defaultReads`
- `defaultReads: false`
- `skills`
- `subagentOnlyExtensions`
- `defaultAsync`
- `subagent` / `subagent_supervisor`
- MCP tool
- third-party extension path

空の `extensions:` は ambient extension を無効にする explicit declaration である。

Discovery 後の identity は次でなければならない。

```text
agent.name        = pi-workflow.implementation-worker
agent.localName   = implementation-worker
agent.packageName = pi-workflow
agent.source      = package
agent.filePath    = <pi-workflow package root>/agents/implementation-worker.md
```

runtime Agent registration event / process-local Agent registry は使用しない。
既存 `package.json` の `pi.subagents.agents: ["./agents"]` による package Agent discovery
だけを使用する。

### 7.2 Exact caller-facing tools

declared builtin tools の順序と集合は次に固定する。

```text
read, grep, find, ls, edit, write, contact_supervisor
```

`outputSchema` により pi-subagents が追加する `structured_output` は package-owned internal
protocol tool であり、Agent frontmatter の declared tools ではない。

effective allowlist は次でなければならない。

```text
read, grep, find, ls, edit, write, contact_supervisor, structured_output
```

worker は次を持たない。

- `bash`
- `powershell`
- `subagent`
- `subagent_supervisor`
- shell execution
- arbitrary MCP tool
- ambient extension tool
- caller-owned Skill

### 7.3 Normative worker responsibility

Agent body は少なくとも次を明記する。

- approved `planReview.decisionSnapshot` だけを実装する
- supplied WorkUnit を array order で処理する
- dependency graph を再ソートしない
- approved `writeScope` を勝手に拡張しない
- scope 外 file を編集しない
- material Human/product/architecture/policy/risk-acceptance decision を推測しない
- 安全に継続できない場合は `contact_supervisor` に escalation する
- 継続不能なら `ImplementationResultV1` の `verdict: "blocked"` を返す
- Git operation を行わない
- commit / push / tag / PR / stash / reset / checkout / revert を行わない
- test / typecheck / lint / build の shell command を実行しない
- verification command を実行済みと主張しない
- final machine result は `structured_output` で返す
- `structured_output` の root は `{ "value": <ImplementationResultV1> }`

worker は main transcript、Plan Markdown、top-level `planningDecision` を受け取らない。

## 8. Effective Agent precondition and host gate

### 8.1 Owner and location

`src/runtime/implementation-agent-gate.ts` が package-owned host-side gate を担当する。
`src/index.ts` は次の順序でこれを登録する。

```ts
registerCommands(pi);
registerTools(pi);
registerImplementationAgentGate(pi);
registerWorkflowResourceLifecycle(pi);
```

gate は `pi.on("tool_call", ...)` と `pi.on("tool_result", ...)` の public Pi
Extension API を使用する。`src/runtime` から `pi-subagents/src/...` を import しない。

named resource `resolve()` は sync sandbox expansion であり、host API、settings、Agent
preflight を実行できない。この制約を無視して workflow script に preflight を書かない。

### 8.2 Interception target

`tool_call` handler は `event.toolName === "subagent"` かつ
`event.input.workflow === "pi-workflow.implementation"` の call だけを対象にする。
通常の direct child、Discovery、Research、Planning、control operation は変更しない。

Implementation call は package-owned dispatch shape を満たさなければならない。
少なくとも次を確認する。

- `workflow` は exact canonical name
- `args` は exact `{ operation: "run" }`
- `missionId` は non-empty bounded string
- `cwd` は non-empty path
- `async === false`
- `isolation === "none"`
- `chatProgress === "off"`
- caller-owned script / direct Agent / body / path / schema field がない

不正な public shape は `blocked / entry_precondition` とする。worker は起動しない。

### 8.3 Override absence gate

preflight の前に、user / project settings の target Agent override absence を検査する。
この検査は field value を安全判定しない。target key が存在するだけで reject する。

target key は canonical runtime name のみである。

```text
pi-workflow.implementation-worker
```

`implementation-worker`、alias、prose、frontmatter local name は match key としない。

#### Settings root

- user settings: Pi public `getAgentDir()` が返す directory の `settings.json`
- `PI_CODING_AGENT_DIR` がある場合は Pi の public resolution に従う
- 未設定の場合は Pi 0.85.1 の documented default（通常 `~/.pi/agent`）
- project settings: dispatch `cwd` に対する pi-subagents 0.67.0 documented project-root
  resolution と同じ nearest / `projectRootResolution: "git-root"` 規則
- project settings file: resolved project root の Pi `CONFIG_DIR_NAME` 配下の
  `settings.json`（standard Pi では `<project-root>/.pi/settings.json`）
- project root が存在しない場合、project settings source は absent として扱える

project-root resolution は package が private pi-subagents function を呼び出すのではなく、
Pi public `CONFIG_DIR_NAME` と documented rule を用いた package-owned host helper とする。
`projectRootResolution` の値が不正、root resolution が不可能、settings source が読めない
場合は absence と推測しない。

#### Keys

各 valid settings JSON について、値を解釈せず own property のみを検査する。

```text
subagents.agentOverrides["pi-workflow.implementation-worker"]
```

`agentOverridesByProvider` が存在する場合は、provider bucket を全て対象にする。

```text
subagents.agentOverridesByProvider[<provider>]
  ["pi-workflow.implementation-worker"]
```

どちらか一方の scope、またはどの provider bucket でも target key が存在すれば、value が
次のいずれであっても reject する。

- empty object
- invalid override
- `completionGuard: true`
- `completionGuard: false`
- unknown fields
- null-like value

これは override field の部分的な安全判定ではなく、v1 の全面禁止である。

次の場合は `UNRESOLVED` fail closed とする。

- settings file の read failure
- JSON parse failure
- resolved settings container を機械的に確認できない
- `subagents` が存在するが object ではない
- `agentOverrides` が存在するが object ではない
- `agentOverridesByProvider` が存在するが object ではない
- provider bucket が object ではない

file が存在せず、Pi の documented root が正常に確認できた場合は valid absence である。
`subagents` がない valid JSON も valid absence である。

### 8.4 Public resolveSubagentLaunchContract

override absence gate 通過後、次の public API だけを呼ぶ。

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
  parentSessionFile: ctx.sessionManager.getSessionFile() ?? null,
  parentLeafId: ctx.sessionManager.getLeafId() ?? null,
});
```

preflight は side-effect-free でなければならない。child session、run、Mission state、
second state store、structured-output runtime、output file を作らない。

`resolveSubagentLaunchContract()` の次の public output を検証する。

| Contract field | Exact expected value / rule |
| --- | --- |
| `contract.agent.name` | `pi-workflow.implementation-worker` |
| `contract.agent.localName` | `implementation-worker` |
| `contract.agent.packageName` | `pi-workflow` |
| `contract.agent.source` | `package` |
| `contract.agent.filePath` | package-owned Agent file の canonical path と一致 |
| `contract.agent.shadowedCandidates` | matching `user` / `project` candidate が一つもない |
| `contract.context` | `fresh` |
| `contract.systemPromptMode` | `replace` |
| `contract.inheritProjectContext` | `false` |
| `contract.inheritGlobalContext` | `false` |
| `contract.inheritSkills` | `false` |
| `contract.skills.requested` | empty |
| `contract.skills.resolved` | empty |
| `contract.skills.missing` | empty |
| `contract.tools.requestedBuiltin` | exact declared builtin allowlist |
| `contract.tools.declaredBuiltin` | `read, grep, find, ls, edit, write, contact_supervisor` |
| `contract.tools.effectiveAllowlist` | declared allowlist + `structured_output` のみ |
| `contract.tools.requiredChildTools` | `read, grep, find, ls, edit, write, structured_output` |
| `contract.tools.internalTools` | `structured_output` のみ |
| `contract.tools.mcp` | empty |
| `contract.tools.effectiveMcpTools` | empty |
| `contract.tools.toolExtensionPaths` | empty |
| `contract.tools.configuredExtensions` | empty |
| `contract.tools.runtimeExtensions` | pi-subagents 0.67.0 の child protocol runtime extension のみ |
| `contract.tools.extensionArgs` | runtime extension set と同じ。third-party path なし |
| `contract.tools.disableAmbientExtensions` | `true` |
| `contract.tools.fanoutAuthorized` | `false` |

`runtimeExtensions` は current 0.67.0 public result の field として扱う。実装時は
runtime extension の expected path を、同じ installed `pi-subagents/preflight` package root
から canonical に解決し、v0.67.0 source の
`src/runs/shared/subagent-prompt-runtime.ts` だけを許可する。`fast`、fanout、permission
system、MCP、third-party extension が effective になった場合は reject する。

`definitionProjectionVersion`、`definitionDigest`、`contract.digest`、
`launchContractDigest` は identity evidence として保持できるが、decode、recompute、
private `projectAgentDefinition()` の再実装、field の推測に使わない。

`completionGuard: false` は public `SubagentLaunchContract` の独立 field として推測しない。
次の組み合わせで保証する。

1. package Agent file に `completionGuard: false` が declared されていることを package-owned
   file check で確認する
2. target Agent override が user / project のどの scope にもないことを確認する
3. public preflight で selected Agent、source、path、tools、extensions、context、inheritance
   が exact contract と一致することを確認する

package Agent file check は frontmatter の exact required line と forbidden `defaultReads`
field の存在を確認し、private parser を再実装しない。

### 8.5 Gate result and tool hooks

host gate は `tool_call` で失敗した場合、Pi public contract に従い次を返す。

```ts
{
  block: true,
  terminate: true,
  reason: "pi-workflow implementation dispatch was blocked by the package gate"
}
```

`reason` の prose は classification authority ではない。

`tool_call` handler は `toolCallId` ごとに ephemeral な bounded map を保持し、blocked
machine observation を記録する。Pi 0.85.1 public Agent core は blocked tool call を error
tool result として emit するため、`tool_result` handler で existing details を保持したまま
次の package-owned machine projection を `details.implementationGate` に追加する。

```json
{
  "version": 1,
  "outcome": "blocked",
  "blockKind": "entry_precondition",
  "blockers": ["unsupported worker override"]
}
```

preflight infrastructure error は次の形にする。

```json
{
  "version": 1,
  "outcome": "failed",
  "failureKind": "runtime",
  "blockers": ["public Agent preflight unavailable"]
}
```

settings root を確認できない場合は次の out-of-band observation とする。

```json
{
  "version": 1,
  "outcome": "unresolved",
  "blockers": ["worker override absence could not be established"]
}
```

これは Mission state の `ImplementationEnvelopeV1` ではない。approved binding の
`planRef` / `reviewId` を package state から読んでいない pre-binding observation であり、
state に保存しない。field は `additionalProperties: false`、最大 8 blockers、各 1 KiB、
serialized 16 KiB 以下にする。Main は `details.implementationGate.outcome` と
`blockKind` / `failureKind` だけを読む。

`tool_result` hook が machine projection を保存できない場合は success とせず、out-of-band
`UNRESOLVED` evidence とする。ephemeral map は session shutdown で破棄し、Mission state に
複製しない。

### 8.6 No private fallback

次をしてはならない。

- `discoverAgentSnapshot()` の direct import
- runtime Agent registration API
- `Symbol.for` registry lookup
- `globalThis` registry lookup
- `pi-subagents/src/...` import
- opaque digest の decode
- digest から frontmatter の推測
- `error` prose から missing field の推測
- Agent override value を安全値だけ許可する partial filter

public preflight が `ok: false` の場合は entry precondition blocked。public preflight が
throw / unavailable で machine observation すら作れない場合は `UNRESOLVED` fail closed
または bounded `failed/runtime` とし、worker を起動しない。

## 9. Implementation resource entry gate

### 9.1 End-to-end gate order

logical gate order は次のとおりである。

1. Mission / package state validation
2. approved Plan Review binding validation
3. approved `decisionSnapshot` canonical validation
4. `implementation.mode === "single"` validation
5. existing implementation state / re-dispatch rule validation
6. worker effective Agent gate（host-side override absence + public preflight）
7. clean working tree check
8. `implementation=running` state transition
9. `phase=implementation` state transition
10. one worker launch

item 6 は workflow sandbox から実行できないため、public named-resource execution を
admit する host-side `tool_call` gate として resource script より前に実行する。resource
script は item 1–5、7–10 を package-owned template で再確認する。どの item が fail しても
worker は起動しない。

### 9.2 State validation

Implementation script は `stateKeys` を使って same-Mission state の全 key を read する。

最初に次を reject する。

- state file が読めない
- invalid JSON
- unknown state key
- version mismatch
- phase mismatch
- invalid top-level `planningDecision`
- invalid `planReview`
- invalid `implementation`
- Mission state aggregate bound 超過
- impossible cross-key combination

この時点で worker、clean check、post-run inspection は実行しない。

### 9.3 Approved binding validation

Implementation source は次だけである。

```text
planReview.status === "approved"
planReview.decisionSnapshot
```

entry gate は次を要求する。

- current top-level `planRef` が存在する
- `planReview.planRef === current planRef`
- `planReview.reviewId` が存在する
- `planReview.decisionSnapshot` が存在する
- snapshot が canonical schema / semantic / byte / approval validation を通過する
- current phase が `plan-review`
- top-level `planningDecision` が存在する場合は canonical validation を通過する
- top-level decision を execution source にしない

current top-level `planningDecision` が存在する場合も、worker task の source にはしない。
approved snapshot が execution authority であり、top-level value の検証結果や差分から別の
execution contract を推測しない。record-review 前の current decision / snapshot deep-equals
check が Plan Review transition の binding guarantee である。worker task は常に snapshot
からだけ構築し、digest は使わない。

### 9.4 Mode and existing state

- `mode === "single"` のみ通過
- `mode === "lanes"` は変換せず `blocked / unsupported_mode`
- `implementation` が absent の場合だけ初回 dispatch の候補
- valid `implementation` が `running | blocked | failed | completed` の場合は再 dispatch
  せず `blocked / entry_precondition` の out-of-band handoff とする
- existing state を削除、上書き、running への戻し、terminal state の再利用はしない
- malformed / impossible existing state は `failed / state_inconsistent`
- `/wf-resume` も `implementation` absent の場合だけ resource dispatch を許可する

### 9.5 Clean checkout entry check

entry gate は fixed package-owned Git helper を `runs.host` で一回呼ぶ。

```js
await runs.host("implementation-clean-check", {
  kind: "command",
  command: fixedImplementationGitInspectionCommand,
  timeoutMs: 120000,
  role: "gate"
});
```

command、flags、cwd、environment selector は caller から受け取らない。
`runs.host` の command authority は named resource が発行した exact key/command pair だけ
である。helper は workflow cwd で動く。

- valid result `status: "clean"`, `paths: []`, `truncated: false` のみ通過
- valid result `status: "dirty"` は `blocked / entry_precondition`
- helper command failure、invalid output、Git root 解決不能は clean を推測しない
- clean inspection infrastructure failure は machine handoff を返せる場合
  `failed / runtime` とする
- dirty result が truncated でも dirty を理由に entry blocked とする
- clean result が truncated / unknown なら通過させない

clean check は lock ではない。check と worker first write の間に concurrent writer が
存在しないことは operating precondition であり、check が race を防ぐとは記述しない。

## 10. Implementation workflow script

### 10.1 Input owned by resource

`buildImplementationWorkflowScript()` は次だけを embed する。

- `implementationEnvelopeSchema`
- `implementationResultSchema`
- `missionStateSchema`
- `stateKeys`
- existing bounds と Implementation bounds
- unique worker output path
- fixed clean-check command
- fixed post-run inspection command
- shared `planning-validation.js` source

Main args、Plan body、top-level decision body は embed しない。

### 10.2 Approved execution context

worker task は `planReview.decisionSnapshot` から package-owned builder が構築する。
Main transcript、Plan Markdown、top-level `planningDecision` の再解釈を使わない。

bounded context は少なくとも次を original array order で含む。

- `requestSummary`
- `scope.inScope`
- `scope.outOfScope`
- constraints
- risks
- `implementation.mode`（必ず `single`）
- 全 WorkUnit の `id`, `title`, `objective`, `dependsOn`, `writeScope`,
  `acceptanceCriteriaIds`, `focusedVerificationIds`
- acceptance criteria の bounded text
- focused verification の definition（id、description、command、timeout）
- final verification の definition 参照
- `unresolvedDecisions`（approved binding では empty）
- binding の `planRef` / `reviewId` は bounded metadata として含めてもよい

Plan Artifact Markdown の本文や Main の prose は含めない。context は snapshot value から
JSON projection として作り、snapshot 自体の array order を変更しない。

### 10.3 Worker task policy

worker task の実装責任は次とする。

- WorkUnit[0] から WorkUnit[n-1] を順に処理する
- dependency graph の topological sort をしない
- WorkUnit ごとの child run を作らない
- `runs.run` を呼ばない
- `runs.lanes` を呼ばない
- dynamic fanout をしない
- scope 外の file を追加しない
- material decision で推測せず `contact_supervisor` を使う
- structured blocked result を返す

### 10.4 Exact one-element runs.all

Implementation script は次の pattern を使う。

```js
const [worker] = await runs.all([
  {
    key: "implementation",
    agent: "pi-workflow.implementation-worker",
    context: "fresh",
    reads: false,
    progress: false,
    async: false,
    task: boundedApprovedExecutionContext,
    output: uniqueExplicitWorkerOutputPath,
    outputMode: "file-only",
    outputSchema: ImplementationResultV1Schema,
    acceptance: {
      level: "none",
      reason: "v1 does not run automated Review or Verification"
    }
  }
]);
```

normative requirements:

- `runs.all` call は一回だけ
- input array の item は一つだけ
- item key は exact `implementation`
- result は ordered array の index 0 から destructure する
- `results.implementation` のような keyed access はしない
- `runs.run` は使用しない
- dynamic array、fanout、multiple writer entries は使用しない
- `runs.lanes` は使用しない
- `runs.steer`、resume、retry、rolling retry は使用しない
- `context: "fresh"` を明示する
- `reads: false` を毎回明示する
- `outputSchema` は package-owned `ImplementationResultV1Schema`
- `outputMode: "file-only"`
- `output` は package-owned unique explicit path

one-element `runs.all` は parallel execution のためではない。0.67.0 の config-object
failure collection path で child failure を ordered `WorkflowScriptChildResult` として
受け取るために使う。

### 10.5 State transition in script

clean check が成功した後、次を行う。

```text
state.set("implementation", {
  version: 1,
  planRef,
  reviewId,
  status: "running"
})
state.set("phase", "implementation")
```

各 set の前に next state を `validateMissionState()` 相当で検証する。両方成功しない
限り worker を起動しない。

mode / dirty / duplicate など worker 前の semantic block は、approved binding の
`planRef` / `reviewId` を使用できる場合だけ valid `ImplementationEnvelopeV1` として保存する。

```yaml
implementation:
  version: 1
  planRef: <approved planRef>
  reviewId: <approved reviewId>
  status: blocked
  blockKind: entry_precondition | unsupported_mode
  blockers: [<bounded reason>]
```

phase は `plan-review` のままにする。state write が失敗した場合は blocked と偽装せず、
`failed / runtime` または bounded out-of-band evidence とする。

### 10.6 Terminal result and emit

worker result と post-run inspection を判定した後、terminal envelope を保存する。

- `completed`: terminal envelope を write し、同じ envelope を plain JSON return する
- `blocked`: terminal envelope を write し、同じ envelope を `emit()` してから fixed
  package-owned error を throw する
- `failed`: terminal envelope を write し、同じ envelope を `emit()` してから fixed
  package-owned error を throw する

non-completed で throw するのは outer workflow を native success にしないためである。
Main は `isError`、error prose、`output` を classification source にせず、
`details.workflow.emits` に保存された bounded machine handoff を読む。

`emit()` payload は plain JSON、JSON depth <= 8、serialized 16 KiB 以下とする。
`emit` failure、terminal state write failure、resource script serialization failure は
success としない。machine handoff が得られない場合は `UNRESOLVED` fail closed とする。

## 11. ImplementationResultV1

### 11.1 Exact schema

`src/core/implementation/implementation-contract.ts` に次を定義する。

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
      "items": {
        "type": "string",
        "minLength": 1,
        "maxLength": 1024
      }
    }
  },
  "required": ["version", "verdict", "blockers"],
  "additionalProperties": false
}
```

TypeBox schema の character bound に加え、validator は UTF-8 byte bound を検証する。

| Field | Rule |
| --- | --- |
| `version` | numeric literal `1` |
| `verdict` | `completed | blocked` のみ。最大 literal は 9 UTF-8 bytes |
| `blockers` | required array、最大 8 件 |
| blocker | non-empty、各 `MAX_REGULAR_TEXT_BYTES`（1 KiB）UTF-8 bytes 以下 |
| result | `additionalProperties: false` |
| result serialized JSON | `MAX_IMPLEMENTATION_RESULT_BYTES = MAX_RESOURCE_ARGS_BYTES = 16 KiB` 以下 |
| JSON depth | `MAX_JSON_DEPTH` 以下 |

semantic invariants:

- `verdict === "completed"` では `blockers` は empty array
- `verdict === "blocked"` では blockers を少なくとも一件持つ
- unknown field、wrapper、missing field、invalid byte bound は reject
- `workUnitId`、runId、Plan body、transcript、test output は追加しない

### 11.2 Structured output envelope

worker の final structured output tool invocation は exact に次の形である。

```json
{
  "value": {
    "version": 1,
    "verdict": "blocked",
    "blockers": ["approved scope だけでは安全に継続できない"]
  }
}
```

これは `structured_output` tool の input envelope である。one-element `runs.all` の
child result は wrapper を外した value を返す。

```js
worker.structuredOutput === {
  version: 1,
  verdict: "blocked",
  blockers: ["approved scope だけでは安全に継続できない"]
}
```

次は semantic blocked ではなく `failed / runtime` である。

- `structuredOutput` missing
- `structuredOutput` が `{ value: ... }` のまま
- schema-invalid value
- byte-invalid value
- `verdict: "blocked"` だが blockers empty
- `verdict: "completed"` だが blockers non-empty
- worker prose のみ
- final text を JSON として parse する必要がある状態

worker output file の final prose、`outputReference`、`outputPathMapping`、
`artifactPaths` は evidence として保持できるが、ImplementationResult の代替にしない。

## 12. Native result fields and deterministic classification

### 12.1 Actual public result shape

0.67.0 の one-element config-object `runs.all` で resource が読む child result は public
`WorkflowScriptChildResult` である。v1 が読む field は次に限定する。

```text
key
ok
output
error
interrupted
stopped
structuredOutput
terminalOutcome
results
outputReference
outputPathMapping
artifactPaths
agent
requestedContext
resolvedContext
detached
```

`timedOut` は `WorkflowScriptChildResult` の field ではない。timeout は存在する
`worker.results[0].timedOut` を読む。

`worker.results[0]` の必要な public fields は次である。

```text
interrupted
stopped
timedOut
exitCode
processSignal
error
```

`error`、`output`、`processSignal` は classification authority ではない。
この v1 path に native `cancelled` field はないため、`cancelled` を追加・推測しない。
foreground interrupt は `interrupted`、stop は `stopped` として扱う。

### 12.2 Precedence

同じ observation に複数の signal がある場合の precedence は次とする。

1. persisted state impossible / malformed → `failed / state_inconsistent`
2. target override / effective Agent gate rejection → `blocked / entry_precondition`
3. override source unavailable → `UNRESOLVED`
4. public preflight infrastructure failure → `failed / runtime` または `UNRESOLVED`
5. mode `lanes` → `blocked / unsupported_mode`
6. native interrupted / stopped → `failed / interrupted`
7. native timeout → `failed / runtime`
8. other worker transport / structured result failure → `failed / runtime`
9. valid worker semantic verdict と post-run conformance を判定
10. conformance violation / unknown は valid worker semantic verdict より優先
11. valid completed + conformance success → `completed`

post-run inspection は worker の `completed` / `blocked` semantic verdict より優先する。
ただし native `interrupted` / `stopped` は既に native transport interruption として分類し、
timeout は runtime timeout として分類する。ordinary runtime failure で required
inspection が実行不能な場合は conformance failure evidence を優先し、conformance を
establish できない failure として扱う。

### 12.3 Mapping table

| Observation | Machine result |
| --- | --- |
| user/project direct override target key exists | `status: "blocked"`, `blockKind: "entry_precondition"` |
| provider-scoped target override key exists | `status: "blocked"`, `blockKind: "entry_precondition"` |
| settings source / container cannot be inspected | out-of-band `UNRESOLVED`; no new envelope discriminator |
| preflight returns `ok: false` | `blocked / entry_precondition` |
| selected Agent source/path/shadow/tools/context mismatch | `blocked / entry_precondition` |
| public preflight throws / unavailable but bounded handoff possible | `failed / runtime` |
| public preflight throws and no handoff can be returned | `UNRESOLVED` |
| valid current state has `mode: "lanes"` | `blocked / unsupported_mode` |
| dirty working tree before worker | `blocked / entry_precondition` |
| clean helper cannot establish clean tree | `failed / runtime`; worker not started |
| existing valid Implementation state is present | `blocked / entry_precondition` out-of-band; no write/re-dispatch |
| malformed / impossible persisted state | `failed / state_inconsistent`; worker not started |
| `worker.ok === true`, schema-valid result, `verdict: "blocked"` | `blocked / human_decision` |
| `worker.interrupted === true` | `failed / interrupted` |
| `worker.stopped === true` | `failed / interrupted` |
| `worker.results[0].interrupted === true` | `failed / interrupted` |
| `worker.results[0].stopped === true` | `failed / interrupted` |
| `worker.results[0].timedOut === true` | `failed / runtime` |
| `worker.terminalOutcome === { state: "partial", reason: "timeout" }` | `failed / runtime` |
| `worker.ok === false` without interruption/timeout | `failed / runtime` |
| `worker.results[0]` absent while child is `ok: false` | `failed / runtime` |
| structured result missing / invalid / wrapper-shaped | `failed / runtime` |
| `terminalOutcome.reason === "budget_exhausted"` without another native interruption | ordinary `failed / runtime` |
| valid worker verdict plus scope-outside path | `failed / conformance` |
| valid worker verdict plus inspection failure/truncation/unknown | `failed / conformance` |
| valid completed verdict plus inspection success | `status: "completed"` |

`worker.ok === true` だけでは completion ではない。structured result と conformance が
必要である。`worker.ok === false` だけでは human decision blocked ではない。

### 12.4 Resource abort without child classification

resource 自体が abort され、child result が返らない場合は、利用可能な native structured
fields だけを使う。

- native `WorkflowReceipt.state === "stopped"` または child/native `stopped: true` が
  observed: `failed / interrupted`
- `SingleResult.timedOut === true`、または native `terminalOutcome` が
  `{ state: "partial", reason: "timeout" }`: `failed / runtime`
- `state: "paused"` / detached
- generic `state: "failed"` だけ
- `isError` だけ
- prose / error text だけ
- `processSignal` だけ
- receipt / result 不在

上記の後半は classification 不可能なため `UNRESOLVED` fail closed とする。新しい
`cancelled`、`unknown`、`recovered` などの Implementation enum を追加しない。persisted
`running` state を自動で別 status に変換せず、automatic retry / resume / redispatch を
しない。

### 12.5 Main action mapping

Main が読む machine result と action の関係は次だけである。

| Machine result | Main action |
| --- | --- |
| `status: "completed"`、discriminator なし、state / binding / inspection valid | `mission.close(completed)` |
| `status: "blocked"` + valid `blockKind` | `mission.update({ status: "needs_decision" })`。retry / redispatch なし |
| `status: "failed"` + valid `failureKind` | status / failureKind を machine-readable に報告。自動 `needs_decision` 変換なし |
| persisted `running` / inconsistent / `UNRESOLVED` | state repair / retry / redispatch / close なし。owner に evidence を報告 |

Main は次を classification に使わない。

- outer `isError`
- `error`
- `output`
- `message`
- worker prose
- exception text
- human-readable status text

`blockKind` / `failureKind` が unknown なら machine result 自体を invalid とし、推測せず
`UNRESOLVED` にする。

## 13. Git inspection and writeScope conformance

### 13.1 Fixed host helper

`runtime/implementation-git-inspection.mjs` は package-owned finite helper とする。
caller から shell command、argument、path、cwd を受け取らない。

named resource の fixed command は次の形式で生成する。

```text
node '<package-root>/runtime/implementation-git-inspection.mjs'
```

`src/runtime/workflow-resources.ts` の `shellQuote()` を既存実装として再利用し、caller
text を command に連結しない。helper 自体は `child_process.execFileSync` 相当の shell
なし Git invocation を使う。

helper が実行する Git command は固定である。

```text
git rev-parse --show-toplevel
git status --porcelain=v1 -z --untracked-files=all
```

helper は workflow cwd を process cwd として使用する。`git -C` に caller path を渡さない。

### 13.2 Helper output

helper の stdout は machine JSON 一つだけとする。

```json
{
  "version": 1,
  "status": "clean",
  "paths": [],
  "truncated": false
}
```

```json
{
  "version": 1,
  "status": "dirty",
  "paths": ["src/a.ts", "src/b.ts"],
  "truncated": false
}
```

output rules:

- `version` は `1`
- `status` は `clean | dirty`
- `paths` は required array
- `truncated` は required boolean
- `clean` なら paths は empty
- `dirty` なら paths は一つ以上、ただし truncated 時は partial/empty evidence を許可
- helper output は plain JSON、unknown property なし
- host stdout preview cap（現行 4 KiB）に達する前に、helper-owned
  `MAX_INSPECTION_OUTPUT_BYTES = 3,072` を超える path inventory は
  `truncated: true` として返す
- truncated payload を scope success として扱わない

Git command failure、invalid UTF-8、invalid status record、root failure は non-zero exit
とする。error prose を正常 JSON に混ぜない。

### 13.3 Porcelain parser

`--porcelain=v1 -z` の NUL record を parser input とする。

- ordinary tracked modification / deletion / untracked: `XY path\0`
- rename / copy: new endpoint と old endpoint の二つの NUL-separated path を読む
- rename / copy は old endpoint と new endpoint の両方を paths に入れる
- deletion は削除された path を入れる
- untracked は通常の path として入れる
- unmerged など Git が返す visible path も path inventory に入れる
- quoted human output、`git status` prose、line splitting は使わない

各 path は repository root relative の canonical `/` form にする。

- absolute path、Windows drive prefix、NUL、control character は reject
- empty component、`.`、`..`、trailing separator は reject
- Git の endpoint を flatten し、重複を除く
- sort は deterministic な default lexical order
- comparison 前に `writeScope` と同じ canonical path parser を通す

入力 path を黙って安全な別 path に rewrite してはならない。normalization 不能なら
inspection unknown として conformance failure にする。

### 13.4 Inspection invocation policy

worker terminal outcome が次のいずれでも、可能な範囲で post-run helper を呼ぶ。

- `completed`
- semantic `blocked`
- native `interrupted`
- native `stopped`
- timeout
- ordinary runtime/tool failure
- structured result missing
- launch result failure

script は worker launch を `try/finally` 相当で囲み、child result が missing でも post-run
inspection を試みる。resource 自体の hard abort で script が継続不能な場合は、available
native evidence だけを使い、変更なしと推測しない。

post-run call:

```js
await runs.host("implementation-post-run-inspection", {
  kind: "command",
  command: fixedImplementationGitInspectionCommand,
  timeoutMs: 120000,
  role: "gate"
});
```

resource の `hostCommands` は次の exact pairs を持つ。

```text
implementation-clean-check       → fixed helper command
implementation-post-run-inspection → fixed helper command
```

host command key は unique で、script 内でも一回ずつだけ使う。`runs.host` の output path
は package-owned host output に任せ、caller path を受け取らない。

### 13.5 Scope union and comparison

approved boundary は全 WorkUnit の `writeScope` の set union である。WorkUnit ごとの
runtime physical enforcement は作らない。

比較は次の deterministic operation とする。

1. snapshot の全 WorkUnit の `writeScope` を canonical path として再検証する
2. exact string set union を作る
3. Git helper output の paths を canonicalize、dedupe、sort する
4. actual path 一つずつが approved union に exact match するか確認する
5. outside path が一つでもあれば scope violation
6. approved path が変更されなかったことは violation ではない
7. rename / copy は両 endpoint を比較する
8. new file は path が approved なら許可する
9. deletion は path が approved なら許可する

`writeScope` は hard sandbox ではない。worker が `edit` / `write` の誤った path を使うこと、
symlink escape、checkout 外 write、別 process の concurrent mutation、ignored file は
完全には防げない。rollback、reset、stash、revert、cleanup を inspection failure の後に
自動実行しない。

### 13.6 Inspection failure

次は conformance を establish できない。

- helper command non-zero
- Git root unavailable
- invalid helper JSON
- invalid path
- `truncated: true`
- host result stdout が incomplete / unparseable
- helper timeout
- output save failure
- scope absent / malformed / unknown

worker の valid semantic verdict が `completed` または `blocked` でも、上記は
`failed / conformance` とする。partial mutation は残し、bounded evidence だけを report
する。state envelope の blockers に raw diff、transcript、runId、session path を入れない。

## 14. `/wf-resume <missionId>`

### 14.1 Command registration and parsing

`src/commands/workflow.ts` に新しい command `wf-resume` を追加する。

- args を trim する
- non-empty の exactly one token だけを受け付ける
- empty / multiple token / whitespace を含む malformed invocation は usage error
- usage は `Usage: /wf-resume <missionId>`
- usage error では `pi.sendUserMessage` を呼ばない
- command handler は Mission、state、resource を直接操作しない
- new Mission を作らない
- native Mission status を直接変えない

valid input は Main Session に次の責務を伝える bounded kickoff message にする。

- given `missionId` を existing Mission として扱う
- current project の Mission であることを確認する
- approved Plan Review binding と snapshot を確認する
- Implementation state が absent の場合だけ one-time Implementation dispatch を行う
- `running | blocked | failed | completed` state は自動 resume / retry しない
- malformed / inconsistent state は redispatch しない
- successful Implementation completed の場合だけ close する

### 14.2 Main responsibility

Main は `/wf-resume` kickoff 後に次を行う。

1. `mission.show` を current project cwd で呼ぶ
2. Mission exists を machine details で確認する
3. `mission.projectRoot` と current resolved project root を比較する
4. 別 project、missing、malformed mission は named resource を呼ばず停止する
5. same Mission ID の approved Plan Review continuation だけを許可する
6. exact public dispatch contract で `pi-workflow.implementation` を foreground attachment する

Main は Mission state file を直接読むための second state API を作らない。approved snapshot
validity と implementation absence は Implementation named resource の same-Mission entry
gate が authoritative に確認する。したがって Main の precheck が通っても resource gate
failure なら worker は起動しない。

### 14.3 Supported case

Implementation dispatch が許されるのは次のすべてを満たす場合だけである。

- Mission exists
- same project
- `planReview.status === "approved"`
- approved `planReview.decisionSnapshot` exists
- snapshot が canonical schema / semantic / byte / approval validation を通過する
- approved `planRef` / `reviewId` が valid
- `implementation` state が absent
- current phase が approved Plan continuation を許す `plan-review`

native Mission status が Planning workflow completion によって `completed` になっていても、
package state が上記条件を満たす場合は same-Mission Implementation attachment を許可する。
native Mission status を package phase にコピーしない。

### 14.4 Unsupported resume cases

次はすべて reject し、worker を起動しない。

- `implementation.status === "running"`
- `implementation.status === "blocked"`
- `implementation.status === "failed"`
- `implementation.status === "completed"`
- malformed `implementation`
- impossible phase/envelope combination
- non-approved Plan Review
- missing snapshot
- invalid snapshot
- stale planRef / reviewId
- missing Mission
- different project

`/wf-resume` は pi-subagents の native retained child `resume` ではない。worker の child
runId を受け取らず、新しい Implementation attachment を作る。partial Implementation
automatic recovery、WorkUnit retry、worker replacement は作らない。

## 15. Main flow and atomic cutover

### 15.1 Current policy to remove only at cutover

現在 `src/commands/workflow.ts` と `skills/pi-workflow/SKILL.md` にある次の policy は、
Implementation assets が全て成立するまで残す。

```text
Stop after the approved Plan; do not start Implementation, Verification, or Code Review.
```

同様に current Planning MVP の

```text
record-review(approved) → mission.close(completed) → STOP
```

も partial implementation 状態では削除しない。

### 15.2 Exact cutover behavior

atomic cutover 後の `/wf-*` Main sequence は次である。

```text
Discovery
  → optional Research
  → optional clarification
  → Planning
  → prepare-review
  → Human Plan Review
  → record-review(approved)
  → pi-workflow.implementation
  → entry gate
  → one fresh writer
  → terminal inspection/classification
```

Main action:

- Implementation `completed` + valid state + successful conformance:
  - `mission.close({ missionId, missionStatus: "completed" })`
  - close 失敗は success としない
- Implementation `blocked`:
  - `mission.update({ missionId, missionUpdate: { status: "needs_decision" } })`
  - automatic retry / redispatch なし
- Implementation `failed`:
  - `failureKind` を machine-readable に報告
  - `mission.close` しない
  - silent `needs_decision` 変換をしない
  - automatic retry / resume / redispatch なし
- `UNRESOLVED` / persisted running / inconsistency:
  - close、repair、retry なし
  - native evidence と bounded unresolved state を owner に報告

Plan approval 自体は completed Plan であるが、Implementation v1 では whole Mission の
completed ではない。Verification、Automated Review、Human Code Review、merge readiness、
deployment readiness を意味しない。

### 15.3 Atomic cutover set

次を一つの supported-runtime cutover change に含める。

- `src/commands/workflow.ts`
- `src/index.ts`
- `src/core/phases/args.ts`
- `src/core/phases/definitions.ts`
- `src/core/state/contracts.ts`
- `src/core/planning/planning-decision.ts`
- `src/core/implementation/implementation-contract.ts`
- `src/runtime/implementation-agent-gate.ts`
- `src/runtime/workflow-resources.ts`
- `workflow-scripts/planning-validation.js`
- `workflow-scripts/planning.js`
- `workflow-scripts/implementation.js`
- `runtime/implementation-git-inspection.mjs`
- `agents/implementation-worker.md`
- `skills/pi-workflow/SKILL.md`
- `skills/pi-planning/SKILL.md`
- `docs/pi-workflow-basic-design.md`
- `docs/pi-workflow-implementation-spec.md`
- `docs/pi-workflow-roadmap.md`
- all relevant deterministic tests

partial cutover は禁止する。特に次だけを単独で行ってはならない。

- docs だけを先に Implementation supported と書く
- `workflow.ts` の kickoff guard だけを外す
- `mission.close` だけを削除する
- resource registration だけを追加する
- Agent file だけを追加する
- effective Agent gate なしに worker を起動する
- tests なしに Plan Review binding を変更する

## 16. Deterministic tests

### 16.1 Core / schema tests

`tests/core/planning-decision.test.ts` と `tests/core/implementation-contract.test.ts` に
次を追加する。

- single mode の dependency-free WorkUnit accepts `dependsOn: []`
- earlier WorkUnit dependency accepts
- later WorkUnit dependency rejects
- unknown dependency rejects
- self dependency rejects
- duplicate dependency rejects
- WorkUnit ID duplicate rejects
- earlier-only rule により cycle traversal を必要としないことを確認
- exact `writeScope` path accepts
- empty path rejects
- absolute path rejects
- Windows drive prefix rejects
- `.` / `..` / empty component rejects
- trailing slash rejects
- backslash rejects
- control / NUL rejects
- glob characters rejects
- new file path accepts without fs existence
- invalid `writeScope` UTF-8 bound rejects
- `lanes` schema remains accepted when existing lane semantic is valid
- Planning current generation contract is `single`
- Implementation mode `lanes` is rejected as unsupported, not converted
- cross-reference IDs remain canonical
- planReview pending requires `decisionSnapshot`
- pending review forbids `reviewId` and `feedbackRef`
- approved requires `reviewId` and forbids `feedbackRef`
- rejected requires `reviewId` and `feedbackRef`
- snapshot is approval-valid and bounded
- old 8 KiB Plan Review limit is gone; 39,936-byte limit is enforced
- object key order does not affect deep equality
- array order affects deep equality
- `ImplementationEnvelopeV1` legal combinations pass
- every illegal envelope combination fails
- `ImplementationEnvelopeV1` reference / blocker / total byte bounds fail closed
- `ImplementationResultV1` exact schema and `additionalProperties:false`
- completed requires empty blockers
- blocked requires non-empty blockers
- result blocker UTF-8 bytes and total 16 KiB bounds
- JSON depth bound
- state phase/envelope cross-key combinations
- `runId` / native status / session path cannot enter envelope

### 16.2 Plan Review resource regression

`tests/workflow-scripts/planning-resource.test.ts` を更新し、次を確認する。

- `prepare-review` writes pending binding with snapshot
- no child is launched by prepare/record/review-status
- record-review checks current `planRef`
- record-review checks current decision canonical validity
- record-review checks snapshot canonical validity
- record-review checks structural deep-equals before terminal write
- changed current decision is rejected
- changed snapshot is rejected
- stale round is rejected
- approved/rejected transition is one-time
- rejected feedback remains bound to previous round
- round 2 planning keeps old rejected binding until new prepare-review
- unresolved replan does not create current pending binding
- old snapshot is not used for new implementation context

### 16.3 Agent / preflight tests

`tests/runtime/implementation-agent-gate.test.ts` は real user settings を変更してはならない。
各 case は temporary HOME、temporary `PI_CODING_AGENT_DIR`、temporary project root、
fixture `settings.json` を使う。real `~/.pi/agent/settings.json` と real project settings
を write しない。

必須 cases:

- expected package Agent accepted
- user shadow Agent rejected
- project shadow Agent rejected
- target direct user override rejected
- target direct project override rejected
- target user provider override rejected
- target project provider override rejected
- override value is not inspected for safety
- target local name does not count as matching canonical key
- changed declared tools rejected
- missing `edit` / `write` rejected
- `bash` added rejected
- `subagent` added rejected
- unexpected extension rejected
- unexpected MCP selection rejected
- runtime extension outside pi-subagents package rejected
- configured extension non-empty rejected
- `disableAmbientExtensions !== true` rejected
- fanout authorized rejected
- context mismatch rejected
- systemPromptMode mismatch rejected
- inheritProjectContext mismatch rejected
- inheritGlobalContext mismatch rejected
- inheritSkills mismatch rejected
- missing / resolved / requested Skill mismatch rejected
- package source/path mismatch rejected
- package Agent missing `completionGuard: false` rejected
- Agent file contains `defaultReads` rejected
- public preflight `ok:false` maps to entry blocked
- public preflight throw maps runtime/unresolved without worker
- malformed settings maps `UNRESOLVED`, not absence
- `tool_call` block occurs before named resource execution
- blocked `tool_result` carries machine `details.implementationGate`
- ordinary non-Implementation subagent calls are unaffected

Fixture setup must use dependency injection or module mocking for public
`resolveSubagentLaunchContract`; tests must never import private pi-subagents source.

### 16.4 Git helper / conformance tests

`tests/runtime/implementation-inspection.test.ts` は temporary Git repository を作り、
fixed helper を `execFileSync` で呼ぶ。current repository の files は変更しない。

必須 cases:

- clean checkout returns `clean`, empty paths, `truncated:false`
- tracked modification is visible
- tracked deletion is visible
- untracked new file is visible
- rename includes old and new endpoint
- copy includes source and destination endpoint
- paths are sorted and deduped
- `-z` parser does not split on newline
- malformed status output fails closed
- invalid UTF-8 fails closed
- outside / traversal path fails closed
- helper command failure fails closed
- output truncation is reported, not treated as clean
- approved scope union accepts only exact paths
- a missing approved path is allowed
- one outside path causes conformance failure
- scope failure does not rollback or mutate files
- ignored files remain the documented limitation
- symlink / checkout-external write remains accepted v1 limitation

### 16.5 Resource / workflow tests

`tests/workflow-scripts/implementation-resource.test.ts` と
`tests/runtime/workflow-resources.test.ts` で次を確認する。

- only bounded `{ operation: "run" }` args are accepted
- caller Plan body / decision / script / output path / output schema is rejected
- named resource resolves exactly once
- resource name is `pi-workflow.implementation`
- fixed host command pairs are package-owned
- worker output path is unique per resource resolution
- output path is not supplied by caller
- approved single Plan starts exactly one worker
- `runs.all` call count is exactly one
- one-element item count is exactly one
- item key is exactly `implementation`
- item Agent is exact package runtime name
- item has `context:"fresh"`
- item has `reads:false`
- item has `outputSchema`
- item has `output`
- item has `outputMode:"file-only"`
- item has no `runs.run`, `runs.lanes`, dynamic fanout, retry, or resume
- worker task contains bounded snapshot context
- worker task does not contain Plan Markdown / Main transcript
- WorkUnit order in task is unchanged
- valid worker completed result plus clean inspection completes
- valid worker blocked result maps human decision
- worker blocked result plus scope violation maps conformance
- ordinary runtime failure maps runtime
- child timeout maps runtime
- child interruption maps interrupted
- child stopped maps interrupted
- malformed structured result maps runtime
- missing structured result maps runtime
- clean tree failure starts no worker
- dirty tree starts no worker
- mode lanes starts no worker and maps unsupported mode
- duplicate dispatch starts no worker
- valid existing running/blocked/failed/completed state is not overwritten
- malformed persisted state fails state_inconsistent
- phase write failure starts no worker
- running state write failure starts no worker
- terminal state write failure never reports success
- all child terminal outcomes attempt post-run inspection
- inspection truncation / unknown maps conformance
- no runId/native result is copied into Mission envelope
- completed return is unwrapped envelope
- blocked/failed machine envelope is emitted before outer package failure

VM tests may mock `runs.all`, `runs.host`, `state.get`, and `state.set`, but must preserve the
public result shapes used by the script.

### 16.6 Resume tests

`tests/commands/workflow.test.ts` と resource/Main contract tests に次を追加する。

- approved + implementation absent succeeds
- non-approved rejected
- running rejected
- blocked rejected
- failed rejected
- completed rejected
- malformed state rejected
- missing Mission rejected
- different project rejected
- empty command args shows usage
- multiple args shows usage
- valid ID sends only Main kickoff
- command does not create Mission or directly dispatch
- resume attaches same `missionId`
- resume does not use native child `resume` parameter
- no automatic retry / state repair

### 16.7 Cutover contract tests

`tests/contract/mission-lifecycle-contract.test.ts`、
`tests/contract/planning-flow-contract.test.ts`、
`tests/contract/implementation-runtime-contract.test.ts` で次を source / deterministic
contract として固定する。

- `/wf-*` no longer closes immediately after approved Plan
- approved Plan dispatches Implementation
- Main passes only named resource and same Mission ID
- Implementation is foreground
- Implementation closes Mission only on completed
- Verification is not invoked
- automated Review is not invoked
- Human Code Review is not invoked
- old Plan Review rejection/replan behavior remains
- Planning MVP capability is not removed before Implementation assets exist
- package Agent is discovered through package manifest
- `README.md` is not required for this cutover
- `package.json` and lockfile remain unchanged unless a later package discovery proof requires it

`tests/runtime/entry-point.test.ts` は commands に次を、events に次を反映する。

```text
commands:
wf-feature, wf-bug, wf-chore, wf-hotfix, wf-resume

events:
tool_call, tool_result, session_start, session_shutdown
```

登録順に依存する test があるため、実装順を勝手に変更しない。

### 16.8 Human E2E boundary

Human browser、Plannotator UI、real provider、real interactive Plan Review は deterministic
test の必須条件にしない。Plan Review bridge の既存 contract test と machine state test
だけを必須とする。dogfood は deterministic validation 後の別 step で行う。

## 17. Validation gates

Implementation change の完了時に、次を全て実行する。

```bash
pnpm typecheck
pnpm lint
pnpm format:check
pnpm test
pnpm check
pnpm validate:native
git diff --check
```

`pnpm check` に重複する command があっても、release evidence では上記 required gate
list を個別に記録する。

必須 assertion:

- typecheck が pass
- lint が pass
- format check が pass
- deterministic test suite が pass
- existing Planning MVP regression が pass
- native smoke が extension load、resource registration、command registration を確認
- `git diff --check` が pass

新しい validation を追加する場合は、既存 `src/core/validation.ts`、TypeBox、Vitest、
plain test helper を再利用する。巨大な validator framework、独自 test framework、
second state engine は復活させない。

すべての deterministic gate 後にだけ dogfood を実行する。dogfood failure を理由に
Implementation v1 の scope を自動拡張しない。

## 18. Documentation cutover content

### 18.1 `docs/pi-workflow-basic-design.md`

次を current supported design として更新する。

- supported flow に `Plan Review → Implementation → terminal` を追加
- approved Plan 直後の immediate `mission.close` を削除
- `mission.close(completed)` は Implementation completed 後だけと明記
- native Mission status と package phase を分離したまま維持
- named resource list に `pi-workflow.implementation` を追加
- `implementation` phase と `implementation` state key を追加
- approved snapshot が execution contract であることを記載
- one worker / one-element `runs.all` / array-order WorkUnit execution を記載
- no Verification / Review / lanes / worktree / retry を記載
- shared checkout と clean/writeScope limitation を記載

### 18.2 `docs/pi-workflow-implementation-spec.md`

current code implementation reference として次を更新する。

- new file layout
- `ImplementationEnvelopeV1`
- `ImplementationResultV1`
- PlanReview snapshot binding
- canonical Planning validator
- Agent file discovery / effective preflight
- settings override absence gate
- named resource args / fixed host command
- one-element `runs.all`
- Git parser / scope union / terminal inspection
- `/wf-resume`
- Main action mapping
- test / validation gates

「current runtime は Planning MVP のみ」「Implementation は未定義」という historical
statement は削除し、未実装 design evidence への link は必要に応じて残す。

### 18.3 `docs/pi-workflow-roadmap.md`

- Current を Implementation Runtime v1 terminal までに更新
- Implementation を Deferred list から除外
- Verification、Review、parallel lanes、worktree、deployment は Deferred のまま
- design document は historical/design evidence として保持

### 18.4 `skills/pi-workflow/SKILL.md`

Main Session policy を次のように更新する。

- Plan approval 後に同じ Mission ID で named Implementation resource を call
- Main は Plan body / decision body を args にコピーしない
- exact `{ operation: "run" }` を使う
- `async:false`, `isolation:"none"`, `chatProgress:"off"`
- machine result の discriminator だけで action を決める
- completed の場合だけ close
- blocked は needs_decision、retry なし
- failed は machine failure report、silent needs_decision 変換なし
- `/wf-resume <missionId>` の supported case を明記
- running/blocked/failed/completed の automatic resume を禁止
- Verification / Review / Human Code Review を開始しない

### 18.5 `skills/pi-planning/SKILL.md`

- current runtime capability は `single`
- WorkUnit array order を preserve
- dependency は earlier ID のみ
- no dependency は `[]`
- exact file path `writeScope` のみ
- `lanes` は v1 Implementation が fail closed するため生成しない
- Plan Review approval 用 snapshot が canonical decision であることを損なわない
- existing structured output envelope を維持

## 19. Implementation order

これは release / stage 分割ではなく、一つの Implementation Runtime v1 change を安全に
構築する内部作業順である。途中状態を supported runtime として公開しない。

1. **contracts / canonical validation**
   - `ImplementationEnvelopeV1` / `ImplementationResultV1`
   - phase / state key
   - PlanReview snapshot schema
   - dependency / path invariants
   - shared Planning validation fragment
2. **Plan Review binding**
   - prepare snapshot
   - record-review current planRef / snapshot deep-equals
   - replan round relationship
   - existing Planning regression tests
3. **package Agent**
   - `agents/implementation-worker.md`
   - exact frontmatter / prompt
   - package discovery contract tests
4. **effective Agent gate**
   - settings root resolution
   - direct/provider target override absence
   - public `resolveSubagentLaunchContract()` field comparison
   - Pi `tool_call` / `tool_result` registration
5. **host inspection helper**
   - fixed read-only Git helper
   - porcelain `-z` parser
   - output bound / truncation marker
   - scope union comparison
6. **Implementation resource and script**
   - args / resolver / fixed host grants
   - unique output path
   - exact one-element `runs.all`
   - state order / terminal emit
   - result classification
7. **`/wf-resume`**
   - command parser / kickoff
   - Main same-project / same-Mission policy
   - absent-only dispatch
8. **Main cutover**
   - approved Plan no longer closes immediately
   - Implementation dispatch
   - close only completed
   - no Verification / Review
9. **docs / Skill cutover**
   - basic design
   - current implementation spec
   - roadmap
   - `pi-workflow` Skill
   - `pi-planning` Skill
10. **tests / validation**
    - deterministic tests
    - package / packed asset tests
    - typecheck, lint, format, test, native smoke, diff check
11. **dogfood**
    - deterministic gates passした後に別 step として行う

全 asset、gate、state contract、test、docs が揃う前は current Planning MVP terminal policy
を維持する。途中で `workflow.ts` だけを切り替えない。

## 20. No speculation rule

実装中に次のいずれかが起きた場合、Approved Design を変更して解決してはならない。

- `pi-subagents/preflight` に `resolveSubagentLaunchContract` がない
- returned contract に required public field がない
- Pi 0.85.1 に `tool_call` / `tool_result` public hook semantics がない
- one-element config-object `runs.all` が ordered child result を返さない
- `WorkflowScriptChildResult` / `SingleResult` の field shape が設計と異なる
- `structuredOutput` が unwrapped value でない
- `runs.host` exact authority を固定 command に bind できない
- settings root / project-root resolution を documented rule で確認できない
- package Agent discovery が `pi.subagents.agents` から成立しない

その場合の報告は次の exact format とする。

```text
BLOCKED / UNRESOLVED
- missing public contract: <field/API>
- observed version: <package/version>
- source checked: <public source path>
- worker launch: not started
- design change: not proposed
```

private API、digest decode、error prose parsing、caller-owned fallback script、interactive
shell fallback、別 runner への silent switch は許可しない。

## 21. Implementation readiness criteria

Implementation Runtime v1 の実装開始前に、次が確認済みであることを要求する。

- public `resolveSubagentLaunchContract()` の actual shape が 0.67.0 source で確認済み
- public Pi Extension `tool_call` / `tool_result` blocking semantics が 0.85.1 source で確認済み
- `WorkflowScriptChildResult` の actual `ok`, `interrupted`, `stopped`, `structuredOutput`,
  `terminalOutcome`, `results` shape が確認済み
- `SingleResult.timedOut` の actual location が確認済み
- `runs.all` config-object ordered array semantics が確認済み
- package discovery が current manifest で成立する
- no design blocker、no unresolved contract ambiguity
- implementation order と atomic cutover set が合意済み

本書作成時点では上記 external contract の接続確認は完了しており、design deviation は
ない。実装時に version drift が発生した場合だけ、No speculation rule に従って停止する。
