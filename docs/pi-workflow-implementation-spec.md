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
- package-owned Research Agent `pi-workflow.researcher`
- 7 package-owned named workflow resources
- resource-owned workflow scripts
- bounded schema / validation
- Main-only Plannotator bridge
- deterministic core contract tests
- native runtime / packed-package tests

subagent runtime、generic Ketch capabilities、generic Research Agent `pi-ketch.researcher`、Ponytail、Plannotator、ask-user-questionはbundleしない。`pi-workflow.researcher`はpi-workflowが所有するpolicy boundaryであり、generic `pi-ketch.researcher`のreplacementや変更ではない。

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
├── agents/
│   └── package-owned Research Agent definition (`pi-workflow.researcher`)
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

`runtime/` は `core/` とpublic `pi-subagents/workflow-resources` を利用してよい。Research Agent boundaryは、pi-ketchのsupported/public package APIだけを利用する。private `preflight` path、private registry、private Mission store、`pi-ketch/src/**` deep import、pi-ketch private runtime、registered tool internal registry、raw internal executorはimportしない。pi-ketchの具体的なinternal file structureやimplementation detailsをdependency contractにしない。

`commands/` / `tools/` はPiとのadapterとMain-only Human Gateに限定し、resourceの複雑な実処理を持たない。Research Agentのtool policyはper-run adapterではなく、package-owned Agent-level contractで定義する。

`workflow-scripts/` はpackage-owned resourceのstatement bodyであり、Mainから渡されるtemplateではない。arbitrary template path、arbitrary JavaScript、caller-supplied placeholderは受け取らない。

### 2.2 File split rules

ファイル分割は行数ではなく変更理由で判断する。4 commandはrequest type以外が共通なので、4つのcommand fileへ分割しない。

```text
commands/
├── index.ts
└── workflow.ts
```

7 phaseは次の7 resource boundaryへ1対1で対応する。新しい特殊resourceを追加する前に、既存phaseのbounded args / modeで表現できないことを確認する。

package-owned Agent `pi-workflow.researcher`は、supported publicなpi-subagents Agent discovery / registration boundaryからAgent inventoryへ公開する。Agentの物理的な保存場所はこのSOTのcontractに含めず、per-run injectionやprivate registryを使わない。

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
    "skills": ["./skills"],
    "subagents": {
      "agents": ["./agents"]
    }
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

packageのpublish file allowlistを使う場合は、package-owned Agent definitionを含む`agents`を除外しない。

`pi-subagents`のsupported versionはexactly `0.66.0` とする。`^0.66.0`やfloating `latest`をruntime contractにしない。

### 3.2 禁止事項

- `pi-subagents`を`dependencies`へ置かない。
- `pi-subagents`を`bundledDependencies`へ置かない。
- `pi-subagents`をbundle、vendoring、source copyしない。
- Plannotator、Ponytail、`pi-ketch`、`pi-ask-user-question`をbundleしない。
- `pi-workflow.researcher`以外のcustom Agentを`pi.subagents.agents`へ公開しない。
- `pi-workflow.researcher`はpackage-owned Agent-level definitionとして扱い、per-run tool restriction / tool replacement / extension injectionで代用しない。
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
- per-run custom Agent / tool / extension injection
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
| Research | `pi-workflow.research` | 1 | fresh package-owned `pi-workflow.researcher`、conditional | reportはfile-only Artifact、statusはbounded |
| Planning | `pi-workflow.planning` | 1 | fresh `reviewer` + `pi-planning` | `plan.md` Artifact、Decisionはbounded |
| Implementation | `pi-workflow.implementation` | 1 | fresh `worker` | native run / patch / handoff refs |
| Verification | `pi-workflow.verification` | 1 | fresh `reviewer` + `pi-verification` | evidence / report refs、statusはbounded |
| Verification Fix | `pi-workflow.verification-fix` | 1 | fresh `worker` | run/ref、最大2 round |
| Review | `pi-workflow.review` | 1 | `reviewer` fanout + `ponytail-review` + synthesis | findings Artifact、Decisionはbounded |

resource nameをphase template名、Agent名、Main command名と混同しない。Mainが呼ぶcanonical boundaryは上表の`name`である。

