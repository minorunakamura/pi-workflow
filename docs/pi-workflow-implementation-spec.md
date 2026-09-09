# pi-workflow 実装仕様書

- 文書種別: 実装仕様書
- 対象: 新規プロジェクト `pi-workflow`
- 基準日: 2026-09-08
- 上位文書: `docs/pi-workflow-basic-design.md`
- `pi-subagents` baseline: **v0.66.0**

本書はBasic Designのtarget architectureに従う。今回の作業は設計文書の更新であり、本書に基づくproduction TypeScript、workflow script、Skill、manifestの変更は別taskで行う。

---

## 1. 実装方針

`pi-workflow` は1つのPi Packageとする。

```text
Main Session / Control Plane
  → named workflow name + bounded args + missionId + cwd + async:false
  → pi-subagents v0.66.0 public resource resolver
  → package-owned workflow script / schema / policy
  → foreground child execution
  → Artifact + native Reference
  → compact native Mission state
```

Mainはlarge phase payload、raw `workflowScript`、output schema、Artifact bodyをtransportしない。各phaseのtrusted resourceが、必要なupstream Referenceを同じMission stateから内部解決する。

`pi-workflow` は以下だけをpackageする。

- thin Extension
- own Skills
- 7 package-owned named workflow resources
- resource-owned workflow scripts
- bounded schema / validation
- Main-only Plannotator bridge
- deterministic core contract tests
- native runtime / packed-package tests

subagent runtime、custom Agents、Ketch、Ponytail、Plannotator、ask-user-questionはbundleしない。

---

## 2. Package Layout

```text
pi-workflow/
├── package.json
├── pnpm-lock.yaml
├── tsconfig.json
├── biome.json
├── oxlint.json
│
├── src/
│   ├── index.ts
│   │
│   ├── commands/
│   │   ├── index.ts
│   │   └── workflow.ts
│   │
│   ├── tools/
│   │   ├── index.ts
│   │   ├── plan-review.ts
│   │   └── code-review.ts
│   │
│   ├── runtime/
│   │   ├── workflow-resources.ts
│   │   └── plannotator/
│   │       ├── plan-review.ts
│   │       ├── code-review.ts
│   │       └── request.ts
│   │
│   └── core/
│       ├── phases/
│       │   ├── definitions.ts
│       │   ├── args.ts
│       │   └── validation.ts
│       │
│       ├── state/
│       │   ├── contracts.ts
│       │   └── references.ts
│       │
│       ├── planning/
│       │   ├── planning-decision.ts
│       │   ├── planning-decision-schema.ts
│       │   └── render-plan.ts
│       │
│       └── review/
│           └── review-decision-schema.ts
│
├── workflow-scripts/
│   ├── discovery.js
│   ├── research.js
│   ├── planning.js
│   ├── implementation.js
│   ├── verification.js
│   ├── verification-fix.js
│   └── review.js
│
├── skills/
│   ├── pi-workflow/
│   │   └── SKILL.md
│   ├── pi-planning/
│   │   └── SKILL.md
│   └── pi-verification/
│       └── SKILL.md
│
├── tests/
│   ├── core/
│   ├── runtime/
│   ├── tools/
│   ├── commands/
│   ├── skills/
│   ├── contract/
│   ├── integration/
│   └── packed/
│
└── docs/
    ├── pi-workflow-basic-design.md
    └── pi-workflow-implementation-spec.md
```

`src/tools/prepare-phase.ts` はtarget layoutに置かない。`pi_workflow_prepare_phase` はMain向けphase transport Toolではなくなり、phase definitions、args validation、schema、script constructionはresource boundaryへ移る。

### 2.1 Dependency rules

`core/` はPi API、Extension context、Plannotator event bus、`pi-subagents` runtimeへ依存しない。TypeBoxなどのschema libraryを使ってよい。

`core/` から次へのimportを禁止する。

```ts
import ... from "@earendil-works/pi-coding-agent";
import ... from "pi-subagents";
```

また、`core/`から以下へ依存しない。

- `commands/`
- `tools/`
- `runtime/`

`runtime/` は `core/` とpublic `pi-subagents/workflow-resources` を利用してよい。private `preflight` path、private registry、private Mission storeはimportしない。

`commands/` / `tools/` はPiとのadapterとMain-only Human Gateに限定し、resourceの複雑な実処理を持たない。

`workflow-scripts/` はpackage-owned resourceのstatement bodyであり、Mainから渡されるtemplateではない。arbitrary template path、arbitrary JavaScript、caller-supplied placeholderは受け取らない。

### 2.2 File split rules

ファイル分割は行数ではなく変更理由で判断する。4 commandはrequest type以外が共通なので、4つのcommand fileへ分割しない。

```text
commands/
├── index.ts
└── workflow.ts
```

7 phaseは次の7 resource boundaryへ1対1で対応する。新しい特殊resourceを追加する前に、既存phaseのbounded args / modeで表現できないことを確認する。

---

## 3. Package Contract

### 3.1 `package.json` target

概念形は次のとおりとする。既存のPi peer、TypeBox、toolingのdependencyは維持し、`pi-subagents`だけをv0.66.0 contractに追加する。

```json
{
  "name": "pi-workflow",
  "type": "module",
  "keywords": ["pi-package"],
  "pi": {
    "extensions": ["./src/index.ts"],
    "skills": ["./skills"]
  },
  "peerDependencies": {
    "@earendil-works/pi-coding-agent": "*",
    "typebox": "*",
    "pi-subagents": "0.66.0"
  },
  "devDependencies": {
    "pi-subagents": "0.66.0"
  }
}
```

`pi-subagents`のsupported versionはexactly `0.66.0` とする。`^0.66.0`やfloating `latest`をruntime contractにしない。

### 3.2 禁止事項

- `pi-subagents`を`dependencies`へ置かない。
- `pi-subagents`を`bundledDependencies`へ置かない。
- `pi-subagents`をbundle、vendoring、source copyしない。
- Plannotator、Ponytail、`pi-ketch`、`pi-ask-user-question`をbundleしない。
- `pi.subagents.agents`へcustom Agentを公開しない。
- 同じ機能のMission、run、worktree、patch、acceptance registryを作らない。

`pi-workflow`と`pi-subagents`は同じPi package scopeへinstallすることをsupported topologyとする。peer dependencyはhost scopeにあるv0.66.0との互換契約であり、bundled runtime dependencyではない。

### 3.3 Packed package

