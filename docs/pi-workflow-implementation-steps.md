# pi-workflow 実装ステップ計画

- 対象: 新規 `pi-workflow`
- 対象architecture: `pi-subagents v0.66.0`
- 目的: 実装順序、各StepのScope、Prerequisite、Goal、Acceptance Criteriaを定義する
- 文書種別: implementation plan

## 1. Authority と文書の役割

本書は実装順序を定義する。architecture、ownership、runtime contractを独自に再定義しない。

| 優先順位 | 文書 | Authority |
|---|---|---|
| 1 | `docs/pi-workflow-basic-design.md` | architecture、ownership、設計原則 |
| 2 | `docs/pi-workflow-implementation-spec.md` | package構成、API、state/ref contract、runtime behavior |
| 3 | `docs/pi-workflow-implementation-steps.md` | 実装順序、Prerequisite、Scope、Acceptance Criteria |

本書と上位2文書に矛盾がある場合は、上位文書を優先し、本書を修正する。本書の旧記述からarchitectureを逆輸入しない。

今回のdocument migrationではproduction code、workflow script、Skill、manifest、test、dependencyを変更しない。Unit 1–5.1の7 canonical resources、Unit 5 Planning invocation compatibility、bounded `PlanningDecisionV1`、file-backed Plan Artifact、`planRef`、S2、CodeGraph Discovery policy、Unit 5.1 native validation isolationは維持する。各Acceptance Criteriaは、将来のimplementation taskで検証するまで未確認とする。

## 2. Target Architecture と全体ルール

中心architectureは次である。

```text
Main = thin Control Plane

Main
  │ workflow name + bounded args + missionId + cwd + async:false
  ▼
Named Workflow Resource
  │ resource-owned validation / workflowScript / schema / policy
  │ Mission state/ref resolution
  ▼
foreground child execution
  │
  ├─ file-backed Artifact
  ├─ native run / patch / handoff / evidence Reference
  └─ compact Mission state
```

Mainは次をtransportしない。

- raw `workflowScript`
- `outputSchema`
- full Discovery / Research / Plan / Verification / Review result
- Artifact body
- child transcript
- lane transcript
- full diff、failure evidence、arbitrary output path

通常phaseはforegroundで完了させる。background defaultに依存せず、次のすべてで `async:false` を明示する。

- Mainのnamed workflow invocation
- resource内部の `runs.run` child entry
- resource内部の `runs.all` child entry
- resource内部の `runs.lanes` stage

必要なcapability、Mission reference、Human approval、native evidenceがない場合はfail closedする。background、CLI、別runtime、別protocolへsilent switchしない。

## 3. Canonical Runtime Contract

### 3.1 Named Workflow Resources

production boundaryは次の7 resourceだけとする。`registerWorkflowResource`でcurrent sessionへ登録し、registrationが返すdisposerを`session_shutdown`で実行する。

| Phase | Canonical resource | Agent / Skill | 主な結果 |
|---|---|---|---|
| Discovery | `pi-workflow.discovery` | fresh built-in `scout` | full Discovery Artifact、`discoveryRef`、bounded `discoveryMeta` |
| Research | `pi-workflow.research` | fresh `pi-ketch.researcher`、conditional | Research Artifact、`researchRef`、bounded `researchMeta` |
| Planning | `pi-workflow.planning` | fresh built-in `reviewer` + `pi-planning` | canonical Plan Artifact、`planRef`、`PlanningDecisionV1` |
| Implementation | `pi-workflow.implementation` | fresh built-in `worker` | native run / patch / handoff refs、compact status |
| Verification | `pi-workflow.verification` | fresh built-in `reviewer` + `pi-verification` | verification Artifact / evidence ref、`VerificationStatusV1` |
| Verification Fix | `pi-workflow.verification-fix` | fresh built-in `worker` | 最大2 roundのrun / handoff refs、compact status |
| Review | `pi-workflow.review` | `reviewer` fanout + `ponytail-review` + synthesis `reviewer` | review refs、`ReviewDecisionV1` |

`pi-workflow`はcustom Agentを持たない。Planningはcustom Agentではなく、常に built-in `reviewer` + `pi-planning`とする。

`pi-workflow.planning`は次の4 operationを所有する。Named Resourceは7のままであり、8個目のPlan Review resourceは追加しない。

| Operation | Child | Purpose |
|---|---|---|
| `plan` | fresh `reviewer` + `pi-planning` | PlanningDecision / Plan Artifact / `planRef` |
| `prepare-review` | zero | current Plan Review bindingの準備・検証 |
| `record-review` | zero | compact review status/evidenceの検証・保存 |
| `review-status` | zero | compact Mission-bound recovery metadata |

operation omittedは`plan`と同値で、Unit 5の`{ "round": 1 }`を壊さない。全Main-triggered operationは`async:false`でforeground実行する。

### 3.2 Registration lifecycle

```text
session_start
  → canonical orderで7 resourceをregisterWorkflowResource
  → 全disposerを保持

session_shutdown
  → 全disposerをdispose
```

次を実装契約とする。

- resource nameはcanonical、unique、safe name constraint準拠とする。
- duplicate registrationはrejectし、既存resourceをreplace / shadowしない。
- registrationが途中で失敗した場合、先に登録したresourceをdisposeする。
- registryを直接操作せず、public `registerWorkflowResource` APIだけを使う。
- resource definition / factoryがname、version、bounded args resolver、package-owned workflowScript、schema、policyを所有する。

### 3.3 Main invocation

Mainのphase invocationは、次のbounded interfaceに限定する。

```json
{
  "workflow": "pi-workflow.discovery",
  "args": {
    "requestType": "feature",
    "request": "bounded request",
    "attempt": 1
  },
  "missionId": "<native Mission ID>",
  "cwd": "<trusted project cwd>",
  "async": false
}
```