`pi-workflow.planning`はPlan Review用のcontrol operationsも所有する。Named Resource数は7のままで、8個目の`pi-workflow.plan-review` resourceは追加しない。

| Operation | Child | Contract |
|---|---|---|
| `plan` | fresh `reviewer` + `pi-planning` | bounded `PlanningDecisionV1`とPlan Artifactを生成 |
| `prepare-review` | zero | Mission-bound review bindingを検証・準備 |
| `record-review` | zero | Mainが解釈したcompact status/evidenceを検証・保存 |
| `review-status` | zero | Mission-bound review metadataをcompactに返す |

`operation` omittedは`operation:"plan"`と同値である。したがってUnit 5の`{ "round": 1 }`を受理し、`operation:"plan"`をmandatoryにしない。4 operationのMain-triggered invocationはすべて`async:false`とする。

### 5.1 Research Agent Capability Contract

Research resourceが使用するAgent nameは`pi-workflow.researcher`である。これは既存の`pi-workflow.<role>` naming conventionに従うpackage-owned Research Agentであり、generic `pi-ketch.researcher`とは別のidentityである。

`pi-subagents v0.66.0`ではper-run field-level tool schema restriction、per-run tool replacement、per-run extension injectionを提供しない。この制約をchild invocationで回避せず、Research policyはAgent-level contractで表現する。

| Agent-level capability | Contract |
|---|---|
| tools | strict tools allowlist |
| extensions | `subagentOnlyExtensions` |
| child | `context:"fresh"`、`async:false`、read-only |

`pi-workflow.researcher`のallowlistは次のKetch capabilitiesだけを利用可能にする。

| Tool / capability | Contract |
|---|---|
| restricted Search Tool | available。generic `ketch_search`をmodelへ直接公開せず、single configured/defaultまたは指定backend searchだけを行う |
| `ketch_code` | available。pi-ketchのgeneric capabilityを再利用し、実装をコピーしない |
| `ketch_docs` | available。pi-ketchのgeneric capabilityを再利用し、実装をコピーしない |
| `ketch_scrape` | available。pi-ketchのgeneric capabilityを再利用し、実装をコピーしない |
| `multi` | **NOT AVAILABLE** |
| `random` | **NOT AVAILABLE** |
| raw arbitrary flags | **NOT AVAILABLE** |

restricted Search Toolのmodel-facing contractは少なくとも次である。

```ts
interface ResearchSearchInput {
  query: string;  // required
  backend?: string; // optional
}
```

追加のsafe search fieldsは、implementation時にcurrent public pi-ketch Search API contractとpi-workflow requirementsから決定する。`multi`、`random`、raw arbitrary flagsは公開しない。

Ownershipは次のとおりである。

| Boundary | Owner |
|---|---|
| generic Ketch capability | `pi-ketch` |
| generic Research Agent `pi-ketch.researcher` | `pi-ketch` |
| pi-workflow Research policy / package-owned Agent `pi-workflow.researcher` | `pi-workflow` |

generic `pi-ketch`、generic `pi-ketch.researcher`、generic `ketch_search`の`multi` support、other pi-ketch consumersはunchangedである。generic `pi-ketch.researcher`がgeneric `ketch_search`（`multi`を含む）を利用する汎用性も変更しない。single-search policyをpi-ketchへ押し込まない。

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

`pi-workflow`はResearch用のpackage-owned Agent `pi-workflow.researcher`だけを持つ。その他のphaseではcustom Agentを追加せず、`scout`、`reviewer`、`worker`、conditional `oracle`などnative capabilityを使用する。

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

type PlanningArgsV2 =
  | {
      operation?: "plan";
      round: number; // integer 1..3
      humanInputs?: HumanInputV1[]; // <= 8
      feedbackRef?: ReferenceValue;
    }
  | {
      operation: "prepare-review";
      round: number; // integer 1..3
      planRef: ReferenceValue;
    }
  | {
      operation: "record-review";
      round: number; // integer 1..3
      planRef: ReferenceValue;
      reviewId: ReferenceValue;
      status: "pending" | "approved" | "rejected";
      feedbackRef?: ReferenceValue;
    }
  | {
      operation: "review-status";
      round: number; // integer 1..3
      planRef: ReferenceValue;
    };