release判定はsource checkoutだけで行わない。`pnpm pack`したartifactをclean consumerへinstall/loadし、Extension、Skills、7 resource definitions、resource-owned scripts、Main-only toolsが解決できることを確認する。

---

## 4. Extension Entry Point とRegistration Lifecycle

### 4.1 Entry Point

`src/index.ts`は次のregistrationに限定する。

```text
command registration
Main-only tool registration
session_start → named resource registration
session_shutdown → disposer cleanup
```

`src/index.ts`へ次を置かない。

- orchestration loop
- child execution
- Mission persistence implementation
- custom Agent definitions
- schema transformation
- Plannotator request実処理
- polling UI
- long-lived background process
- raw script / payload transport

### 4.2 Public resource registration

runtime boundaryは次のpublic APIだけを使用する。

```ts
import {
  registerWorkflowResource,
  type WorkflowResourceDefinition,
  type WorkflowResourceRegistration,
} from "pi-subagents/workflow-resources";
```

各definitionは次のpublic shapeを満たす。

```ts
interface WorkflowResourceDefinition {
  name: string;
  version: number;
  resolve: (
    args: Readonly<Record<string, unknown>>,
  ) => { script: string } | { error: string };
}
```

`resolve`はsynchronousである。resourceが必要とするscript、child Agent、Skill、schema、policyはpackage-owned definitionから決める。callerの`workflowScript`、`outputSchema`、`agent`、`task`を参照しない。

### 4.3 Session lifecycle

```text
session_start(sessionId)
  → canonical definitionsを順番に検証
  → registerWorkflowResource({ sessionId, definition }) を7回
  → 各registrationのdisposerを保持

session_shutdown
  → 保持した全disposerを実行
  → registryをdirect操作せずsession registrationを終了
```

registrationが1件でも失敗した場合は、同一sessionで先に登録したdisposerを呼び、7 resourceが一部だけ有効な状態を残さない。duplicate nameはrejectし、既存resourceをreplace / shadowしない。

- registrationはcurrent Pi sessionにscopeする。
- registryの`globalThis` symbolを直接読書きしない。
- sessionIdはscope指定であり、独自authenticationではない。
- disposerはidempotentに呼べるようにする。
- `session_shutdown`後に新しいinvocationを成功扱いしない。

v0.66.0のsafe resource name contractは次である。

```text
先頭: ASCII英数字
残り: ASCII英数字、'.'、'-'
長さ: 最大128文字
```

canonical nameはすべてこの制約、unique、resource version `1`を満たす。

---

## 5. Canonical Named Resource Definitions

| Phase | Name | Version | Child / Skill | Artifact policy |
|---|---|---:|---|---|
| Discovery | `pi-workflow.discovery` | 1 | fresh `scout` | full reportはfile-only Artifact、metadataはbounded |
| Research | `pi-workflow.research` | 1 | fresh `pi-ketch.researcher`、conditional | reportはfile-only Artifact、statusはbounded |
| Planning | `pi-workflow.planning` | 1 | fresh `reviewer` + `pi-planning` | `plan.md` Artifact、Decisionはbounded |
| Implementation | `pi-workflow.implementation` | 1 | fresh `worker` | native run / patch / handoff refs |
| Verification | `pi-workflow.verification` | 1 | fresh `reviewer` + `pi-verification` | evidence / report refs、statusはbounded |
| Verification Fix | `pi-workflow.verification-fix` | 1 | fresh `worker` | run/ref、最大2 round |
| Review | `pi-workflow.review` | 1 | `reviewer` fanout + `ponytail-review` + synthesis | findings Artifact、Decisionはbounded |

resource nameをphase template名、Agent名、Main command名と混同しない。Mainが呼ぶcanonical boundaryは上表の`name`である。

---

## 6. Main Invocation Contract

### 6.1 Phase invocation

Mainからのphase invocationは次の形に限定する。

```ts
subagent({
  workflow: "pi-workflow.discovery",
  args: {
    requestType: "feature",
    request: "bounded request",
    attempt: 1,
  },
  missionId,
  cwd,
  async: false,
});
```

phaseごとに`workflow` nameとbounded `args`だけを変更する。`missionId`はnative Mission IDとして空でない最大2,048 bytes、`cwd`はcurrent projectのtrusted pathとして最大2,048 bytesに制限する。initial requestとMission objectiveは同じ8,192-byte boundを超えたらMission作成前にrejectする。

Main invocationへ次を追加しない。

- `agent`
- `task`
- `workflowScript`
- `workflowScriptPath`
- `outputSchema`
- `output`
- arbitrary artifact path
- full upstream result
- full Plan / diff / evidence / transcript

Named resourceとraw script、raw path、direct child fieldsを混在させない。`cwd`はouter requestにだけ置き、per-stepのpathをMainから渡さない。

### 6.2 Foreground policy

Mainの通常phaseは必ず `async:false` とする。resource内部も同じ方針を使う。

```text
runs.run child       → async:false
runs.all child entry → async:false
runs.lanes stage     → async:false
```

`async` omittedによるbackground defaultに依存しない。foregroundで必要capabilityが使えない場合はfail closedし、background、CLI、別protocolへsilent switchしない。

`runs.lanes`のfirst-stage parallel overlapはnative primitiveに任せる。`async:false`はparallel性を失わせる指定ではない。

### 6.3 Phase result

Main detailsに残ってよいのは次だけである。

- compact status
- native runId / Reference
- bounded decision
- bounded error / blocker
- bounded approval result

Artifact body、child transcript、unbounded structured resultはMainへ戻さない。`outputSchema`が使われた場合はS2 policyを適用する。

---

## 7. Main Commands とOwn Skills

### 7.1 Commands

登録するcommandは次の4つで、処理は共通helperへ集約する。

```text
/wf-feature <request>
/wf-bug <request>
/wf-chore <request>
/wf-hotfix <request>
```

command handlerはresourceを直接実行しない。空requestを拒否し、request typeとbounded request textを含むkickoff user messageをMainへ送る。Main Skillがstartup guard、Mission create、named resource invocationを行う。

commandから`pi-subagents` runtimeをdirect callしない。resource registrationだけはExtension lifecycleのruntime boundaryで行う。

### 7.2 `pi-workflow` Skill

Main Control Plane policyを含む。

- request受付
- active Mission guard
- clean-tree guard
- capability check
- Mission create / attach
- phase order
- named resource invocation
- `async:false` policy
- Human clarification / Plan Gate / Code Gate
- state/reference recovery
- fix/retry bound
- fail-closed rules
- scope expansion
- completion condition