Mainから次を指定できない。

- `agent`
- `task`
- `workflowScript`
- `workflowScriptPath`
- `outputSchema`
- `output`
- arbitrary Artifact path
- upstream report / Plan / diff / evidence body

`args`はresource-owned schemaで検証し、unknown fieldをrejectする。resource-owned workflowScriptとschemaはMain inputで上書きできない。

### 3.4 Mission State / Artifact / Reference

Mission stateはnative Missionのstate APIだけを使う。独自StateStore、run registry、patch store、WorkflowStateを作らない。

```text
Mission state hard limit: 256 KiB = 262,144 serialized UTF-8 bytes
Reference value: serialized UTF-8 bytes <= 2,048
PlanReviewBindingV1: <= 8 KiB、current Missionに1件
```

Mission stateに保存するものは次だけである。

- `discoveryRef` / `researchRef` / `planRef`
- implementation / verification / fix / reviewのnative refs
- bounded metadata、status、decision
- `PlanningDecisionV1`、`PlanReviewBindingV1`、`VerificationStatusV1`、`ReviewDecisionV1`
- Human decisionsのbounded value

保存しないものは次である。

- full Discovery / Research report
- full Plan prose
- large verification evidence
- large review prose / findings
- child transcript / lane transcript
- unbounded structured object

phase contractの要点は次のとおりとする。

| Phase | Required state | Mainが再送しないもの |
|---|---|---|
| Discovery | `discoveryRef`、bounded `discoveryMeta` | full report、transcript |
| Research | conditional `researchRef`、`researchMeta` | Discovery body、Research body |
| Planning | `planRef`、bounded `PlanningDecisionV1` | report、Plan body/path |
| Implementation | native `runId` / `implementationRef`、またはpatch/handoff refs、compact status | Plan body/path、full diff、transcript |
| Verification | `verificationRef`、`VerificationStatusV1` | evidence body、child prose |
| Verification Fix | 最大2件のrun/status/ref | failure report本文、unbounded history |
| Review | `reviewRef`、bounded `ReviewDecisionV1`、Code Review専用approval status | full findings/prose、annotation body |

Planning stateにはPlan Review専用の`planReview` binding（`status`、`round`、`planRef`、optional `reviewId` / `feedbackRef`）を置く。`feedbackRef`は同じMissionのreview round、exact `planRef`、availableな`reviewId`へこのbinding metadataで結び付ける。これは後段Code Reviewの`codeApproval`を再利用しない。Exact field shape、byte bound、semantic validationはImplementation Specificationのstate/ref contractを使用する。Mission stateは256 KiB以下で、Plan body、feedback prose、full Plannotator payload、browser/UI transcriptを保存しない。

### 3.5 S2 Structured Output policy

S2をproduction contractとする。

```text
outputMode:"file-only" + outputSchema
  → structured valueはArtifactへ保存される
  → structuredOutput全体はMain tool detailsへ露出し得る
```

したがって `file-only` はstructured outputをMainから隠す機構ではない。

- large report / evidenceは`file-only` + schemaなしでArtifact化する。
- `outputSchema`は明示的にbounded、compactで、Main detailsにfull valueが露出しても許容できるmachine control/decision dataだけに使う。
- schemaはNamed Workflow Resourceが所有し、Mainはschema objectを生成・transportしない。
- `PlanningDecisionV1`、`VerificationStatusV1`、`ReviewDecisionV1`などのaggregate boundを検証する。

### 3.6 Human Gate interface

MainはHuman authorityの唯一の所有者である。MainだけがPlan Reviewを開始する時期を決め、Plannotatorをinvoke / coordinateし、Human approval / rejection / failureを解釈し、phase advancementとre-planningを決定する。Named ResourceがMission stateを読むことはauthorityの移譲ではない。

Mainはnative Mission `state.get/state.set`へ直接アクセスしない。Mission state accessはNamed Resource workflow scriptが行う。`src/missions/*` private import、Mission filesystem path guessing、raw persistence、private registry/internal APIは使用しない。

Plan Review inputはImplementation Specificationに定義された次のsmall interfaceだけを使用する。

```ts
interface PlanReviewInput {
  missionId: string;
  round: number;       // 1..3
  planRef: string;     // bounded ReferenceValue
}
```

target sequence:

```text
Main
→ pi-workflow.planning / prepare-review
→ compact ready/pending
→ Plan Review bridge(planRef)
→ bridge resolves Plan Artifact → planContent
→ Plannotator
→ Main interprets result
→ pi-workflow.planning / record-review
```

Plan ReviewとCode Reviewは明示的 `approved: true`だけをapprovalとする。cancel、close、timeout、unavailable、error、invalid resultはapproval扱いしない。full Plan body / full feedback bodyはMain model-facing transportに入れず、bridge process memoryでfeedbackを一時処理し、package-owned Feedback Artifactとbounded `feedbackRef`へ変換する。

## 4. 実装時のTool / Skill利用方針

これは`pi-workflow` runtimeのAgent mappingとは別に、実装作業を進める際の方針である。

- `pi-subagents`: native Mission、resource、run、worktree、acceptanceを使う。代替runtimeを作らない。
- CodeGraph: 必要な場合だけ`status` → `explore`を使う。index lifecycleを自動管理しない。
- TDD: behaviorを持つcore / runtime codeに適用する。静的manifestへ機械的に適用しない。
- `pi-ketch.researcher`: repository内だけで確定できない外部仕様が必要な場合だけ使う。
- `ponytail-review`: correctnessの代替ではなく、simplicity / over-engineering reviewに使う。