// operation omitted is exactly equivalent to operation:"plan".
type PlanningArgs = PlanningArgsV2;

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

- Planningで`operation`を省略した場合は`plan`として扱う。Unit 5の`{round:1}`をrejectしない。
- `plan`では`round`を必須とし、`humanInputs` / `feedbackRef`はbounded optional inputとする。
- `prepare-review`ではsupplied `planRef`とcurrent Mission stateの`planRef`、current `round`を照合する。
- `record-review`ではcurrent bindingのMission / `round` / `planRef` / `reviewId`を照合する。`status:"rejected"`にはcurrent flowへboundされた`feedbackRef`を要求する。
- `review-status`はsupplied `planRef` / `round`がcurrent Plan Review bindingと一致しない場合rejectする。
- `review-fix`以外のImplementationでは`reviewFixWave`を`0`または省略する。
- `review-fix`では`reviewFixWave === 1`を要求する。
- `verification-fix`の`round`は現在のfailed Verification roundと一致させる。
- `record-review`の`feedbackRef`は同じMission、current Plan Review round、current `planRef`、availableな`reviewId`のpackage-owned Feedback Artifact Referenceでなければrejectする。
- round + 1の`plan`に渡す`feedbackRef`は、同じMissionの直前roundのrejected `planReview` binding（直前round、直前`planRef`、reviewId）へboundされたReferenceでなければrejectする。
- `planRef`、`discoveryRef`、`verificationRef`、target filename、Write Scope、full failure evidenceをargsへ追加しない。これらはresource内部でMission stateから取得する。

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
| `PlanReviewBindingV1` | 8 KiB、current Missionのcurrent Plan Review bindingは1件 |
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
256 KiB = 262,144 serialized UTF-8 bytes
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
planReview

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

Plan ReviewはCode Reviewと別のstate contractである。`planReview`は次のbounded bindingだけを持ち、Plan Markdown、Human feedback prose、full Plannotator payload、browser/UI transcriptを持たない。

```ts
interface PlanReviewBindingV1 {
  version: 1;
  status: "pending" | "approved" | "rejected";
  round: 1 | 2 | 3;
  planRef: ReferenceValue;
  reviewId?: ReferenceValue;
  feedbackRef?: ReferenceValue;
}
```

Approval/rejectionはcurrent Mission、exact Planning/Plan Review round、exact current `planRef`、availableな`reviewId`へbindingする。opaque/path-like Referenceが特定Mission由来であることはpi-subagents v0.66.0でcryptographically proveできない。安全策はNamed Resource Mission binding、current state equality、round/reviewId checks、mismatch時のfail closedである。

`codeApproval`は後段Code Review専用であり、Plan Reviewへ再利用しない。annotation bodyはstateへ保存しない。

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

### 9.6 Plan Review binding validation

`planReview`はPlan Review専用のcompact stateであり、`codeApproval`と同じkey/objectを共有しない。

- `status`は`pending`、`approved`、`rejected`のいずれか。
- `round`は1..3で、current Planning/Plan Review roundと一致する。
- `planRef`はcurrent Mission stateのexact current Plan Referenceと一致する。
- `reviewId`が存在する場合はcurrent Plan Review bindingのIDと一致する。
- `feedbackRef`が存在する場合は同じMission、review round、`planRef`、availableな`reviewId`へboundされたpackage-owned Feedback Artifact Referenceである。
- `prepare-review`はunresolved decision、round mismatch、planRef mismatch、incompatible/stale bindingをrejectする。
- `record-review`はcurrent bindingとstatus transitionを検証し、rejectedには`feedbackRef`を要求する。
- `review-status`はbodyを返さず、bindingのstatus、round、planRef、reviewId、optional feedbackRefだけを返す。
- missing binding、missing reviewIdが必要なrecovery、cross-Mission/cross-round/stale-plan correlationはfail closedとする。
- full Plan、feedback prose、Plannotator payload、UI transcriptはこのstateに入れない。