repository詳細調査をMain Skillへ戻さない。

### 7.3 `pi-planning` Skill

fresh built-in `reviewer`向けのread-only planning guidanceとする。

- Discovery / Research Artifact Referenceを読む
- Human decisionを反映する
- bounded `PlanningDecisionV1`を返す
- WorkUnit、Write Scope、acceptance、verificationを定義する
- lane independenceを判定する
- unresolved decisionを明示する

### 7.4 `pi-verification` Skill

fresh built-in `reviewer`向けのread-only verification guidanceとする。

- approved Planとactual diffを照合する
- acceptance criteriaを確認する
- native verification evidenceを読む
- residual riskを報告する
- codeを変更しない

`pi-workflow`はcustom Agentを持たない。`scout`、`reviewer`、`worker`、conditional `oracle`などnative capabilityを使用する。

---

## 8. Resource Args Contract

### 8.1 一般則

各resolverは`args`を`additionalProperties:false`相当で検証する。Mainから渡すのはcontrol metadataだけであり、upstream Agent output、report、Plan body、failure evidence本文は渡さない。

Main-origin dataはboundedなら許可する。

- initial request
- request type
- attempt / round / mode
- Human answer
- Human feedback Reference
- explicit retry choice

upstream resultは次の経路だけで受け渡す。

```text
native Mission state
  → compact Reference / bounded metadata
  → resource内部でstate.get
  → child taskへ必要なReferenceだけを含める
```

### 8.2 Phase args

```ts
type RequestType = "feature" | "bug" | "chore" | "hotfix";

type ReferenceValue = string; // serialized UTF-8 bytes <= 2,048

interface HumanInputV1 {
  id: string;    // <= 64 bytes
  value: string; // <= 2,048 bytes
}

interface DiscoveryArgsV1 {
  requestType: RequestType;
  request: string; // <= 8,192 bytes
  attempt?: number; // integer 1..3
}

interface ResearchArgsV1 {
  attempt?: number; // integer 1..3
}

interface PlanningArgsV1 {
  round: number; // integer 1..3
  humanInputs?: HumanInputV1[]; // <= 8
  feedbackRef?: ReferenceValue;
}

interface ImplementationArgsV1 {
  mode: "single" | "lanes" | "review-fix";
  verificationRound?: number; // integer 0..2
  reviewFixWave?: number; // integer 0..1
}

interface VerificationArgsV1 {
  round: number; // integer 0..2
}

interface VerificationFixArgsV1 {
  round: number; // integer 1..2
}

interface ReviewArgsV1 {
  wave: number; // integer 0..1
}
```

cross-field rules:

- `review-fix`以外のImplementationでは`reviewFixWave`を`0`または省略する。
- `review-fix`では`reviewFixWave === 1`を要求する。
- `verification-fix`の`round`は現在のfailed Verification roundと一致させる。
- `feedbackRef`は同じMissionのgate feedback Referenceでなければrejectする。
- `planRef`、`discoveryRef`、`verificationRef`、target filename、Write Scope、full failure evidenceをargsへ追加しない。

### 8.3 Native v0.66.0 args limits

v0.66.0 public resolverのplain-JSON args guardも満たす。

```text
args total: 最大16 KiB
object fields: 最大16
array items: 最大64
string: 最大16 KiB
nesting depth: 最大8
```

これらは上限であり、phase-specific boundを緩める理由にしない。全byte limitはUTF-8 serialized JSONで計測する。

### 8.4 pi-workflow bounds

次は本migrationで導入する**New v0.66.0 design decision**である。Integration Spikeの測定値ではなく、unbounded structured dataをcompactと呼ばないためのtarget validation contractである。

| Value | Bound |
|---|---:|
| regular compact text | 1,024 UTF-8 bytes |
| command / path / Write Scope entry | 2,048 UTF-8 bytes |
| identifier | 64 UTF-8 bytes |
| Human input | 最大8件、各value 2,048 bytes |
| Discovery request | 8,192 bytes |
| `DiscoveryMetadataV1` | 8 KiB、uncertainties最大8、researchQuestions最大8 |
| `ResearchMetadataV1` | 8 KiB、unresolvedQuestions最大8 |
| `PlanningDecisionV1` | 32 KiB |
| `ReviewDecisionV1` | 24 KiB |
| verification IDs / evidence refs | 各最大16 |
| lane results | 最大32 |
| verification fix runs | 最大2 |

`jsonByteLength`相当の共通validatorを使い、resolverごとに別のbyte計算を実装しない。PlanningDecisionの`requestSummary`、scope各entry、acceptance criterionの`text`、constraint、risk、verificationの`description`、WorkUnitの`title` / `objective`、unresolved decisionの`question` / `reason`は各1,024 UTF-8 bytes以内とする。`verification.command`、WorkUnitの`writeScope`各entryは各2,048 bytes以内、全IDは各64 bytes以内とする。Discovery / Research metadataのquestion、ReviewDecisionのsummary / location / reason / question / contextもregular compact text boundを使う。requestは8,192 bytes、Human input valueは各2,048 bytes以内とする。oversized、non-JSON、non-finite number、empty string、unknown fieldはrejectする。

---

## 9. Mission State / Reference Contract

### 9.1 State ownership

Mission stateはnative `state.get/state.set`だけを使う。独自WorkflowState、StateStore、ledger、run registryを作らない。

Mission state全体のhard constraintは次である。

```text
256 KiB = 262,144 bytes
```

各resourceはchild launch前に必要state/refの存在、同一Mission所属、size boundを確認する。`state.set`失敗、limit超過、missing ref、cross-Mission refはfail closedとする。

### 9.2 Reference

```text
ReferenceValue
  = native outputReference / runId / patch ref / handoff ref / evidence ref
  を指すcompact serialized value
```

stored Referenceは最大2,048 UTF-8 bytesとする。Native primitiveを独自Artifact class、独自run object、独自patch databaseへ複製しない。Native valueが解決できない場合に、bodyをstateやMain argsへコピーしない。

### 9.3 State key allowlist

次のkeyをcanonical state contractとする。これは今回のmigrationで確定する**Target Design**であり、Discoveryの`discoveryRef` handoff以外のphase-specific shapeはruntime factとして扱わない。phaseが未実行のkeyは省略する。

```text
version
requestType
request
phase
missionStatus
humanDecisions

discoveryRef
discoveryMeta
researchRef
researchMeta

planRef
planningDecision

implementation
verificationRef
verificationStatus
verificationFixRuns

reviewRef
reviewDecision
codeApproval
```