| Step | pi-subagents | CodeGraph | TDD | pi-ketch.researcher | Ponytail |
|---|---|---|---|---|---|
| 1 Foundation | resource contract確認 | 必要時 | core validationで使用 | 外部contract確認時 | 最終確認 |
| 2 Planning Flow | native flow確認 | 必要時 | behavior実装で使用 | 条件付き | 最終確認 |
| 3 Single End-to-End | real runtime必須 | 必要時 | 推奨 | 条件付き | runtime review必須 |
| 4 Parallel / Lane Flow | lanes/worktree必須 | 必要時 | 推奨 | 条件付き | runtime review必須 |
| 5 Operational / Release | recovery/packed必須 | 必要時 | 必要時 | 条件付き | release review必須 |

---

# Step 1 — Foundation

## Prerequisite

なし。Step 1では上位2文書をSource of Truthとして読み、v0.66.0 target contractだけを基盤へ落とす。

## Goal

`pi-workflow`を、Mainがtrusted resourceを名前で呼び、resourceが内部でchild・schema・script・state/ref policyを所有できるpackage基盤にする。real workflow E2Eは先取りしない。

## Implementation Target

### Package contract

- `package.json`の`peerDependencies`に`pi-subagents: "0.66.0"`を置く。
- `devDependencies`にも`pi-subagents: "0.66.0"`を置く。
- `pi-subagents`を`dependencies`、`bundledDependencies`、vendored sourceへ置かない。
- `pi-workflow` + `pi-subagents 0.66.0`を同じPi package scopeで解決できる形にする。
- package manifest、Pi extension entry point、Skills、必要なresource-owned scriptsの境界を定義する。

### Extension entry point / lifecycle

- `src/index.ts`はcommand、Main-only Tool、`session_start`、`session_shutdown`のadapterに限定する。
- `session_start`でcanonical 7 resourcesを順番に登録する。
- `session_shutdown`で全disposerを呼ぶ。
- registration失敗時のrollback、duplicate reject、idempotent cleanupを実装する。
- registryを直接操作しない。

### Resource definition / factory

- 7 canonical nameを一度だけ定義する。
- phase allowlistをcanonical resource definitions / shared internal phase definitionsで保持する。
- resource definition / factoryがbounded args validationを所有する。
- resource-owned workflowScriptのconstructionを定義する。Mainへscript本文を返したり、Mainからscriptを受け取ったりしない。
- resource-owned `outputSchema`を定義する。large Artifact用schemaとcompact control data用schemaを分離する。
- child Agent / Skill、foreground policy、state/ref prerequisite、artifact policyのownershipをresource側へ置く。
- native provenance / digestが実際のconsumerに必要な場合だけnative boundaryのcontractに従う。Main-facing独自hash transportは実装しない。
- custom Agent、custom Planning Agent、Main-facing phase transport Toolを追加しない。

### Shared contracts

- Mission state hard limit `256 KiB`、Reference bound `2,048 bytes`を共通validationへ置く。
- `DiscoveryMetadataV1`、`ResearchMetadataV1`、`PlanningDecisionV1`、`VerificationStatusV1`、`ReviewDecisionV1`、implementation/fix/reference typesを実装仕様どおりに定義する。
- required state/ref、unknown field、cross-Mission ref、oversized structured valueをfail closedで扱う。
- Artifact / Referenceをbodyと混同しない型・命名を定義する。
- S2 `file-only + outputSchema` visibility ruleをcode/contractへ反映する。
- normal phase、`runs.run`、`runs.all`、`runs.lanes`の`async:false` policyをshared contractへ反映する。

### Deterministic tests

real childを起動せず、次を確認する。

- canonical resource name、version、unique性、registration/disposal contract
- duplicate registration reject
- bounded argsとunknown field rejection
- Mainからarbitrary workflowScript / outputSchemaを渡せないこと
- resource-owned workflowScript / schema ownership
- Mission key/ref shapeとsize limit
- Artifact / Reference separation
- S2 visibility policy
- package manifest dependency topology
- custom Agentが存在しないこと

## Out of Scope

- real Discovery / Research / Planning / Implementation / Verification / Review E2E
- native Missionのphase遷移実行
- Plannotator実通信
- Workerのrepository変更
- managed worktree / lane production behavior
- recovery、scope expansion、release validation

## Acceptance Criteria

```text
[ ] peerDependenciesにpi-subagents 0.66.0がある
[ ] devDependenciesにpi-subagents 0.66.0がある
[ ] pi-subagentsがdependenciesにない
[ ] pi-subagentsがbundled / vendoredされていない
[ ] 7 Named Workflow Resourcesが存在する
[ ] resource namesがcanonicalかつuniqueである
[ ] session_startが7 resourcesを登録する
[ ] session_shutdownが全resourceをdisposeする
[ ] duplicate registrationがfail closedである
[ ] bounded argsがunknown fieldをrejectする
[ ] Mainがarbitrary workflowScriptを供給できない
[ ] Mainがarbitrary outputSchemaを供給できない
[ ] workflowScriptがresource-ownedである
[ ] output schemaがresource-ownedである
[ ] async:false policyがMain / child / stage contractにencodedされている
[ ] Mission state / Reference typesがboundedである
[ ] Artifact / Reference typesが定義されている
[ ] Mission state hard limit 256 KiBが表現されている
[ ] S2 structured output ruleがcode/contractに表現されている
[ ] custom Agentがない
[ ] real workflow E2EをStep 1へ先取りしていない
```

Step 1のAcceptance Criteriaは、過去の別architectureのPASS結果ではなく、v0.66.0 contractに対して新たに確認する。

---

# Step 2 — Planning Flow

## Prerequisite

Step 1のFoundation contract、resource registration、bounded validation、state/ref contractのAcceptance Criteriaが確認済みであること。real implementation E2Eは不要だが、resource invocationのnative contractは使用可能であること。

## Goal

次のread-only flowを、1 request = 1 native Missionでapproved Planまで完成させる。