Plan Reviewのruntime failureはexplicit Human rejectionへ変換しない。cancel、timeout、unavailable、malformed result、feedback Artifact write failureはreplacement reviewや自動re-planを起動せず、Mainがfail closed / needs-decisionとして扱う。

### 9.7 ReviewDecision validation

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

Plan ReviewのFeedback Artifactは、Plannotatorが返す`feedback`をPlan Review bridgeが一時的にprocess memoryで受け取り、package-owned file-backed Artifactへ書く。bridgeは`feedbackRef`だけをorchestration layerへ返す。Plannotatorのoptional `savedPath`はPlan/annotation snapshotであり、`planSave` configuration、global storage、Mission/round bindingに依存するため、canonical `feedbackRef`には使わない。

Plan Artifactとfeedback Artifactのbody boundaryは次である。

```text
Planning Resource: Plan Artifact / planRefを生成・所有
Plan Review bridge: planRefをPlan body/planContentへ解決し、Feedback Artifactを生成
Main model-facing transport: plan body = no、feedback body = no
Mission state: Plan/feedback body = no
bridge process memory: Plannotator feedback body = transiently yes
```

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

Unit 4のResearch semanticsは維持し、今回変えるのはResearch childのownershipとtool policyだけである。

`pi-workflow.research` resolverは`ResearchArgsV1`だけを受け付ける。Discovery report、`discoveryRef`、questions本文をMainから受け取らない。Research resourceはpackage-owned Agent `pi-workflow.researcher`を起動し、generic `pi-ketch.researcher`を直接childとして起動しない。

全branch共通の前提:

```text
discoveryMeta exists
discoveryRef exists
```

`externalResearchRequired === true` branchだけ、次も前提とする。

```text
package-owned pi-workflow.researcher and required Ketch capabilities are available
```

#### `externalResearchRequired === false` — zero-child skip

1. stateから`discoveryRef`と`discoveryMeta`を取得・検証する。
2. このskip pathではResearch Agent / Ketch capabilityを要求しない。
3. Research Agent childを起動しない。
4. 同じMissionへ`researchMeta.status = "skipped"`を保存する。
5. `researchRef`を作成せず、bounded skip resultだけを返す。

#### `externalResearchRequired === true` — Research child

1. stateから`discoveryRef`、`discoveryMeta`、bounded research questionsを取得する。
2. package-owned `pi-workflow.researcher`と、そのAgent-level strict tools allowlist / `subagentOnlyExtensions`、supported/public Ketch capabilitiesを確認する。
3. fresh `pi-workflow.researcher`を `context:"fresh"`、`async:false`、read-only、`outputMode:"file-only"`、schemaなしで1回だけ起動する。
4. child taskへDiscovery Artifact Referenceとbounded research questionsだけを含める。full Discovery reportをMainから再送しない。
5. full reportのnative Artifact Referenceを`researchRef`へ保存する。
6. native result statusから`ResearchMetadataV1`を作成し、stateへ保存する。

Research reportはlarge Artifactであり、Mission state / Main-facing resultへは`researchRef`とbounded `researchMeta`だけを返す。Research Agentがgeneric `ketch_search`を直接呼ばないこと、Searchがsingle configured/defaultまたは指定backendだけであること、`multi` / `random` / raw arbitrary flagsが利用不可であることをAgent-level contractで保証する。`ketch_code`、`ketch_docs`、`ketch_scrape`はpi-ketchのsupported/public generic capabilitiesを再利用する。

```text
large Research body through Main: NO
Mission state: researchRef / bounded researchMeta only
```

Research不要時のzero-child skip、Research childのfailure、required capability unavailable、foreground failure、Artifact / Reference / state保存 failureはすべてfail closedとする。background、別CLI、generic `pi-ketch.researcher`への自動切替は行わない。Main-only Human clarification boundaryは変更せず、Research childからHumanへ質問しない。

### 11.3 Planning resource

`pi-workflow.planning` resolverは`PlanningArgsV2`だけを受け付ける。`operation` omittedは`operation:"plan"`として扱い、Unit 5の次のinvocationを維持する。

```json
{
  "round": 1
}
```

#### `operation:"plan"`（fresh child）

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