native Mission statusがauthoritativeで、`missionStatus`はbounded mirrorに過ぎない。不一致をsuccessへ丸めない。

### 9.4 Compact contracts

#### Discovery

```ts
interface DiscoveryMetadataV1 {
  version: 1;
  status: "ready" | "blocked";
  externalResearchRequired: boolean;
  humanClarificationRequired: boolean;
  uncertainties: Array<{
    id: string;
    question: string;
    material: boolean;
  }>;
  researchQuestions: string[];
}
```

`discoveryRef`はfull investigation Artifact、`discoveryMeta`はMainがResearch / Human clarificationの要否を判断するためのbounded metadataである。

#### Research

```ts
interface ResearchMetadataV1 {
  version: 1;
  status: "skipped" | "completed" | "blocked";
  unresolvedQuestions: string[];
}
```

Researchが不要なら`researchRef`を作らず、`researchMeta.status`を`skipped`とする。

#### Planning

`planningDecision`は次の`PlanningDecisionV1` machine contractである。

```ts
interface PlanningDecisionV1 {
  version: 1;
  requestSummary: string;
  scope: {
    inScope: string[];
    outOfScope: string[];
  };
  acceptanceCriteria: Array<{
    id: string;
    text: string;
  }>;
  constraints: string[];
  risks: string[];
  verification: Array<{
    id: string;
    description: string;
    command: string;
    timeoutMs?: number;
  }>;
  implementation: {
    mode: "single" | "lanes";
    workUnits: Array<{
      id: string;
      title: string;
      objective: string;
      dependsOn: string[];
      writeScope: string[];
      acceptanceCriteriaIds: string[];
      focusedVerificationIds: string[];
    }>;
    finalVerificationIds: string[];
  };
  unresolvedDecisions: Array<{
    id: string;
    question: string;
    reason: string;
  }>;
}
```

`planRef`はpackage-owned canonical `plan.md` Artifactを指す。`planningDecision`はfull Plan proseではない。

#### Implementation

```ts
interface ImplementationStateV1 {
  version: 1;
  mode: "single" | "lanes" | "review-fix";
  status: "pending" | "completed" | "failed" | "blocked";
  runId?: ReferenceValue;
  laneResults?: Array<{
    workUnitId: string;
    status: "completed" | "failed" | "blocked";
    runId?: ReferenceValue;
    patchRef?: ReferenceValue;
    handoffRef?: ReferenceValue;
  }>;
}
```

Singleはnative run / handoff / evidence Referenceを持つ。lanesは最大32 WorkUnit分のnative run / patch / handoff Referenceを持つ。full diff、target filename、child transcriptは持たない。

#### Verification

```ts
interface VerificationStatusV1 {
  version: 1;
  status: "passed" | "failed" | "blocked";
  evidenceStatus: "verified" | "missing" | "unverified";
  requiredFix: boolean;
  failedVerificationIds: string[];
}
```

`verificationRef`はlarge reportまたはnative acceptance/evidence Referenceである。failure evidence本文はstateに入れない。

#### Verification Fix

```ts
interface VerificationFixRunV1 {
  round: 1 | 2;
  status: "completed" | "failed" | "blocked";
  runId?: ReferenceValue;
  handoffRef?: ReferenceValue;
}
```

`verificationFixRuns`は最大2件。過去roundのfailure reportを蓄積しない。

#### Review

`reviewRef`はfull finding bodyではなく、fanout / synthesisのReference indexである。

```ts
interface ReviewReferenceIndexV1 {
  correctnessRef: ReferenceValue;
  simplicityRef: ReferenceValue;
  synthesisRef: ReferenceValue;
}
```

`reviewDecision`は次のbounded `ReviewDecisionV1`である。

```ts
interface ReviewDecisionV1 {
  version: 1;
  blockers: ReviewFinding[];
  fixNow: ReviewFinding[];
  deferred: ReviewFinding[];
  rejected: Array<ReviewFinding & { reason: string }>;
  decisionRequired: Array<{
    id: string;
    question: string;
    context: string;
  }>;
}

interface ReviewFinding {
  id: string;
  source: "correctness" | "ponytail";
  location?: string;
  summary: string;
}
```

`codeApproval`はPlannotatorのapproval status、reviewId、必要なfeedback Referenceだけを持つ。annotation bodyはstateへ保存しない。

```ts
interface CodeApprovalV1 {
  status: "pending" | "approved" | "rejected" | "failed";
  reviewId?: ReferenceValue;
  feedbackRef?: ReferenceValue;
}
```

### 9.5 PlanningDecision validation

既存のsemantic validationを維持し、次をrejectする。

- `additionalProperties`がある。
- required stringがempty。
- IDが重複する。
- WorkUnit dependency、acceptance ID、verification IDが存在しない。
- WorkUnitが自分自身へ依存する。
- `lanes` modeのWorkUnit間にdependencyがある。
- `writeScope`がempty。
- `finalVerificationIds`がemptyまたは存在しない。
- `focusedVerificationIds`がcatalogにない。
- `unresolvedDecisions`が残ったままPlan Reviewへ進もうとする。
- aggregate serialized sizeが32 KiBを超える。

bounds:

```text
scope.inScope / outOfScope        各最大16
acceptanceCriteria                最大16
constraints / risks               各最大16
verification                      最大16
implementation.workUnits         最大32
各WorkUnitのdependsOn             最大16
各WorkUnitのwriteScope             最大16
各WorkUnitのcriterion refs         最大16
各WorkUnitのverification refs      最大16
finalVerificationIds              最大16
unresolvedDecisions               最大8
```

上記field-level text boundを全fieldへ適用する。`timeoutMs`はinteger `1..86,400,000` とする。

### 9.6 ReviewDecision validation

- 全finding IDと`decisionRequired` IDはglobalにunique。
- 各finding bucketは最大16件。
- `decisionRequired`は最大8件。
- findingのsummary、location、reason、question、contextは各1,024 bytes以内。
- aggregate serialized sizeは24 KiB以内。
- `source`は`correctness`または`ponytail`だけ。

---

## 10. Artifact / Structured Output Policy

### 10.1 Artifact channel

large outputはnative `outputReference`、acceptance evidence、patch、handoffなどのfile-backed/native primitiveへ置く。MainはReferenceだけを受け取る。