```text
/wf-feature | /wf-bug | /wf-chore | /wf-hotfix
→ active / clean-tree / capability guard
→ native Mission create
→ pi-workflow.discovery
→ discoveryRef + bounded discoveryMeta
→ conditional pi-workflow.research
→ researchRef + bounded researchMeta
→ Main-only Human clarification
→ pi-workflow.planning / plan
→ planRef + bounded PlanningDecisionV1
→ pi-workflow.planning / prepare-review
→ Main-only Plan Review bridge / Plannotator
→ pi-workflow.planning / record-review
```

MainはDiscovery、Research、Planの本文やpathをphase間でtransportしない。

## Implementation Target

- 4つの`/wf-*` commandとrequest type mapping
- active Mission guard、clean-tree guard、required capability check
- explicit native Mission create / attach
- `pi-workflow.discovery`によるfresh built-in `scout`、full Discovery Artifact、`discoveryRef`、bounded `discoveryMeta`
- Discoveryのexternal research要否判定
- `discoveryMeta.externalResearchRequired === true`の場合だけ`pi-workflow.research`を起動
- conditional `pi-ketch.researcher`、Research Artifact、`researchRef`、bounded `researchMeta`
- Main-only Human clarification。childからHumanへ直接質問しない
- `pi-workflow.planning`によるfresh built-in `reviewer` + `pi-planning`
- Planning resourceが`discoveryRef`、optional `researchRef`、bounded Human decisionsをMission stateから内部解決
- `PlanningDecisionV1`のsemantic validation、unresolved decisionのblock、size bound
- canonical Plan Artifactの生成と`planRef`保存
- Main-only Plannotator Plan Review
- exact small interfaceはImplementation Specificationの`PlanReviewInput`を引用し、full Plan / full decisionを追加しない
- `review-status` recovery
- Plan reject時のbounded re-planning。same refs/stateを使い、large resultをMainへ戻さない

### Unit 6 Plan Review architecture adjustment target

Step 2 / Unit 6 planning implementationは、既存の`pi-workflow.planning`へ次を追加する。新しいNamed Resource、Main native Mission state adapter、private Mission import、filesystem path guessingは追加しない。

1. Plan Review compact state contract / validator（`PlanReviewBindingV1`）
2. `PlanningArgs` operation discriminator（omitted operationは`plan`）
3. `prepare-review` branch
4. `record-review` branch
5. `review-status` branch
6. Plan Review bridgeの`planRef → Plan body / planContent` resolution
7. bridge-owned Feedback Artifact writer
8. 旧`planningDecision → renderPlan` Plan Review pathをremoveし、`planRef`中心のbridge pathへ移行
9. pending / start / status lifecycleとduplicate prevention
10. Main recovery / re-plan sequence
11. round + 1 Planningへのsame-Mission `feedbackRef` handoff

Expected execution:

```text
operation plan:
  fresh reviewer + pi-planning
operation prepare-review:
  zero children
operation record-review:
  zero children
operation review-status:
  zero children
```

すべてのMain-triggered resource invocationは`async:false`とする。MainはHuman authorityを保持するが、Mission stateのread/writeはResource内workflow scriptが行う。

## Plan Review Boundary

Plan Reviewへ渡すinputは次だけとする。

```ts
interface PlanReviewInput {
  missionId: string;
  round: number;       // 1..3
  planRef: string;     // bounded ReferenceValue
}
```

Target sequence:

```text
Main
→ pi-workflow.planning / prepare-review
→ zero-child compact ready/pending result
→ Main-only Plan Review bridge
→ bridge resolves planRef to Plan body / planContent
→ Plannotator start
→ `record-review(status:"pending", reviewId)`でbindingを保存
→ review-status(reviewId) / terminal result
→ Main interprets pending / approved / rejected / failure
→ pi-workflow.planning / record-review
```

Main is the sole Human authority: start timing、Plannotator coordination、response interpretation、phase advancement、re-plan decision are Main-owned. Main does not call native Mission `state.get/state.set`; Planning Resource workflow script owns Mission state access. Full `PlanningDecisionV1`、Plan body、arbitrary path、full feedback bodyはMain model-facing transportに入れない。

Plan Artifact / `planRef` ownershipは`pi-workflow.planning` Resource、`planRef`は同Resourceが生成するopaque/path-like Referenceである。pi-subagents v0.66.0では、このReferenceが特定Mission由来であることをcryptographically proveできない。SafetyはNamed Resource Mission binding、current state equality、round/reviewId checks、mismatch時のfail closedで確保する。`planRef → planContent` resolutionとFeedback Artifact writingはPlan Review bridge、Human decisionはMainとする。Current Plannotator contractは`planContent` required、`planFilePath` optional、result `{ reviewId, approved, feedback, savedPath? }`、`review-status(reviewId)`である。`savedPath`はoptionalで、`planSave` configurationに依存し、Plan/annotation snapshotであってfeedback-only Artifactではなく、Plannotator/global storageに属し、Mission/round bindingを持たないためcanonical `feedbackRef`に使わない。

`approved === true`だけをapprovalとする。`approved:false` + valid Human resultはexplicit rejectionであり、cancel / timeout / unavailable / error / malformed / approved missingはrejectionに変換しない。Feedbackはbridgeがtransient process memoryで扱い、package-owned file-backed Artifactへ書いてbounded `feedbackRef`だけを返す。

Mission-bound pending reviewがある場合はduplicate Plannotator launchを行わない。missing reviewId、incomplete binding、round mismatch、planRef mismatch、stale plan、unknown correlationはreplacement reviewを起動せずfail closed / needs-decisionとする。Plannotator startとMission state persistenceはone atomic transactionではなく、crash windowを明示的に扱う。

## Out of Scope

- source mutation、Worker implementation
- final Verification、Verification Fix
- automated Review、Review Fix
- managed worktree / `runs.lanes`
- final Code Review

## Acceptance Criteria