valid decisionからpackage-owned deterministic rendererでcanonical `plan.md`を生成し、file-backed Artifactの`planRef`をstateへ保存する。Plan rendererはWorkUnit配列順を保持し、dependencyを再計算しない。Planning Decisionのfull JSONとcanonical Plan Artifactを同じものとして扱わない。

#### `operation:"prepare-review"`（zero child）

Mainは次をinvokeする。

```text
Main
→ pi-workflow.planning / prepare-review
```

Planning Resourceのworkflow scriptが次を順に行う。

```text
state.get
→ validate Planning state
→ validate current planRef (`state.planRef === supplied planRef`)
→ validate current Plan Review round
→ validate unresolvedDecisions is empty
→ validate no incompatible/stale `planReview` binding
→ persist compact pending preparation/binding as required
→ return compact `ready` or `pending` result
```

`planRef`は`pi-workflow.planning`が生成するopaque/path-like Referenceであり、Mainがそのoriginを独立またはcryptographically proveする契約ではない。same-Mission/current-state equality、round check、binding check、mismatch時のfail closedがv0.66.0で利用できるvalidationである。pending `planReview` bindingがある場合は`pending`を返し、新しいPlannotator startを許可しない。

#### `operation:"record-review"`（zero child）

MainがPlannotator resultの意味を解釈した後、次をinvokeする。

```text
Main
→ pi-workflow.planning / record-review
```

Resourceは次を行う。

```text
state.get
→ validate current planRef
→ validate round
→ validate reviewId/current review binding when available
→ validate status transition
→ validate feedbackRef when status is rejected
→ state.set compact Plan Review evidence
```

ResourceはHuman responseのsemantic meaningを決めない。受け付けるstatusは`pending` / `approved` / `rejected`だけであり、`rejected`にはsame-Mission/current-round/current-planRef/current-review bindingのbounded `feedbackRef`を要求する。runtime failureをrejectedへ変換しない。

#### `operation:"review-status"`（zero child）

Resourceは`state.get`し、次だけを返す。

```text
status
round
planRef
reviewId
feedbackRef?
```

Plan body、feedback body、Plannotator payload、browser/UI transcriptは返さない。

### 11.4 Planning Human Gate bridge

Plan ReviewはMain-owned Human Gateであり、Named Resourceのchildではない。Main-facing inputは次のsmall contractだけである。

```ts
interface PlanReviewInput {
  missionId: string;
  round: number;       // 1..3
  planRef: ReferenceValue;
}
```

Mainはnative Mission `state.get/state.set`を直接呼ばない。まず`prepare-review`のcompact resultを受け、validated `planRef`をMain-only Plan Review bridgeへ渡す。

bridgeのtarget sequenceは次である。

```text
Main
→ planning / prepare-review
→ Plan Review bridge(planRef)
→ bridge resolves Plan Artifact → planContent
→ Plannotator start
→ `record-review(status:"pending", reviewId)`でbindingを保存
→ result or review-status(reviewId)
→ Main interprets
→ planning / record-review
```

bridgeはPlan Artifactを内部readし、current Plannotator public APIの`planContent` required inputを満たす。`planFilePath`はoptionalであり、path-only integrationを要求しない。full Plan bodyをMain model-facing input/result、Mission state、`feedbackRef`へコピーしない。

Current Plannotator public behavior:

| Boundary | Public behavior |
|---|---|
| `start` | `planContent` required、`planFilePath` optional |
| result | `reviewId`、`approved`、`feedback`、`savedPath?` |
| `review-status` | `reviewId`でquery |

bridgeはshared event APIの`plannotator:request`、`plan-review`、`plannotator:review-result`、`review-status`を利用する。

`savedPath`はcanonical feedback referenceではない。optionalで`planSave` configurationに依存し、Plan/annotation snapshotであってfeedback-only Artifactではなく、Plannotator/global storageに属し、Mission/round bindingを持たないためである。Feedbackはbridgeが`feedback` stringを一時的にprocess memoryで扱い、package-owned file-backed Feedback Artifactを書き、`feedbackRef`だけを返す（Candidate B）。Mainへfull feedback bodyを返さず、Mission stateへ埋め込まない。