| Output | Target |
|---|---|
| full Discovery investigation | file-backed Artifact + `discoveryRef` |
| full Research report | file-backed Artifact + `researchRef` |
| canonical Plan prose | `plan.md` Artifact + `planRef` |
| full Verification report/evidence | Artifact/native evidence + `verificationRef` |
| full Review findings/prose | fanout Artifact + `reviewRef` |
| large Human feedback / failure evidence | Artifact/native Reference |
| full child transcript | workflow artifact only。Mission stateへコピーしない |

large Artifact runは`outputMode:"file-only"`を使い、`outputSchema`を付けないことを基本とする。Mainからoutput pathを渡さず、resource/native runnerが作るReferenceを使う。

### 10.2 S2 rule

v0.66.0で実測されたStructured Visibility ModelはS2である。

```text
file-only + outputSchema
  → structured valueがArtifactへ書かれる
  → structuredOutput全体がMain tool detailsにも残る
```

`file-only`はstructured outputをMainから隠す仕組みではない。抑制するのはchild final text / transcriptのinline transportである。

### 10.3 V1 / V2 / V3

| Variant | Use |
|---|---|
| V1 | `file-only` + schemaなし。full report/evidenceをArtifactへ保存する。 |
| V2 | `file-only` + size-bound schema。structuredOutputがMain detailsへ現れることを受容する。 |
| V3 | `inline` + size-bound schema。compact control data専用。 |

`outputSchema`を使用できるのは次だけである。

- bounded `DiscoveryMetadataV1`
- bounded `PlanningDecisionV1`
- bounded `ReviewDecisionV1`
- bounded status / orchestration metadata

`outputSchema`を使用してはならないもの:

- full Discovery / Research report
- full Plan prose
- large verification evidence
- full Review prose / findings
- large failure evidence
- unbounded arrays、free-form report fields、full transcript

schemaはnamed resource / package-owned phase definitionが所有する。Mainはschema objectを生成、transport、overrideしない。すべてのschemaは`additionalProperties:false`とaggregate byte boundを持つ。

### 10.4 Main details acceptance

V2のstructuredOutputがMain detailsへ出ることは仕様上受容する。したがってresource resolverはstructured result全体を上表のbound以内にし、Mainがそのfull valueを受け取っても問題ないかをphaseごとに確認する。

---

## 11. Phase Resource Specifications

### 11.1 Discovery resource

`pi-workflow.discovery` resolverは `DiscoveryArgsV1` だけを受け付ける。

target sequence:

1. argsをvalidateする。
2. Mission stateへrequest metadataをboundedに保存する。
3. `state.get`で既存cross-Mission refを確認する。
4. fresh built-in `scout`を `async:false`、`outputMode:"file-only"`、schemaなしで起動する。
5. full reportのnative `outputReference`を`discoveryRef`へ保存する。
6. Artifact Referenceだけを読むfresh built-in `scout` normalization childを起動し、bounded `DiscoveryMetadataV1` schemaを使用する。
7. `discoveryMeta`をvalidateしてstateへ保存する。
8. MainへReferenceとbounded metadataだけをreturnする。

normalization childへDiscovery report本文をtask文字列として埋め込まない。childはReferenceからArtifactを読む。normalization childのstructuredOutputは最大8 KiBで、S2 exposureを受容する。

full reportに含める内容は次である。

- relevant entry points
- data/control flow
- affected tests
- change blast radius
- repository constraints
- risks
- uncertainties
- external research questions

CodeGraphはScout task policyとして次の順序で使用する。

```text
codegraph status
→ usableなら codegraph explore
→ stale/changed-on-diskまたはexact contentが必要な箇所だけread
→ unusableならbounded read / grep / find
```

`init`、`index`、`sync`、`upgrade`を自動実行しない。managed worktreeでCodeGraph indexを初期化しない。

### 11.2 Research resource

`pi-workflow.research` resolverは`ResearchArgsV1`だけを受け付ける。Discovery report、`discoveryRef`、questions本文をMainから受け取らない。

前提:

```text
discoveryMeta.externalResearchRequired === true
discoveryRef exists
pi-ketch.researcher capability exists
```

target sequence:

1. stateから`discoveryRef`と`discoveryMeta`を取得する。
2. `pi-ketch.researcher` capabilityを確認する。
3. fresh `pi-ketch.researcher`を `context:"fresh"`、`async:false`、read-only、`outputMode:"file-only"`、schemaなしで起動する。
4. child taskへReferenceとbounded research questionsだけを含める。
5. full reportのReferenceを`researchRef`へ保存する。
6. native result statusから`ResearchMetadataV1`を作成し、stateへ保存する。

Research不要時はresourceをinvokeせず、`researchMeta.status = "skipped"` とする。Researcher unavailable / foreground failureはfail closedであり、別CLIやbackgroundへ切り替えない。

### 11.3 Planning resource

`pi-workflow.planning` resolverは`PlanningArgsV1`だけを受け付ける。

前提:

```text
discoveryRef + discoveryMeta exists
optional researchRef + researchMeta is valid
humanInputs / feedbackRef are bounded
```

target child:

```text
agent: reviewer
skill: pi-planning
context: fresh
async: false
```

resource内部でDiscovery / Research Artifact Reference、bounded Human decisions、native Mission objectiveを解決し、child taskを構築する。Mainはreport body/pathを渡さない。

Planning childはpackage-owned `PlanningDecisionSchema`を`outputSchema`として使う。structured valueは最大32 KiBであり、S2によりMain detailsへ現れても受容できるサイズにする。

- schema shape validation
- semantic validation
- unresolved decision check
- invalid時のcorrectionは最大1回
- correction後もinvalidならstop

valid decisionからpackage-owned deterministic rendererでcanonical `plan.md`を生成し、file-backed Artifactの`planRef`をstateへ保存する。Plan rendererはWorkUnit配列順を保持し、dependencyを再計算しない。

Planning Decisionのfull JSONとcanonical Plan Artifactを同じものとして扱わない。

### 11.4 Planning Human Gate Tool

Plan Reviewはresource childではなくMain-only Toolが扱う。Toolは次のsmall contractだけを受け付ける。

```ts
interface PlanReviewInput {
  missionId: string;
  round: number;       // 1..3
  planRef: ReferenceValue;
}
```

Toolは`planRef`が同じMissionのcanonical Planを指すことを確認する。full `PlanningDecisionV1`、Plan body、arbitrary pathをMainから受け取らない。

処理:

1. Referenceをresolveする。
2. canonical Plan Artifactをproject-local review inputとして扱う。
3. `plannotator:request` / `plan-review`を発行する。
4. pending reviewを`plannotator:review-result`または`review-status`で追跡する。
5. explicit `approved: true`だけを成功とする。
6. feedbackはbounded valueまたはArtifact Referenceへ変換する。