```text
[ ] 1 request = 1 native Missionである
[ ] active Missionがある場合、新Missionを作成しない
[ ] clean-tree guardがMission create前に実行される
[ ] required capability missingでfail closedする
[ ] Discoveryがnamed resource経由で実行される
[ ] Discovery full resultがMainを通過しない
[ ] discoveryRefがMission stateへ保存される
[ ] bounded discoveryMetaが保存される
[ ] Researchはrequiredな場合だけ実行される
[ ] Research full resultがMainを通過しない
[ ] Research実行時にresearchRefが保存される
[ ] Research未実行時はresearchMeta.status = "skipped"である
[ ] Human clarificationがMain-onlyである
[ ] Human cancel / unavailable / errorでphaseを進めない
[ ] Planningがreviewer + pi-planningでforeground実行される
[ ] Planningがupstream refsをMission stateから内部解決する
[ ] canonical PlanがArtifact-backedである
[ ] planRefが保存される
[ ] PlanningDecisionV1がsize / semantic boundを満たす
[ ] large Planning resultがMainを通過しない
[ ] unresolved decisionがPlan Reviewをblockする
[ ] Plannotatorは明示的approved:trueだけを受理する
[ ] rejected Planをrefs/state経由でre-planできる
[ ] review-statusを使ってpending reviewをrecoveryできる
[ ] `operation` omittedがUnit 5 `plan`と同値である
[ ] `prepare-review`がzero childでcurrent Mission / planRef / round / unresolvedDecisions / stale bindingを検証する
[ ] `record-review`がzero childでpending / approved / rejectedを受け、current planRef / round / reviewIdを検証する
[ ] rejected `record-review`がfeedbackRefを要求する
[ ] feedbackRefがsame-Mission review round / planRef / reviewIdへboundされる
[ ] `review-status`がzero childでcompact status / round / planRef / reviewId / feedbackRef?だけを返す
[ ] Mainがnative Mission state APIを直接呼ばない
[ ] bridgeがplanRefからPlan body / planContentを解決し、Mainへ返さない
[ ] bridgeがFeedback Artifactを書き、feedbackRefだけを返す
[ ] full feedback bodyがMain transport / Mission stateへ入らない
[ ] Plannotator savedPathをcanonical feedbackRefへ使わない
[ ] pending bindingがduplicate Plannotator launchを防ぐ
[ ] cross-Mission / cross-round / stale-plan / stale-reviewがfail closedになる
[ ] feedback write failure / cancel / error / unavailableが自動re-planへ変換されない
[ ] round 1 reject → round 2、round 2 reject → round 3となる
[ ] round 3 rejectでround 4を起動しない
[ ] Plan Review start / Mission state persistence crash windowをfail closedで扱う
[ ] source codeを変更しないread-only flowである
[ ] Step 2の全Acceptance Criteriaを新architectureで確認する
```

### Required Unit 6 test plan

```text
planning operation discriminator: operation omitted => plan
control operations: prepare-review / record-review / review-status are zero-child
prepare-review: planRef mismatch / unresolvedDecisions / round mismatch / missing or unreadable Plan Artifact / stale binding
record-review: pending / approved / rejected / missing feedbackRef / stale planRef / stale round / stale reviewId
cross-Mission isolation
bridge: Feedback Artifact / feedback write failure / Plan body excluded from Main result/state / feedback body excluded from Main result/state
review-status: pending / approved / rejected / missing reviewId => fail closed
pending duplicate review prevention
round + 1 Planning with same-Mission feedbackRef
Mission state <= 256 KiB / ReferenceValue <= 2,048 UTF-8 bytes
```

過去の旧flowがPASSしていても、named resource、Artifact、Reference、S2 contractを満たす証拠にはしない。

---

# Step 3 — Single End-to-End

## Prerequisite

Step 2のPlanning Flowが、canonical Plan Artifact、`planRef`、bounded `PlanningDecisionV1`、explicit Plan approvalまで安定して確認済みであること。

## Goal

single modeで次を完成させる。

```text
Approved Plan
→ pi-workflow.implementation
→ pi-workflow.verification
→ Verification Fix（必要時、最大2 round）
→ pi-workflow.review
→ Review Fix（必要時、最大1 wave）
→ Main-only Plannotator Code Review
→ Mission close
```

## Implementation Target

### Implementation

Mainは`pi-workflow.implementation`をbounded control args、`missionId`、`cwd`、`async:false`でinvokeする。resourceがMission stateから次を内部取得する。

- `planRef`
- bounded `PlanningDecisionV1`
- approved Write Scope
- required acceptance / verification references

single modeはcurrent checkoutのfresh built-in `worker`一つで実行する。MainはPlan body/path、target filename、Write Scope、large task bodyを再送しない。Workerはapproved Write Scope内だけを変更し、scope expansionを検出したら停止/escalateする。

implementation stateにはnative run / handoff / evidence refsとcompact statusだけを保存する。

### Verification

`pi-workflow.verification`はfresh built-in `reviewer` + `pi-verification`で実行する。Plan / implementation refsをstateから内部解決し、native evidenceで全final verificationを確認する。child proseの「test passed」は証拠にしない。

runtime capabilityが未実測であるため、Step 3のacceptanceにはreal `pi-subagents v0.66.0` execution PASSを必須とする。

### Verification Fix

Verificationがfailedでremaining roundがある場合だけ、`pi-workflow.verification-fix`をfresh built-in `worker`で起動する。

- failure evidenceは`verificationRef` / native evidence refで内部取得する。
- Mainはfailure report本文をtransportしない。
- maximum 2 rounds。
- fix後は全final verificationを再実行する。
- 2回後もfailedならReviewへ進めない。

### Review

`pi-workflow.review`内で、次のfanoutを`runs.all`のforeground childとして実行する。