`approved === true`だけがHuman approvalである。request sent、browser opened、result exists、approved missing、cancel、timeout、unavailable、error、malformed responseはapprovalではない。`approved:false` + valid Human rejection resultだけがrejectionであり、runtime failureとは区別する。rejectionでroundが残る場合はMainが`pi-workflow.planning`の`plan`を`round: current + 1`、`feedbackRef`、`async:false`でinvokeし、round 3 rejectionではround 4を起動しない。上限到達時はcanonical Mission status policyに従ってstop / `needs_decision` / fail closedとする。

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
- Plan Reviewを開始するタイミングの決定
- Main-only Plan Review bridgeのinvoke / coordinate
- Plannotator Plan Review / Code Review
- approval / rejection / retry / scope expansion decision
- Plannotator resultのpending / approved / rejected / failure interpretation
- phase advancement
- re-planningを開始するかどうか
- risk acceptance
- product / architecture decision

child AgentやNamed ResourceへHuman toolやapproval authorityを移さない。Named ResourceはMission stateを読んでbindingを検証・保存できるが、Human responseのsemantic meaningを決定しない。

Mainはnative Missionの直接state APIを必要としない。Mission state accessはPlanning Resourceを含むNamed Resourceのworkflow scriptが行う。`src/missions/*` private import、Mission filesystem store path guessing、raw persistence、private registry/internal APIは禁止する。

### 12.2 Human input and body boundary

Human answer、Plan feedback、explicit retry choiceはMain-origin dataである。boundedなら次phase resource argsへ渡してよい。

```text
humanInputs: 最大8件、各value最大2,048 bytes
Plan body through Main model-facing transport: NO
full feedback body through Main model-facing transport: NO
Mission state: Plan body / feedback body = NO
Plan Review bridge process memory: feedback body = transiently YES
```

Plan Artifactを生成・所有するのはPlanning Resource、`planRef`をPlan body/`planContent`へresolveするのはPlan Review bridge、Human Gateのcoordinationとsemantic interpretationを行うのはMainである。

Human Gate invocation自体をapproval evidenceにしない。明示的 `approved: true`だけをapprovalとする。Plannotatorのoptional `savedPath`はfeedbackRefのnormative sourceにしない。

### 12.3 Plan Review Tool / bridge

`pi_workflow_plan_review`はMain-only bridgeの入口として維持するが、full `PlanningDecisionV1`、Plan body、feedback bodyのtransport interfaceは削除する。Mainはまず`pi-workflow.planning / prepare-review`をinvokeする。

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

bridgeはvalidated `planRef`からPlan Artifactを内部readして`planContent`を作り、Plannotator public eventへ渡す。resultの`feedback`はbridge-owned Feedback Artifactへ書き、Mainへ`feedbackRef`だけを返す。`savedPath`はoptional snapshotでありcanonical feedbackRefではない。

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
- package-owned `pi-workflow.researcher` or required supported/public Ketch capability unavailable

### 14.2 Execution failure

- child failureをsuccessへ丸めない。
- `ok === false`、stopped、detached、timeout、missing evidenceをsuccessにしない。
- reviewer proseをstructured verdictとしてparseしない。
- `structuredOutput.verdict === "blocked"`だけをexplicit lane blockerとして扱う。
- failure時にCLI、background、別Agent、別protocolへsilent switchしない。
- same-protocol retryはMain/Humanの明示的policy内だけで行う。
- partial diffがある場合は保存し、状態をblocked/failedとしてrecovery可能にする。

### 14.3 Human Gate failure

`approved === true`だけをapproval successとする。`approved:false`かつvalidなHuman responseはexplicit rejectionとして扱えるが、cancel、close、error、timeout、unavailable、malformed result、`approved` missingはrejectionへ丸めない。これらはruntime failureとしてfail closedし、自動re-planを起動しない。

Plan Review bridgeのFeedback Artifact write failureもruntime failureであり、`feedbackRef`なしのrejected recordを作らない。Mission-bound pending reviewがある場合はduplicate Plannotator startを行わず、recovery contractへ移る。

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