unavailable、cancel、close、timeout、error、invalid resultをapproval扱いしない。Plan rejectionのroundは最大3回で、上限後はMain/Humanへ戻す。

### 11.5 Implementation resource — single

`pi-workflow.implementation` resolverは`mode:"single"`を受ける。

前提:

```text
planRef exists
planningDecision is approval-valid
approved Write Scope exists inside planningDecision
```

target child:

```text
agent: worker
context: fresh
async: false
current checkout
```

resourceはstateから`planRef`、bounded `PlanningDecisionV1`、acceptance、Write Scopeを取得する。MainからPlan body、path、target filename、Write Scopeを再送しない。

Workerには次を求める。

- approved Plan / Write Scope内だけを変更する。
- behavior変更ではTDD policyを適用する。
- self-challengeをfinalize前に行う。
- scope expansionを検出したら停止/escalateする。
- native acceptance / evidenceを返す。

large Worker outputはfile/native Referenceへ置き、Mainへ戻さない。implementation stateはrunId、handoff/evidence ref、compact statusだけを保存する。

### 11.6 Implementation resource — lanes

`mode:"lanes"`ではPlanningDecisionからindependent WorkUnitだけを選ぶ。

```text
runs.lanes(
  lanes.map(lane => ({
    key: lane.id,
    stages: [{
      key: "worker",
      agent: "worker",
      context: "fresh",
      async: false,
      worktree: true,
      task: reference-based task,
      acceptance: native acceptance,
    }],
  })),
)
```

実装上の規則:

- first stageはnative `runs.all` batchでparallel launchされる。
- 全stageに`async:false`を明示する。
- 各laneはmanaged worktreeを使う。
- lane stageはfresh Worker一つとする。
- lane reviewer stage、独自lane registry、独自cleanup authorityを追加しない。
- `runs.lanes`のnative bound（32 lanes、16 stages/lane、64 total stages、64 KiB inventory）を超えない。
- boardのstate、ok、runId、outputReference、verdict、bounded errorだけを保存する。
- reviewer proseをsuccess判定に使わない。

lane readinessは次のnative metadataで判断する。

```text
stage complete
AND ok === true
AND evidenceStatus === "verified"
AND patch/handoff Reference exists
```

### 11.7 Lane failure とIntegration

failed / stopped / detached / explicit `structuredOutput.verdict === "blocked"` のlaneはそのlaneだけをblockedにし、後続stageをskipする。sibling laneは継続可能とする。

Mainは次を自動実行しない。

- automatic repair
- patch replay
- old Worker resume
- failed lane integration

Human/Mainがretry/fixを選択した場合だけnew Worker、new lane identity、同じapproved scope、同じfocused verificationで実行する。

全laneがreadinessを満たした後、resourceはcurrent checkoutのfresh Integration Workerを `async:false` で起動する。

Integration inputは次だけである。

```text
planRef
bounded planningDecision
ordered patchRef / handoffRef list
```

lane transcript、full output、target filenameを渡さない。integration orderは`planningDecision.implementation.workUnits`の配列順を使い、dependency graphを再推論しない。

### 11.8 Verification resource

`pi-workflow.verification` resolverは`VerificationArgsV1`だけを受け付ける。

前提:

```text
planRef exists
implementation state/ref exists
finalVerificationIds exists
```

target child:

```text
agent: reviewer
skill: pi-verification
context: fresh
async: false
```

resourceはPlan / implementation Referenceを内部解決し、native `acceptance.verify`で全`finalVerificationIds`を実行する。

- full verification reportは`file-only` Artifactへ保存する。
- large evidenceに`outputSchema`を付けない。
- statusはnative `ok`、`evidenceStatus`、failed verification IDsで作る。
- child proseの「test passed」を証拠にしない。
- `verificationRef`と`VerificationStatusV1`だけをstateへ保存する。

成功条件:

```text
ok === true
AND evidenceStatus === "verified"
AND required verification evidence exists
```

### 11.9 Verification Fix resource

`pi-workflow.verification-fix` はFinal Verificationがfailedで、fix roundが1または2のときだけ起動する。

前提:

```text
verificationStatus.status === "failed"
round <= 2
planRef exists
verificationRef exists
allowed Write Scope exists in planningDecision
```

target child:

```text
agent: worker
context: fresh
async: false
```

resourceはstateからPlan、bounded PlanningDecision、`verificationRef` / native evidence ref、Write Scopeを解決する。Mainからfailure report本文を渡さない。

Fix後は全`finalVerificationIds`を`pi-workflow.verification`で再実行する。failed commandだけの部分再実行を成功条件にしない。2回後もfailedなら`failed`で停止する。lane focused verification failureへこのresourceをautomatic適用しない。

### 11.10 Review resource

`pi-workflow.review` resolverは`ReviewArgsV1`だけを受け付ける。

#### Fanout

```text
runs.all([
  {
    key: "correctness",
    agent: "reviewer",
    context: "fresh",
    async: false,
    outputMode: "file-only",
    task: reference-based correctness task,
  },
  {
    key: "simplicity",
    agent: "reviewer",
    context: "fresh",
    async: false,
    skill: "ponytail-review",
    outputMode: "file-only",
    task: reference-based simplicity task,
  },
])
```

`runs.all`はordered arrayを返す。結果をkey mapとして仮定せず、ordered resultまたは明示的なkey/value変換で扱う。

correctness / simplicityのlarge proseは各Artifact Referenceへ置く。Ponytailはover-engineering専用で、correctness/security/performance reviewを代替しない。

#### Synthesis

fresh built-in `reviewer`、`context:"fresh"`、`async:false`で両Artifact Referenceを読み、bounded `ReviewDecisionV1`を生成する。synthesisの`outputSchema`はpackage-ownedで、24 KiB aggregate boundを適用する。

`reviewRef`はfanout / synthesis Reference index、`reviewDecision`はMainが必要とするbounded finding/decisionである。full review proseをstateへ保存しない。

#### Review Fix Wave

`fixNow`またはblocking findingがあり、waveが0の場合だけ、`pi-workflow.implementation`を`mode:"review-fix"`、`reviewFixWave:1`、fresh Worker、`async:false`で起動する。reviewRef、planRef、Write Scopeはstateから内部解決する。

fix後は:

```text
all Final Verification
→ full Review fanout
→ synthesis
→ Human Code Review
```