```text
correctness:
  fresh built-in reviewer
  async:false

simplicity:
  fresh built-in reviewer + ponytail-review
  async:false

synthesis:
  fresh built-in reviewer
  async:false
```

correctnessとsimplicityのlarge findingsはArtifact / Referenceへ保存し、synthesisは両Referenceを内部取得してbounded `ReviewDecisionV1`を生成する。reviewer + `ponytail-review`のreal runtime execution PASSをStep 3 acceptanceで確認する。Ponytailはsimplicity専用であり、correctness reviewの代替ではない。

blocking / fix-now findingがある場合のautomatic Review Fixは最大1 waveとする。fix後は全Final Verification、Review fanout、synthesisを再実行する。

### Code Review / Close

Automated Reviewがcleanになった後、Main-only Plannotator Code Reviewを行う。explicit `approved: true`だけを受理する。Missionは次がすべてPASSした後だけcloseする。

- implementation native evidence / status
- final Verification evidence / `VerificationStatusV1`
- Verification Fix bound
- correctness review
- simplicity review
- Review synthesis / `ReviewDecisionV1`
- Review Fix wave bound
- explicit Code Review approval

## Out of Scope

- `runs.lanes`
- managed lane worktree
- replacement lane
- generic recovery framework
- automatic unbounded fix loop

## Acceptance Criteria

```text
[ ] single WorkerがplanRefを内部取得して実装する
[ ] MainがPlan body/pathをtransportしない
[ ] Workerがapproved Write Scopeを遵守する
[ ] implementation native refs / compact statusが保存される
[ ] reviewer + pi-verificationのreal pi-subagents v0.66.0 runtime PASS
[ ] verification resultがreference + bounded VerificationStatusV1である
[ ] verification failureからReviewへ進まない
[ ] Verification Fixがmaximum 2 roundsである
[ ] fixがfailure evidenceをReference経由で取得する
[ ] fix後に全final verificationを再実行する
[ ] correctness reviewがPASSする
[ ] reviewer + ponytail-reviewのreal runtime PASS
[ ] review fanoutがforegroundである
[ ] synthesisがfresh reviewerでforeground実行される
[ ] bounded ReviewDecisionV1が保存される
[ ] large review outputがArtifact / Reference-backedである
[ ] Review Fix waveがmaximum 1である
[ ] Review Fix後にverification / reviewを再実行する
[ ] blocking findingが残る場合に自動loopしない
[ ] final Plannotator Code Reviewが実行される
[ ] explicit approvalだけが成功扱いになる
[ ] 全条件PASS前にMissionをcloseしない
[ ] representative single E2Eがreal runtimeでPASSする
```

Step 3では、設計書に記載された未実行capabilityを実行済みとみなさない。AcceptanceのPASSは実測結果で更新する。

---

# Step 4 — Parallel / Lane Flow

## Prerequisite

Step 3 single E2Eがreal runtimeでPASSしていること。`runs.lanes`のforeground、parallel first stages、per-lane ordering、sibling independenceという既存のcontract evidenceはFoundation evidenceとして利用してよいが、production behaviorのStep 4 acceptanceを省略しない。

## Goal

single pathを壊さず、independent WorkUnitだけを`runs.lanes` + managed worktreeで実装する。

## Implementation Target

### Lane input

laneはPlanning resourceが生成した`PlanningDecisionV1.implementation.workUnits`から作る。Mainがlarge Plan/bodyを組み立ててlaneへ渡さない。resourceがMission stateから次を内部解決する。

- `planRef`
- bounded `PlanningDecisionV1`
- independent `WorkUnit`
- approved Write Scope
- focused verification IDs

child taskへ渡すのは必要なbounded WorkUnit metadataとReferenceだけとする。

### Lane execution

- `runs.lanes`をnative primitiveとして使う。
- 全stageで`async:false`を明示する。
- first stagesはparallelに開始する。
- 各laneはmanaged worktreeを使う。
- 各laneはfresh built-in `worker`で開始する。
- laneごとのWrite Scopeをenforceする。
- dependencyを持つWorkUnitをindependent laneとして扱わない。
- native lane boundを超えない。

### Lane output / failure

優先するoutputは次である。

```text
native patchRef
native handoffRef
runId
compact evidence / status
```

Mission stateへlane transcript、full child output、full diffを保存しない。failed laneはそのlaneだけをfailed / blockedにし、sibling laneを継続可能にする。failed laneをsilent resumeしない。retryはMain/Humanの明示的選択後に、新しいWorker、新しいlane identityで行う。

### Integration Worker

全laneがnative readinessを満たした場合だけ、current checkoutのfresh Integration Workerを起動する。Integration inputは次だけとする。

- patch/handoff References
- `PlanningDecision`が定めたWorkUnit order
- bounded integration metadata

Mainはlane body / transcriptを受け取ってrelayしない。Integration orderはPlanningDecisionの配列順を使用し、MainやIntegration Workerがdependency graphを再推論しない。Integration後はfinal verification、Review、Human Code Reviewを実行する。

## Out of Scope

- generic DAG scheduler
- automatic lane repair
- patch replay
- failed Workerの自動resume
- nested child orchestration
- lane transcriptのMission state保存

## Acceptance Criteria

```text
[ ] independent WorkUnitだけがlaneになる
[ ] runs.lanesの全stageにasync:falseがある
[ ] first stagesがnative parallelに実行される
[ ] 各laneがmanaged worktreeを使用する
[ ] 各laneがfresh Workerを使用する
[ ] lane Write Scopeがenforceされる
[ ] focused verificationがnative evidenceでverifiedになる
[ ] native patchRef / handoffRefが生成される
[ ] sibling laneが他lane failure後も継続できる
[ ] failed laneがsilent resumeされない
[ ] replacement laneがnew identityを持つ
[ ] failed laneがintegration対象にならない
[ ] Mainがlane transcriptをreceive / relayしない
[ ] IntegrationがReferencesだけを入力にする
[ ] integration orderがPlanningDecisionの順序に従う
[ ] Integration Workerがfreshかつforegroundである
[ ] integration後にfinal verificationが実行される
[ ] integration後にReview / Code Reviewが実行される
[ ] representative parallel E2Eがreal runtimeでPASSする
```