独自`/resume`、独自WorkflowState、独自Run Storeを作らない。Mainはnative Mission state APIを直接呼ばず、Mission state accessはNamed Resource workflow scriptに限定する。`src/missions/*` private import、Mission store filesystem path guessing、raw persistence access、private registry/internal APIを使わない。

### 15.1 Plan Review recovery split

```text
Main
→ pi-workflow.planning / review-status
→ compact Mission-bound { status, round, planRef, reviewId, feedbackRef? }
→ Plan Review bridge recoverReviewStatus(reviewId)
→ Main interprets Plannotator result
→ new terminal resultなら pi-workflow.planning / record-review
```

Planning ResourceはMission state / binding lookupを行い、Plan Review bridgeはPlannotator `review-status(reviewId)`を行う。Mainがpending / approved / rejected / failureを解釈して次のphase、re-plan、停止を決定する。

Mission-bound pending reviewが存在する場合は、second Plannotator reviewをinvokeしない。`reviewId` missing、binding incomplete、round mismatch、planRef mismatch、stale review、unknown correlationの場合はreplacement reviewをstartせず、latest/global resultを使わず、needs-decision / fail closedとする。

### 15.2 General recovery and crash window

Main recoveryは次の順とする。

```text
subagent({ action: "mission.list" })
→ subagent({ action: "mission.show", missionId })
→ linked run status
→ Mission state / Reference確認（Named Resource経由）
→ required capability確認
→ next named resourceを同じmissionIdでinvoke
```

Plan Review startとMission state persistenceはcurrent public APIではone atomic transactionにできない。external Plannotator review start後、Mission binding persistence前にcrashするnarrow windowがある。recoveryでMission、round、planRef、reviewIdのbindingを証明できない場合は、replacement reviewを自動launchせずstop in needs-decision / fail closedとする。

必要な場合だけnative `resume`を使う。recovery source of truthは次である。

- native Mission
- native Mission state（Named Resourceが取得するcompact binding）
- Artifact References
- native run status
- native patch / handoff / evidence refs

raw `workflowScript`再生成、raw script再transport、full transcript再送をrecovery stepにしない。missing ref時にMainからbodyを再供給しない。

Mission ledgerはrecovery recordであり、schedule、restart、child relaunchを自動実行するengineではない。

---

## 16. Test Strategy

Contract test、native runtime integration、packed install testを分離する。今回のdocument migrationで過去Integration Spikeを再実行しない。Unit 5.1のnative validation isolation、bounded `PlanningDecisionV1`、file-backed Plan Artifact、`planRef`、S2、CodeGraph Discovery policyはこのadjustmentで変更しない。future implementationでは、提示済みEvidenceをbaselineとして扱い、未実行capabilityだけを必要なruntime testで証明する。

### 16.1 Core deterministic tests

対象:

- `PlanningDecisionV1` schema / semantic validation
- `PlanningArgsV2` discriminator、operation omitted → `plan`、Unit 5 `{round:1}` compatibility
- `PlanReviewBindingV1` status / round / planRef / reviewId / feedbackRef bounds
- `prepare-review` / `record-review` / `review-status` zero-child and state transition contract
- `ReviewDecisionV1` schema / unique IDs
- `DiscoveryMetadataV1` / `ResearchMetadataV1` / `VerificationStatusV1` bounds
- package-owned `pi-workflow.researcher` Agent-level strict tools allowlist / `subagentOnlyExtensions`
- restricted Search Tool contract (`query` required、`backend` optional、single search only、no `multi` / `random` / raw arbitrary flags)
- `ketch_code` / `ketch_docs` / `ketch_scrape` reuse without copying implementation
- supported/public pi-ketch API boundary and no private/deep/internal dependency
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
- Planning `plan` / `prepare-review` / `record-review` / `review-status` branchが正しくresolveされる。
- operation omittedが`plan`へresolveされる。
- control operationsがzero childである。
- `prepare-review`のplanRef / round / unresolvedDecisions / stale-binding validationがある。
- `prepare-review`がmissing / unreadable Plan Artifactをfail closedにする。
- `record-review`のpending / approved / rejected、reviewId、feedbackRef validationがある。
- `record-review`がmissing feedbackRef、stale planRef、stale round、stale reviewIdをrejectする。
- cross-Mission isolationがある。
- bridgeのFeedback Artifact、feedback write failure、Plan body / feedback bodyのMain result/state exclusionを検証する。
- `review-status`がpending / approved / rejectedをcompactに返し、missing reviewId recoveryをfail closedにする。
- pending duplicate review preventionがある。
- round + 1 Planningがsame-Mission feedbackRefを使う。
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
- Mainがnative Mission state APIを直接呼ばないこと
- `prepare-review` → bridge → Plannotator start/status → `record-review` sequence
- Plannotator public payloadの`planContent` required / `planFilePath` optional
- Feedback Artifact write、bounded `feedbackRef`、savedPath非normative
- Plannotator explicit approval / valid rejection / cancel / error / timeout / unavailable / malformed response
- pending reviewでduplicate Plannotator launchをしないこと
- missing reviewId / incomplete correlation / stale round/planのfail closed
- Main Toolがfull Plan / report / transcriptを受け取らないこと
- command handlerがresource executionを直接呼ばないこと