を再実行する。wave 1後にblocking findingが残ったら自動loopしない。

---

## 12. Human / Plannotator Boundary

### 12.1 Main-only authority

次はMain Sessionだけが行う。

- `ask_user_question`
- Plannotator Plan Review
- Plannotator Code Review
- approval / rejection / retry / scope expansion decision
- risk acceptance
- product / architecture decision

child AgentへHuman toolやapproval authorityを移さない。

### 12.2 Human input

Human answer、Plan feedback、explicit retry choiceはMain-origin dataである。boundedなら次phase resource argsへ渡してよい。

```text
humanInputs: 最大8件、各value最大2,048 bytes
large feedback: Artifact / Reference
```

Human Gate invocation自体をapproval evidenceにしない。明示的 `approved: true`だけをapprovalとする。

### 12.3 Plan Review Tool

`pi_workflow_plan_review`は維持するが、full `PlanningDecisionV1` transport interfaceは削除する。

```ts
interface PlanReviewInput {
  missionId: string;
  round: number;
  planRef: ReferenceValue;
}

interface PlanReviewOutput {
  approved: boolean;
  reviewId?: ReferenceValue;
  planRef: ReferenceValue;
  feedbackRef?: ReferenceValue;
}
```

### 12.4 Code Review Tool

`pi_workflow_code_review`もMain-onlyで維持する。small interfaceとする。

```ts
interface CodeReviewInput {
  missionId: string;
  cwd: string;
  reviewRef: ReferenceValue;
}

interface CodeReviewOutput {
  approved: boolean;
  reviewId?: ReferenceValue;
  feedbackRef?: ReferenceValue;
}
```

Plannotator shared event APIを`runtime/plannotator/`へ閉じ込め、slash commandやPlannotator internalsをworkflow scriptから直接呼ばない。

---

## 13. `pi_workflow_prepare_phase` Migration

### 13.1 Target removal

旧interface:

```text
phase + payload
→ pi_workflow_prepare_phase
→ workflowScript + sha256
→ Main
→ raw subagent invocation
```

はtarget architectureで削除する。

`pi_workflow_prepare_phase`をmodel-facing Toolとして登録しない。Mainはphase名と大きなpayloadをToolへ渡さず、canonical named resourceをinvokeする。

### 13.2 Responsibility relocation

| Responsibility | Target owner |
|---|---|
| phase allowlist | 7 canonical resource definitions |
| args validation | resource resolver + `core/phases` shared validator |
| output schema ownership | named resource / phase definition |
| workflow script construction | resource resolver / package-owned `workflow-scripts` |
| child Agent / Skill selection | named resource |
| foreground policy | named resource |
| Mission state/ref prerequisite | resource workflow body |
| transport to Main | **remove** |
| `sha256` return to Main | **remove** |

現行source、Skill、testに残る`prepare-phase`参照はimplementation migrationで更新するが、target designへlegacy Toolを持ち込む理由にはしない。

### 13.3 Hashing

current consumer調査で`workflowScript sha256`をMainが検証する独立consumerは確認されていない。named resourceではnative provenance / script digestがnative boundaryの責務であるため、Main-facing hashを削除する。

独自hash、raw script echo、Main-side integrity protocolを追加しない。将来別の独立consumerが必要になった場合だけ、resource内部またはnative receipt contractとして再設計する。

---

## 14. Fail-closed / Failure Policy

### 14.1 Prerequisite failure

次の場合、child launch前に停止する。

- required named resource unavailable
- duplicate resource registration
- required Agent missing
- required Skill missing
- invalid bounded args
- missing or invalid Mission ref
- cross-Mission Reference
- state limit超過
- Plan not approved
- unresolved decision
- required Plannotator endpoint unavailable
- required `pi-ketch.researcher` unavailable

### 14.2 Execution failure

- child failureをsuccessへ丸めない。
- `ok === false`、stopped、detached、timeout、missing evidenceをsuccessにしない。
- reviewer proseをstructured verdictとしてparseしない。
- `structuredOutput.verdict === "blocked"`だけをexplicit lane blockerとして扱う。
- failure時にCLI、background、別Agent、別protocolへsilent switchしない。
- same-protocol retryはMain/Humanの明示的policy内だけで行う。
- partial diffがある場合は保存し、状態をblocked/failedとしてrecovery可能にする。

### 14.3 Human Gate failure

Plannotator unavailable、cancel、close、error、timeout、invalid resultはapproval fallbackを作らず、未承認として停止する。

`ask_user_question` cancel / non-TUI / errorも未回答としてphaseを進めない。

### 14.4 Scope expansion

Worker/Reviewerがapproved scope外を必要とした場合:

1. current changesを保持する。
2. old Plan approvalを無効化する。
3. Mainへbounded blockerを返す。
4. current treeを前提に新しいPlanning resourceを起動する。
5. canonical Planを再生成する。
6. Main-only Plan Reviewを再実行する。
7. approval後にnew implementation runを起動する。

old WorkUnit execution stateを自動re-mapしない。

---

## 15. Recovery Procedure

独自`/resume`、独自WorkflowState、独自Run Storeを作らない。

Main recoveryは次の順とする。

```text
subagent({ action: "mission.list" })
→ subagent({ action: "mission.show", missionId })
→ linked run status
→ Mission state / Reference確認
→ required capability確認
→ next named resourceを同じmissionIdでinvoke
```

必要な場合だけnative `resume`を使う。recovery source of truthは次である。

- native Mission
- native Mission state
- Artifact References
- native run status
- native patch / handoff / evidence refs

raw `workflowScript`再生成、raw script再transport、full transcript再送をrecovery stepにしない。missing ref時にMainからbodyを再供給しない。

Mission ledgerはrecovery recordであり、schedule、restart、child relaunchを自動実行するengineではない。

---

## 16. Test Strategy

Contract test、native runtime integration、packed install testを分離する。今回のdocument migrationで過去Integration Spikeを再実行しない。future implementationでは、提示済みEvidenceをbaselineとして扱い、未実行capabilityだけを必要なruntime testで証明する。

### 16.1 Core deterministic tests

対象:

- `PlanningDecisionV1` schema / semantic validation
- `ReviewDecisionV1` schema / unique IDs
- `DiscoveryMetadataV1` / `ResearchMetadataV1` / `VerificationStatusV1` bounds
- aggregate JSON byte bounds
- Reference value bounds
- state key allowlist
- canonical `plan.md` deterministic rendering
- WorkUnit配列順の保持
- lane dependency rejection
- Verification Fix max2
- Review Fix wave max1
- fail-closed result interpretation