---

# Step 5 — Operational / Recovery / Release

## Prerequisite

Step 3 single E2EとStep 4 lane E2Eがreal runtimeでPASSしていること。

## Goal

reference-centric architectureを維持したまま、Mission recovery、cancel、scope expansion、Human decision、packed package、cross-platform、release gateを完成させる。

## Implementation Target

### Mission recovery / resume

recoveryはconversation transcriptではなく、次のnative情報をsource of truthとする。Mainはnative Mission state APIを直接呼ばず、Mission-bound lookupはNamed Resource workflow scriptに委譲する。

```text
mission.list
→ mission.show
→ linked run status
→ pi-workflow.planning / review-status（compact Mission binding）
→ Plan Review bridge recoverReviewStatus(reviewId)
→ Main interprets
→ record-review or next named workflow resource
```

- `review-status`はPlanning Resource、Plannotator `review-status(reviewId)`はPlan Review bridgeがownerである。
- Mission-bound pending reviewが存在する場合、second Plannotator launchを行わない。
- missing `reviewId`、incomplete binding、round mismatch、planRef mismatch、stale review、unknown correlationはreplacement reviewを起動せずfail closed / needs-decisionとする。
- Plan Review startとMission state persistenceはone atomic transactionではない。crash windowでbindingを証明できない場合は自動再試行しない。
- missing required refはfail closedする。
- cross-Mission fallbackを禁止する。
- `src/missions/*` private import、Mission filesystem store path guessing、raw persistence、private registry/internal APIを使わない。
- raw workflowScriptの再生成・再transportをrecovery stepにしない。
- native run / patch / handoff / evidenceを保持する。
- cancelはMission stateとnative evidenceを壊さず、明示的cancelとして終了する。
- native resumeが必要な場合だけ、同じ責務のnative mechanismを使用する。

### Scope expansion / Human decisions

Worker / Reviewerがapproved scope外を必要とした場合:

1. current changesを保持する。
2. old Plan approvalを無効化する。
3. Mainを`needs_decision`またはblocked状態にする。
4. current treeを前提にPlanning resourceを再実行する。
5. new canonical Plan Artifact / `planRef`を作る。
6. Main-only Plan Reviewを再実行する。
7. explicit approval後にnew implementation runを開始する。

large current stateをMainへ戻してre-planしない。old execution stateをnew Planへ自動転用しない。

### Packed topology / release

clean consumerで次を確認する。

```text
pi-workflow
+
pi-subagents 0.66.0

→ same Pi package scope
```

確認対象:

- peer dependency resolution
- no nested / bundled / vendored `pi-subagents`
- Extension load
- 7 resource registration / invocation
- package-owned Skills
- commands
- Main-only Human Gate integration
- resource-owned scripts / schemas

source checkoutだけではpacked-install evidenceの代替にしない。

### Platform / release gates

- macOS
- Linux
- Windows
- dependency topology
- registration/disposal
- recovery/cancel
- Human Gate approval/failure
- no duplicate bridge/resource ownership
- documentationとimplementationの一致

## Out of Scope

- custom WorkflowState / StateStore
- custom `/resume`
- generic recovery engine
- conversation transcriptをrecovery SOTにする仕組み
- external package lifecycle management
- Monitoring Web App
- custom TUI status system

## Acceptance Criteria

```text
[ ] Mission recoveryがstate / Reference drivenである
[ ] Plan Review recovery splitがResource Mission lookup + bridge Plannotator statusである
[ ] conversation transcriptがrecovery SOTではない
[ ] raw workflowScript recovery transportがない
[ ] pending reviewでduplicate Plannotator launchをしない
[ ] missing reviewId / incomplete binding / round or plan mismatchがfail closedになる
[ ] Plannotator start / Mission state persistence crash windowを明示し、自動replacementをしない
[ ] missing required refがfail closedになる
[ ] cross-Mission fallbackが禁止されている
[ ] scope expansionがPlanningへ戻る
[ ] old Plan approvalが再利用されない
[ ] current changesがpreserveされる
[ ] cancel / recoveryがnative evidenceを保持する
[ ] packed installがsame-scope pi-subagents 0.66.0を解決する
[ ] pi-subagentsがbundleされていない
[ ] duplicate bridge / resource ownershipがない
[ ] commands / Skills / Human Gatesがpacked consumerで解決する
[ ] macOS validationがPASSする
[ ] Linux validationがPASSする
[ ] Windows validationがPASSする
[ ] release blockerがない
```

---

## 5. Test Strategy

contract test、native runtime integration、packed install testを分離する。real LLMが不要な判定をLLM E2Eだけで検証しない。

### 5.1 Deterministic Contract Tests

real childを起動せず、次を検証する。

- 7 canonical resource names、unique性、safe name constraint
- `session_start` registration、`session_shutdown` disposal
- duplicate registration rejectionとrollback
- bounded args、unknown field rejection、empty / oversized value rejection
- resource-owned schema / workflowScript。Main inputによるoverride拒否
- Main invocationにraw script、schema、large payloadがないこと
- Mission key / Reference shape、256 KiB state limit、2,048-byte Reference limit
- `discoveryRef`、`researchRef`、`planRef`、implementation / verification / review refsのphase contract
- `PlanningDecisionV1`、`PlanReviewBindingV1`、`VerificationStatusV1`、`ReviewDecisionV1`のaggregate bounds
- `PlanningArgs` operation discriminator、omitted → `plan`、Unit 5 compatibility
- `prepare-review` / `record-review` / `review-status` zero-child branch and state transition
- current Mission / round / planRef / reviewId / feedbackRef validation
- Artifact bodyをMission stateへ保存しないこと
- Plan body / feedback bodyがMain model-facing transportに入らないこと
- bridge-owned Feedback Artifact、feedback write failure、savedPath非normative
- pending duplicate review prevention and incomplete-correlation fail closed
- S2 `file-only + outputSchema` policy
- `async:false` policyがMain、`runs.run`、`runs.all`、`runs.lanes`にencodedされていること
- required ref欠落時のfail closed
- cross-Mission isolation
- package manifest、peer/dev dependency topology、no bundle
- custom Agentがないこと