### 16.4 Native runtime integration

real `pi-subagents` v0.66.0で次を検証する。

- Mission create / attach
- session-scoped named resource registration
- Discovery full Artifact + compact metadata
- Discovery → Planning `discoveryRef` handoff
- conditional package-owned `pi-workflow.researcher` and supported/public Ketch capabilities
- Planning → Implementation `planRef` handoff
- Planning `plan` / `prepare-review` / `record-review` / `review-status`
- Unit 5 `{round:1}` invocation with omitted `operation`
- `reviewer + pi-planning`
- Plan Review bridge Plan Artifact → `planContent`
- bridge-owned Feedback Artifact / `feedbackRef`
- pending review recovery and duplicate-start prevention
- stale cross-Mission / cross-round / stale-plan rejection
- explicit Human rejection vs cancel/error/unavailable failure
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
- package-owned `pi-workflow.researcher` restricted Research Agent when required
- supported/public Ketch capabilities (`ketch_code` / `ketch_docs` / `ketch_scrape` and restricted Search Tool)
- generic `pi-ketch.researcher` / generic `ketch_search` `multi` support remain unchanged
- conditional `oracle`

未実行のcapabilityはruntime blockerとみなさず、capability check requiredとして扱う。ただしproduction release前には上記の該当scenarioをpassさせる。

### 16.5 Packed tests

`pnpm pack`したartifactをclean consumerへinstallして次を確認する。

- Extension load
- peer `pi-subagents@0.66.0`でpublic resource subpathがresolveする。
- package-owned Agent `pi-workflow.researcher`がAgent-level strict tools allowlist / `subagentOnlyExtensions`付きでdiscoverable / invocableである。
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
[ ] package-owned Research Agent `pi-workflow.researcher`
[ ] `pi-workflow.researcher` uses Agent-level strict tools allowlist / `subagentOnlyExtensions`
[ ] no other custom pi-workflow Agents
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
[ ] Planning operations = plan / prepare-review / record-review / review-status
[ ] omitted Planning operation preserves Unit 5 `plan`
[ ] control operations are zero-child
[ ] compact Plan Review binding is separate from codeApproval
[ ] Main is sole Human authority
[ ] Mission state access is Resource-mediated; no Main native state API assumption
[ ] Plan Review bridge resolves planRef to planContent
[ ] bridge-owned Feedback Artifact and bounded feedbackRef
[ ] Plannotator savedPath is non-normative
[ ] pending duplicate review prevention and split recovery
[ ] incomplete correlation / crash window fails closed
[ ] max Plan Review rounds = 3; round 3 rejection has no round 4
[ ] Verification = reviewer + pi-verification
[ ] Research = package-owned `pi-workflow.researcher` with restricted single-search policy
[ ] Research Agent has `ketch_code` / `ketch_docs` / `ketch_scrape`
[ ] Research Agent does not expose generic `ketch_search` directly
[ ] Research Agent does not expose `multi` / `random` / raw arbitrary flags
[ ] only supported/public pi-ketch API is used
[ ] generic pi-ketch, generic `pi-ketch.researcher`, generic `ketch_search` `multi` support, and other consumers are unchanged
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