Pi context、Mission、child executionをmockせずにcore logicを検証する。

### 16.2 Resource contract tests

real childを起動しないdeterministic contract testで次を検証する。

- 7 named resource definitionsがpackageに含まれる。
- canonical nameがuniqueでsafe name constraintを満たす。
- versionがpositiveである。
- 7 resourceがsession registrationされる。
- disposerがsession shutdownで呼ばれる。
- duplicate registrationがrejectされ、既存resourceがusableなままになる。
- valid argsがresolveされる。
- unknown field rejection
- empty string rejection
- non-string rejection
- oversized rejection
- plain JSON / depth / aggregate bound rejection
- resource-owned schemaがMain argsでoverrideできない。
- resource-owned workflow scriptがMain argsでoverrideできない。
- Main raw `workflowScript` transportがない。
- Main schema transportがない。
- large phase payloadをargsへ渡さない。
- required state/refがchild launch前に確認される。
- cross-Mission fallbackが禁止される。
- `async:false`がphase child / `runs.all` entry / `runs.lanes` stageに明示される。
- `outputMode:"file-only"` + schemaなしをlarge outputに使う。
- S2でschema付きstructuredOutputがMain detailsへ残ることを隠蔽前提にしない。
- compact schemaがaggregate bound以内である。

### 16.3 Main / Tool tests

対象:

- 4 command registration
- request type mapping
- empty request rejection
- kickoff message
- active Mission guard
- clean-tree guard
- capability check
- Mission create / attach
- `pi_workflow_plan_review`のsmall interface
- `pi_workflow_code_review`のsmall interface
- Plannotator explicit approval / reject / cancel / error
- Main Toolがfull Plan / report / transcriptを受け取らないこと
- command handlerがresource executionを直接呼ばないこと

### 16.4 Native runtime integration

real `pi-subagents` v0.66.0で次を検証する。

- Mission create / attach
- session-scoped named resource registration
- Discovery full Artifact + compact metadata
- Discovery → Planning `discoveryRef` handoff
- conditional Researcher
- Planning → Implementation `planRef` handoff
- `reviewer + pi-planning`
- single Worker
- reviewer + `pi-verification`
- native acceptance / evidence
- `runs.all` foreground parallel review
- `runs.lanes` foreground overlap / ordering / sibling independence
- managed worktree / native patch / handoff
- failed lane and replacement lane
- Integration Worker
- Verification Fix max2
- review fanout
- reviewer + `ponytail-review`
- Review synthesis
- Review Fix wave max1
- Mission recovery
- Human Gate approval / cancel / failure
- `pi-ketch.researcher` when required
- conditional `oracle`

未実行のcapabilityはruntime blockerとみなさず、capability check requiredとして扱う。ただしproduction release前には上記の該当scenarioをpassさせる。

### 16.5 Packed tests

`pnpm pack`したartifactをclean consumerへinstallして次を確認する。

- Extension load
- peer `pi-subagents@0.66.0`でpublic resource subpathがresolveする。
- 7 named resourceがdiscoverable / invocableである。
- 7 package-owned workflow scriptsがresource内部から解決できる。
- 3 own Skillsがdiscoverableである。
- Plan / Code Review bridgeが登録される。
- `pi-subagents`がbundleされていない。
- source checkout依存の相対pathがない。

### 16.6 CI gate

最低限:

```text
typecheck
lint
format:check
core tests
resource contract tests
Main / Tool tests
native runtime integration tests
packed package tests
```

platform-sensitiveな箇所はmacOS / Linux / Windowsで確認する。ただしcontractを毎回LLM E2Eだけで検証しない。

---

## 17. Definition of Done

```text
[ ] pi-subagents 0.66.0 required peer dependency
[ ] pi-subagents 0.66.0 devDependency
[ ] no dependencies entry for pi-subagents
[ ] no bundled / vendored pi-subagents
[ ] pi-workflow and pi-subagents use the same Pi package scope
[ ] no custom pi-workflow Agents
[ ] native Mission only
[ ] 7 named workflow resources
[ ] session_start registration / session_shutdown disposal
[ ] duplicate registration rejects
[ ] no raw workflowScript Main transport
[ ] resource-owned bounded args
[ ] resource-owned schema
[ ] large phase output is file/reference-backed
[ ] Mission state contains refs/status/bounded structured data only
[ ] Mission state hard limit 256 KiB
[ ] S2 outputSchema visibility policy enforced
[ ] explicit async:false for Main and child/stage execution
[ ] required refs fail closed
[ ] cross-Mission fallback prohibited
[ ] Discovery = scout
[ ] Planning = reviewer + pi-planning
[ ] Verification = reviewer + pi-verification
[ ] conditional pi-ketch.researcher
[ ] Implementation = worker
[ ] correctness review
[ ] Ponytail review
[ ] Plannotator Human Gates
[ ] `pi_workflow_prepare_phase` removed from target Main interface
[ ] Main-facing workflowScript sha256 removed
[ ] Worker Write Scope
[ ] TDD policy
[ ] lane independence / managed worktree
[ ] Verification Fix max2
[ ] Review Fix wave max1
[ ] scope expansion → re-plan
[ ] native Mission recovery
[ ] packed install evidence
```

legacy `7 workflow templates`はpackage internalsの説明に限定し、production orchestration boundaryは`7 named workflow resources`と表記する。

---

## 18. Reference Sources

- Pi Packages: https://pi.dev/docs/latest/packages
- Pi Extensions: https://pi.dev/docs/latest/extensions
- `pi-subagents` v0.66.0 docs: https://github.com/nicobailon/pi-subagents/tree/v0.66.0/docs
- `pi-subagents` v0.66.0 workflow resources public API: https://github.com/nicobailon/pi-subagents/blob/v0.66.0/src/api/workflow-resources.ts
- `pi-subagents` v0.66.0 tagged resource implementation: https://github.com/nicobailon/pi-subagents/blob/v0.66.0/src/workflows/workflow-resources.ts
- Plannotator v0.27.12: https://github.com/backnotprop/plannotator/tree/v0.27.12/apps/pi-extension
- Ponytail v4.9.0: https://github.com/DietrichGebert/ponytail/tree/v4.9.0
- CodeGraph v1.6.0: https://github.com/colbymchenry/codegraph/tree/v1.6.0
- `pi-ketch`: https://github.com/minorunakamura/pi-ketch
- `pi-ask-user-question`: https://github.com/minorunakamura/pi-ask-user-question