### 5.2 Native Runtime Integration

real `pi-subagents 0.66.0`で次を確認する。

- Mission create / attach
- session-scoped resource registration / invocation / disposal
- Discovery full Artifact + compact metadata
- Discovery → Planning `discoveryRef` handoff
- conditional Research → Planning `researchRef` handoff
- Planning → Implementation `planRef` handoff
- Planning `plan` / `prepare-review` / `record-review` / `review-status`
- Unit 5 `{round:1}` with omitted `operation`
- Plan Review bridge Plan Artifact → `planContent`
- bridge-owned Feedback Artifact / `feedbackRef`
- pending review recovery / duplicate-start prevention
- stale cross-Mission / cross-round / stale-plan binding rejection
- explicit Human rejection vs cancel/error/unavailable failure
- single Worker
- reviewer + `pi-verification`
- Verification Fix maximum 2
- `runs.all` foreground review fanout
- reviewer + `ponytail-review`
- Review synthesis / Review Fix maximum 1 wave
- `runs.lanes` foreground overlap、ordering、sibling independence
- managed worktree、native patch / handoff
- failed lane、replacement lane、Integration Worker
- Mission recovery、cancel
- Human Gate approval / rejection / cancel / failure

Runtime evidence classification:

- **Required**: single Worker、reviewer + `pi-verification`、reviewer + `ponytail-review`、Verification Fix、review fanout、Human Gate、Mission close。
- **Conditional**: `pi-ketch.researcher`は`externalResearchRequired === true`のscenario、`oracle`はarchitecture consultationを実際に使用するscenarioで検証する。使用しない構成ではcapability checkと未使用理由を確認する。

未実行capabilityをarchitecture failureやPASS evidenceとして扱わない。Step 3 / Step 4 / releaseの該当Acceptance Criteriaは、実測runtime evidenceが得られるまでuncheckedとする。

### 5.3 Packed Test

`pnpm pack` artifactをclean package environmentへinstall/loadする。

- Extensionがloadできる。
- peer `pi-subagents@0.66.0`がsame scopeでresolveする。
- 7 named resourcesがdiscoverable / invocableである。
- package-owned Skills、commands、Human Gate bridgeが解決する。
- resource-owned script / schemaが解決する。
- `pi-subagents`がnested / bundledされていない。
- source checkout依存の相対pathがない。

source checkoutでのtestをpacked testの代替にしない。

### 5.4 このdocument taskのvalidation

今回の作業では以下だけを実行対象とする。

```text
git diff --check
```

Markdown validationはrepositoryに明示的なcommandが存在する場合だけ実行する。production codeのbuild / test、package install、dependency変更は行わない。

---

## 6. Step Status / Evidence Policy

旧architectureで記録された`Step 1 complete`、`Step 2 in progress`などのstatusが存在しても、そのままv0.66.0 StepのPASSへ移行しない。

- v0.66.0 migrationで意味が変わったAcceptance Criteriaはsupersededとする。
- new StepのAcceptance statusは、v0.66.0 target contractを確認するまで`unchecked`とする。
- Basic Design / Implementation Specificationに明記されたcompleted evidenceは、記載された範囲だけをFoundation evidenceとして再利用できる。
- `runs.lanes`のcontract evidenceがあっても、Step 4のproduction behavior全体をPASS扱いしない。
- runtime未実行の`reviewer + pi-verification`、`reviewer + ponytail-review`、conditional `pi-ketch.researcher`、conditional `oracle`を実行済みと記録しない。
- 実装済みcodeが新SOTに適合するか未確認の場合、new Step statusは`unchecked`とする。
- 本書はimplementation targetを定義するだけで、実装完了を宣言しない。

## 7. Step Completion Gate

各Stepの完了時に次を実施する。

1. そのStepのAcceptance Criteriaを1項目ずつ確認する。
2. relevant deterministic / native / packed testを実行する。
3. 必要なruntime evidenceを記録する。
4. `git status`、`git diff`、変更ファイルを確認する。
5. Basic Design / Implementation Specificationとの整合を確認する。
6. correctness reviewを行う。
7. `ponytail-review`でsimplicity / over-engineeringを確認する。
8. unresolved、conditional、unverified事項を明示する。

次の場合はStepをcompleteとしない。

- failed Acceptance Criterionがある。
- v0.66.0 architectureと矛盾する。
- required external contractが未確認である。
- required native evidenceが不足している。
- missing refやlarge payloadをMain transportで補うworkaroundがある。
- background / CLI / 別protocolへのsilent fallbackがある。

## 8. Implementation Completion Report Format

将来の実装taskでは、各Stepを次の形式で報告する。

```text
## Implementation Summary

## Changed Files

## Acceptance Criteria
- PASS — ...
- FAIL — ...
- UNCHECKED — ...

## Tests / Runtime Evidence
- command or scenario
- result

## Architecture / Contract Checks

## Review
- correctness
- simplicity / Ponytail

## Remaining Issues

## Deferred to Later Steps

Step N — <name>: COMPLETE | INCOMPLETE | UNCHECKED
```

`COMPLETE`は、そのStepの全Acceptance Criteriaと必要なruntime evidenceがPASSした場合だけ使用する。
