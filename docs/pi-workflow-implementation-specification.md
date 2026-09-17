# pi-workflow Implementation Specification

- **Document status**: Implementation-ready specification
- **Project / package**: `pi-workflow`
- **Purpose**: 確定済みArchitectureをproduction implementationへ変換するための実装契約
- **Production implementation**: 本作業では開始しない
- **Canonical Architecture**: `docs/pi-workflow-architecture.md`
- **Directory structure basis**: `/Users/minoru/Documents/mywork/pi-extension-skill-directory-structure.md`

この文書はArchitectureの再設計ではない。Architectureで固定されたauthority、phase、identity、transport、fail-closed条件を変更せず、別のimplementation agentが追加設計なしでrepository/packageを作成し、実装を開始できる粒度を定義する。

Traceability notation:

- `[A:n]`: `pi-workflow-architecture.md` のsection n
- `[S:path]`: current source / public documentation
- `[E:path]`: runtime evidence report
- `[D]`: このImplementation Specificationで確定したDesign Decision
- `[ID]`: production implementation時に決めるImplementation Detail

Evidence/status wording:

- `Runtime-confirmed`: 記載したruntime/evidenceで実際に観測した範囲だけを指す。
- `Source-confirmed`: current sourceで確認した範囲を指す。
- `Spec-confirmed`: public documentation/specで確認した範囲を指す。
- `Design Decision`: evidenceをもとにproductionへ採用する設計上の選択を指す。
- `Implementation Detail`: Architecture invariantを満たす最小実装として実装時に決める事項を指す。
- `Deferred`: v1へ持ち込まず、別Decision/設計へ送る事項を指す。

---

## 1. Purpose and Scope

### 1.1 Purpose

`pi-workflow`を新規Pi package/repositoryとして実装する。entry pointは次の4つである。

```text
/wf-feature <request>
/wf-bug <request>
/wf-chore <request>
/wf-hotfix <request>
```

Root ExtensionをRoot Control Planeとして、Root Parent LLMの内部turnなしでPlanning CoordinatorとImplementation Coordinatorをpublic `pi-subagents` RPCから非同期起動する。

### 1.2 In scope

- `WorkflowType`をfirst-class modelとして扱う。
- Root lifecycle、identity、phase transition、cancellation、failure outcomeをmachine-enforcedにする。
- conditional Planning graphとWorkflow Policy hookを実装する。
- PlanningとImplementationを別Coordinator runとして実装する。
- `implementation-plan.md`、`planning-handoff.json`、Root-owned Approval Identityをphase boundaryにする。
- Root-owned Human Decision BridgeとPlannotator Bridgeを実装する。
- Worker、Reviewer、Implementation Coordinatorのauthorityを分離する。
- Trusted Gate、Finding、Disposition、Fix Wave、Focused Re-review、Final Diff Inspection、Ready-for-Mergeを実装する。
- managed artifact mechanism、small Root state、correlation、idempotencyを実装する。
- `pnpm check`をlocal/CI quality gateにする。

### 1.3 Out of scope

- Architectureの再設計。
- `change-workflow-legacy`からのcode migration、module structure移植、段階改修。
- legacy cutover、disable scheduling、runtime switch、rollback、coexistence。
- production source、Extension、Skill、tests、Smoke fixtureの今回の変更。
- new `pi-workflow` repositoryの今回の作成。
- merge、push、release、deploy automation。
- fixed progress card、`workflow_status` polling UI、new monitoring UI。
- private Pi API、private `pi-subagents` module、Plannotator internal moduleへの依存。
- arbitrary dynamic multi-agent topology。
- upstream Skillのcopyまたはrewrite。

**Traceability**: `[A:1,3,7,8,43,44]` `[D]`

---

## 2. Inputs and Baseline

### 2.1 Canonical input

最優先で次を読む。Architectureのdecisionとinvariantはこのdocumentより優先される。

```text
/Users/minoru/Documents/mywork/pi-subagents-smoke/docs/pi-workflow-architecture.md
```

### 2.2 Fixed baseline

```text
Pi:              0.85.1
pi-subagents:    0.68.0
revision:        f3ccf47dc236b6c0fcc0d897cec4a9e6da3e916d
Historical only: d9864f8288152e83270f62090d7d66eb5ff729bb
```

`d9864f8288152e83270f62090d7d66eb5ff729bb`はv0.67 regression verification historyであり、current production baselineにしない。

### 2.3 Runtime evidence used

以下をArchitectureから引き継ぐ。Full Smoke sequenceはcapability composition evidenceであり、universal mandatory pipelineではない。

```text
docs/phase-a-smoke-results.md
docs/b0-investigation-results.md
docs/b0-2-ketch-tool-loss.md
docs/pr-2143-ketch-verification.md
docs/grilling-nested-capability-results.md
docs/human-bridge-tui-results.md
docs/plannotator-direct-api-results.md
docs/v068-worker-reviewer-capability-results.md
docs/implementation-composition-results.md
docs/phase-handoff-capability-results.md
docs/full-workflow-composition-results.md
docs/human-bridge-capability-results.md
/Users/minoru/Documents/mywork/pi-subagents-result-delivery-report.md
```

Primary evidenceの扱い:

- Human success path: `human-bridge-tui-results.md`。旧timeout-only resultは成功証拠にしない。
- Researcher/Ketch current baseline: `v068-worker-reviewer-capability-results.md`。v0.67 failureとhistorical candidateは原因・比較の証拠だけにする。
- Parent wake suppression: acknowledged `resultDelivery` pathを使用したruntime evidence。global host prerequisiteの追加調査は`/Users/minoru/Documents/mywork/pi-subagents-result-delivery-report.md`を参照する。
- Plan/code review: direct shared event API evidence。
- Phase handoff: separate run、hash binding、fresh Implementation evidence。
- Implementation composition: Worker、Gate、Reviewer、Finding、Fix、Re-review、Readiness evidence。

### 2.4 Current environment/package metadata inspection

仕様作成時点で確認した値。local PATHには`oxlint`、`oxlint-tsgolint`、`biome`、`vitest`、`tsc`は存在せず、installed CLI versionとしては扱わない。toolchain versionはregistry metadataと既存package lock/sourceを根拠に、new packageのmanifestへexact pinする。

| Component | Observed value | Source / note |
| --- | --- | --- |
| Node | `24.16.0` | installed environment |
| pnpm | `11.22.0` | installed CLI |
| `oxlint` | `1.83.0` | current registry metadata |
| `oxlint-tsgolint` | `7.0.2001` | current registry metadata、Oxlint peer requirement |
| `@biomejs/biome` | `2.5.13` | current registry metadata、`pi-ask-user-question` lockでもresolved |
| `vitest` | `5.0.1` | current registry metadata |
| TypeScript | `7.0.2` | current registry metadata、current tsgolint docsは7.0+を要求 |
| `@types/node` | `26.5.1` | current registry metadata |
| `typebox` | `1.3.31` | current registry metadata、host Piはpeerとして提供 |
| Pi core package | `@earendil-works/pi-coding-agent@0.85.1` | installed Pi package metadata |
| `pi-subagents` | `0.68.0` | installed package metadata |
| `pi-intercom` | `0.13.0` | current registry metadata、runtime source evidence |
| `pi-ask-user-question` | `1.0.0` | current registry metadata / installed source |
| Plannotator | `@plannotator/pi-extension@0.27.14` | installed package metadata |
| `pi-ketch` | `1.0.0` | conditional external Researcher prerequisite |

### 2.5 No new verification

このSpecification作成中にnew runtime smoke、fixture、production probe、source modificationは実行していない。今回の確定事項は既存Architecture、既存evidence、およびresultDelivery追加調査に基づく。未固定の事項はImplementation DetailまたはDeferredとして分類する。

**Traceability**: `[A:2,6,40,41,42]` `[E:phase-a-smoke-results.md, b0-investigation-results.md, v068-worker-reviewer-capability-results.md, full-workflow-composition-results.md, /Users/minoru/Documents/mywork/pi-subagents-result-delivery-report.md]` `[S:/Users/minoru/.pi/agent/npm/node_modules/pi-subagents/package.json]`

---

## 3. Fixed Architecture Constraints

次は実装変更不可のinvariantである。

```text
Project/package = pi-workflow

Root Extension = Root Control Plane
Root Parent LLM is not workflow orchestrator
Root Parent LLM is not workflow state holder
Root Parent LLM is not phase transport
Root Parent LLM is not finding synthesis owner

WorkflowType is first-class
Planning and Implementation use separate Coordinator runs
Planning is a conditional graph
Full Smoke flow is not a mandatory universal pipeline
Planning Coordinator owns Planning-stage selection
Human interaction is Root-owned
Plannotator transport is Root-owned
Plannotator plan mode is not used
implementation-plan.md is canonical execution content
planning-handoff.json is immutable Planning-owned metadata
Approval Identity is Root-owned
Root does not rewrite planning-handoff.json after approval

Implementation input = Plan Artifact + Planning Handoff + Root-owned Approval Identity
Worker owns bounded source implementation
Reviewer is fresh and read-only
Reviewer does not directly control Worker
Implementation Coordinator owns Finding normalization/disposition
Raw child reports do not enter Root Parent model context
Ready-for-Merge is fail-closed
Mandatory / required Trusted Gates must PASS
Optional Gate SKIPPED alone is not a blocker

same Root session = one active workflow only
cross-session / cross-process global registry = unsupported in v1
same cwd concurrent workflow across sessions = operationally prohibited; no machine guarantee
policy source = pi-workflow package built-in; project/operator override unsupported
Coordinator maxSubagentDepth = 2 fixed safety ceiling
unbounded nesting / arbitrary multi-agent topology unsupported
coordinator timeout = wall-clock outer safety cap; no pause while waiting
```

### 3.1 Authority rules

| Role | Allowed authority | Not allowed |
| --- | --- | --- |
| Root Extension | lifecycle、phase、identity、Human/Plannotator transport、cancellation | Parent LLMへのorchestration委譲 |
| Planning Coordinator | Planning-stage selection、capability orchestration、plan composition、handoff creation | source implementation、plan approval |
| Planning capability | read-only evidenceまたはdecision clarification | source write、approval |
| Implementation Coordinator | Worker/Gate/Reviewer orchestration、Finding normalization/disposition、readiness | source direct edit、merge |
| Worker / Fix Worker | approved scope内のsource/test write | merge、push、release、deploy |
| Reviewer | fresh/read-only inspection、raw finding report | source edit、Worker direct control、approval |
| Human | decision、plan/code approval | Rootを迂回したphase mutation |

### 3.2 Context rules

- Planning transcript、Implementation transcript、raw report、full diff、full logをRoot Parent LLMへ送らない。
- childとのlarge outputは`outputMode: "file-only"`、managed artifact、`outputReference`、`artifactPaths`で渡す。
- Root Extensionから`pi.sendUserMessage()`でworkflow promptを送らない。
- `pi.events`はprocess-local。cross-process child↔Rootは`pi-intercom` Extension Channelとmanaged artifactを使う。
- `pi-subagents` private sourceはimportしない。

### 3.3 Legacy boundary

`/Users/minoru/Documents/mywork/change-workflow-legacy/`はreference-onlyである。参照してよいのはuser-facing UX、`/wf-*` semantics、historical approval/review behavior、problem evidenceだけであり、source/module/file structureは新packageへ移植しない。

**Traceability**: `[A:7,10,34,38]` `[D]`

---

## 4. Development Toolchain

### 4.1 Fixed responsibilities

| Tool | Responsibility | Must not own |
| --- | --- | --- |
| `pnpm` | dependency、scripts、lockfile | lint、format、test |
| `oxlint` + `oxlint-tsgolint` | JavaScript/TypeScript lint、type-aware lint rule execution | formatting、独立したtypecheckの代替 |
| Biome | formatting | primary lint、lint rule enforcement |
| Vitest | tests、watch/non-interactive test execution | typecheck、lint |
| `tsc` | TypeScript compiler/type checking | lint policy |

`oxlint-tsgolint`は独立した`tsgolint` scriptとして二重実行しない。`oxlint --type-aware`がtype-aware lintを起動し、`tsc --noEmit`はcompiler diagnosticsを独立して担当する。

### 4.2 Exact package scripts

`package.json`は少なくとも次を含める。

```json
{
  "scripts": {
    "lint": "oxlint --type-aware --deny-warnings .",
    "format": "biome format --write .",
    "format:check": "biome format .",
    "test": "vitest",
    "test:run": "vitest run",
    "typecheck": "tsc --noEmit",
    "check": "pnpm typecheck && pnpm lint && pnpm format:check && pnpm test:run"
  }
}
```

理由:

- `vitest`はdevelopmentでwatch modeに入り、`vitest run`はsingle non-interactive runになる。[S: `https://vitest.dev/guide/cli`]
- Biomeのformat-only no-write checkは`biome format .`。`biome check` / `biome ci`はlintも実行し得るため、`format:check`には使わない。[S: `https://biomejs.dev/reference/cli/`]
- Oxlintのtype-aware CLIは`oxlint --type-aware`であり、`oxlint-tsgolint`が必要。[S: `https://oxc.rs/docs/guide/usage/linter/type-aware`]
- `pnpm install --frozen-lockfile`はlockfileを更新せず、CIでmanifest/lock mismatchを失敗させる。[S: `https://pnpm.io/cli/install`]

Lint quality invariant:

- production implementationの各Step完了時、`pnpm lint`は0 warnings / 0 errorsでなければならない。
- lint warningを解消するためにtype-aware lint、TypeScript strictness、runtime validation、fail-closed semanticsを弱めてはならない。
- runtime validation境界では、unsafe type assertionよりtype guardまたはtyped constructionを優先する。
- lint ruleのglobal disableまたはblanket suppressionは、Specificationで明示された例外がない限り使用しない。

### 4.3 `tsconfig.json`

初期設定は次とする。`noEmit`によりPiがsource TypeScriptを直接loadするpackage形態とcompiler checkを分離する。

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "strict": true,
    "noEmit": true,
    "skipLibCheck": true,
    "verbatimModuleSyntax": true,
    "isolatedModules": true,
    "allowImportingTsExtensions": true,
    "forceConsistentCasingInFileNames": true,
    "noUncheckedIndexedAccess": true,
    "exactOptionalPropertyTypes": true,
    "types": ["node"]
  },
  "include": ["src/**/*.ts", "tests/**/*.ts"],
  "exclude": ["node_modules", ".pi", "coverage"]
}
```

### 4.4 `.oxlintrc.json`

Current official config filenameとして`.oxlintrc.json`を採用する。`oxlint.config.ts`もcurrent CLIで使用可能だが、lint config自体をTypeScript compile対象に増やさない。

```json
{
  "$schema": "./node_modules/oxlint/configuration_schema.json",
  "plugins": ["typescript"],
  "options": {
    "typeAware": true
  },
  "categories": {
    "correctness": "error",
    "suspicious": "warn"
  },
  "ignorePatterns": ["node_modules/**", ".pi/**", "coverage/**"]
}
```

Biomeにlint rulesを追加しない。Biome configの`linter.enabled`はfalseにして責務境界を明示する。

### 4.5 `biome.json`

```json
{
  "$schema": "https://biomejs.dev/schemas/2.5.13/schema.json",
  "files": {
    "includes": [
      "src/**/*.ts",
      "tests/**/*.ts",
      "package.json",
      "tsconfig.json",
      "biome.json",
      ".oxlintrc.json"
    ]
  },
  "formatter": {
    "enabled": true,
    "formatWithErrors": false,
    "indentStyle": "space",
    "indentWidth": 2,
    "lineEnding": "lf"
  },
  "linter": {
    "enabled": false
  }
}
```

Agent MarkdownはYAML frontmatterを含むため、初期Biome対象から除外する。READMEとagent promptのformat policyは手動レビューし、Biomeに無理に通さない。

`.gitignore`には少なくとも次を含める。

```text
node_modules/
coverage/
.pi/subagents/
*.tsbuildinfo
```

### 4.6 Version and pinning policy

`package.json`のtooling `devDependencies`は`^`/`~`を使わず、仕様作成時に確認したexact versionを記録する。`pnpm-lock.yaml`を必ずcommitし、CIはfrozen installを使う。

```text
packageManager: pnpm@11.22.0

@biomejs/biome: 2.5.13
oxlint: 1.83.0
oxlint-tsgolint: 7.0.2001
typescript: 7.0.2
vitest: 5.0.1
@types/node: 26.5.1
typebox: 1.3.31
```

Toolchain major/minorを更新する場合はlockfileだけを更新せず、`pnpm check`、Pi baseline compatibility、Oxlint/tsgolint compatibilityを確認してから別変更にする。

Dependency変更の操作はpnpmに限定する。

```bash
pnpm add <runtime-package>       # production dependencies only
pnpm add -D <tool>@<exact-version>  # development/toolchain dependencies
pnpm install
pnpm install --frozen-lockfile
```

初期manifestでは`dependencies`を空にし、Pi host packageはpeer、toolchainはexact `devDependencies`とする。`npm`、`yarn`、`bun`はpackage manager候補として扱わない。ESLintとPrettierも導入しない。

**Traceability**: `[A:9,35,40,41]` `[S:Pi 0.85.1 docs/extensions.md; Pi packages.md; official Oxlint/Biome/Vitest/TypeScript/pnpm docs]` `[D]`

---

## 5. Package / Repository Layout

### 5.1 Recommended repository tree (reference decomposition)

初回実装で作成する責務境界のrecommended/reference decompositionを示す。これはexact mandatory internal file layoutではない。`src/`、`commands/`、`events/`、`runtime/`、`core/`、`agents/`、`docs/`、`tests/`の責務境界、`src/index.ts`、4つの`/wf-*` entry、Planning Coordinator、Implementation Coordinator、`implementation-plan.md`、`planning-handoff.json`は維持する。それ以外のinternal file name、fileの統合・分割、export/function nameはArchitecture invariantを満たす限りproduction implementation時に決めてよい。`tools/`、`ui/`、`skills/`、global `types.ts`は初期責務がないため先に作成しない。test file/class/function nameもこのtreeで固定しない。

```text
pi-workflow/
├── src/
│   ├── index.ts
│   ├── commands/       # one file per /wf-* command
│   ├── events/         # Pi lifecycle/event registration
│   ├── runtime/        # Pi-dependent execution
│   └── core/           # Pi-independent logic
├── agents/             # Planning/Implementation Coordinator definitions;
│                       # other role definitions only when needed
├── docs/               # implementation-plan.md guidance/template
├── tests/              # responsibility-aligned tests
├── .gitignore
├── package.json
├── pnpm-lock.yaml
├── tsconfig.json
├── biome.json
├── .oxlintrc.json
└── README.md
```

### 5.2 Dependency direction

```text
commands / tools / events / ui
              ↓
           runtime
              ↓
             core
```

例外は次だけである。

- runtimeのchild-only bridge adapterはPi APIと`core`を使うPi-dependent adapter。
- `src/index.ts`はregistration adapterとしてcommands/eventsを呼ぶ。child runtimeではRoot registrationをskipする。
- `core/`からPi package、`pi-subagents`、`pi-intercom`、Plannotatorをimportしない。
- `agents/*.md`はagent runtimeのconfigurationであり、TypeScript module dependencyではない。

### 5.3 Responsibility groups (reference only)

以下は責務groupのrecommended/reference decompositionであり、exact mandatory internal file layoutではない。個々のinternal file、module、export、functionは、directory structure guideの変更理由・必要性の原則に従って統合・分割・renameできる。

| Responsibility area | Required responsibility | Layer / boundary |
| --- | --- | --- |
| `src/index.ts` | 薄いExtension entry。registrationの起点のみ | Pi Extension entry |
| `commands/` | 4つの`/wf-*` thin adapter、input normalization、WorkflowType mapping、runtime delegation。1 command = 1 fileを適用 | Pi integration → runtime |
| `events/` | Pi lifecycle/event registration、thin event adapter、runtime delegation | Pi integration → runtime |
| `runtime/` | workflow start、Coordinator lifecycle/completion、Human/Plannotator bridge、public `pi-subagents` RPC、resultDelivery、cancellation/failure、managed Gate execution、Root persistence/correlation | Pi-dependent execution |
| `core/` | identity/state、state-machine rules、Planning policy semantics、Plan/Handoff/Approval validation、hashing、Trusted Gate semantics、Finding/Disposition、Ready-for-Merge evaluation | Pi-independent logic |
| `agents/` | Planning CoordinatorとImplementation Coordinatorのpackage agent boundary。その他のrole agentは必要な場合だけ | agent runtime configuration |
| `docs/` | `implementation-plan.md`のtemplate/guidanceなどのdocumentation | artifact guidance |
| `tests/` | core/runtime/commands等のresponsibility-aligned tests | verification |

Architecture上のexternal entry、Workflow Type、Coordinator boundary、canonical artifact名だけをmandatory contractとして扱う。file namingと必要な分割は`/Users/minoru/Documents/mywork/pi-extension-skill-directory-structure.md`へ戻し、参考treeを機械的に全作成しない。

Organization ownership:

```text
Architecture:
  required responsibility / authority / runtime boundaryを決める

Implementation Specification:
  required semantic behaviorとlayer ownershipを決める

pi-extension-skill-directory-structure.md:
  directory organization、file naming、file split/merge判断のguideとする

Production implementation:
  上記を満たす最小file/module構成を選ぶ
```

### 5.4 `src/index.ts` prohibition

`src/index.ts`に次を書かない。

```text
workflow orchestration
state machine
Plannotator protocol
Human protocol
finding synthesis
UI rendering
```

`src/index.ts`は次だけを行う。

```text
if child runtime marker is present:
  do not instantiate Root Control Plane
else:
  register command integration
  register event integration
```

このchild guardはregistration境界だけの判定であり、workflow orchestrationを`index.ts`へ置く意味ではない。Coordinator childではambient `pi-intercom`を利用できるようにし、child-only bridgeは`subagentOnlyExtensions`からloadする。

**Traceability**: `[A:35,36]` `[S:/Users/minoru/Documents/mywork/pi-extension-skill-directory-structure.md; Pi docs/extensions.md; pi-subagents/docs/agents.md]` `[D]`

### 5.5 File split rules

Production implementation agentは、directory structure guideの次の原則を守る。

```text
MUST:
  responsibility boundaryを守る
  commands/events/runtime/coreの依存方向を守る
  Pi-dependent / Pi-independent logicを分離する
  変更理由が異なる責務は必要に応じて分離する

MUST NOT:
  このreference treeを機械的に全file作成する
  1 small responsibility = 1 fileをcommands以外へ強制する
  将来必要になるかもしれない理由だけでempty moduleを作る
  tools/ui/skills directoryを責務がないのに作る
  wrapper/manager/registry abstractionを必要性なしに追加する
```

`commands/`の`1 command = 1 file`はguideに従うが、runtime/coreのfile splitへ一律に拡張しない。必要な最小構成を選び、function/export名は外部contractでない限り実装時に決める。

---

## 6. Dependencies / package.json

### 6.1 Dependency categories

`pi-workflow`はExtension packageとして、別Pi packageをbundleして二重loadしない。現段階では通常の`dependencies`は空にする。

| Package | Category | Manifest policy | Reason |
| --- | --- | --- | --- |
| `@earendil-works/pi-coding-agent` | `peerDependency` + exact dev copy | peer `"*"`; dev `"0.85.1"` | Pi host-provided core。Pi package docsのpeer conventionに従う |
| `typebox` | `peerDependency` + exact dev copy | peer `"*"`; dev `"1.3.31"` | child-only custom tool schema。host core packageをbundleしない |
| `pi-subagents` | external runtime prerequisite | package dependencyにしない。hostへ`0.68.0`をinstall | event/RPC public contractを使用し、Pi packageの二重loadを避ける |
| `pi-intercom` | external runtime prerequisite | package dependencyにしない。hostへ`0.13.0`をinstall | Extension Channelは別Pi packageのruntime extension |
| `pi-ask-user-question` | external runtime prerequisite | package dependencyにしない。hostへ`1.0.0`をinstall | same-process public event bridge |
| `@plannotator/pi-extension` | external runtime prerequisite | package dependencyにしない。hostへ`0.27.14`をinstall | direct shared event API。internal importなし |
| `pi-ketch` | conditional external runtime prerequisite | Researcherが必要なhostのみ`1.0.0`をinstall | current `pi-ketch.researcher`を変更せず利用 |
| `oxlint` | `devDependency` | exact `1.83.0` | lint executable |
| `oxlint-tsgolint` | `devDependency` | exact `7.0.2001` | Oxlint type-aware engine。直接script実行しない |
| `@biomejs/biome` | `devDependency` | exact `2.5.13` | formatter |
| `vitest` | `devDependency` | exact `5.0.1` | test runner |
| `typescript` | `devDependency` | exact `7.0.2` | `tsc --noEmit`、tsgolint current requirement |
| `@types/node` | `devDependency` | exact `26.5.1` | Node built-in types |

Pi packageの別package installationはNode dependency resolutionを自動で提供しない。したがってproduction sourceは、これらのexternal runtime prerequisiteのpublic string/event contractをstructural local typeとして定義する。`pi-subagents`、`pi-intercom`、`pi-ask-user-question`、Plannotatorのsource moduleをimportしない。

### 6.2 Exact initial manifest

```json
{
  "name": "pi-workflow",
  "version": "0.1.0",
  "description": "Root-owned conditional planning and bounded implementation workflows for Pi",
  "type": "module",
  "keywords": ["pi-package"],
  "packageManager": "pnpm@11.22.0",
  "engines": {
    "node": ">=22.19.0"
  },
  "files": [
    "src",
    "agents",
    "docs",
    "README.md",
    "package.json",
    "tsconfig.json",
    "biome.json",
    ".oxlintrc.json"
  ],
  "pi": {
    "extensions": ["./src/index.ts"],
    "subagents": {
      "agents": ["./agents"]
    }
  },
  "scripts": {
    "lint": "oxlint --type-aware --deny-warnings .",
    "format": "biome format --write .",
    "format:check": "biome format .",
    "test": "vitest",
    "test:run": "vitest run",
    "typecheck": "tsc --noEmit",
    "check": "pnpm typecheck && pnpm lint && pnpm format:check && pnpm test:run"
  },
  "peerDependencies": {
    "@earendil-works/pi-coding-agent": "*",
    "typebox": "*"
  },
  "devDependencies": {
    "@biomejs/biome": "2.5.13",
    "@earendil-works/pi-coding-agent": "0.85.1",
    "@types/node": "26.5.1",
    "oxlint": "1.83.0",
    "oxlint-tsgolint": "7.0.2001",
    "typebox": "1.3.31",
    "typescript": "7.0.2",
    "vitest": "5.0.1"
  }
}
```

### 6.3 Host prerequisite

READMEに次を明記する。package installとruntime prerequisite installを混同しない。

```bash
pi install npm:pi-subagents@0.68.0
pi install npm:pi-intercom@0.13.0
pi install npm:pi-ask-user-question@1.0.0
pi install npm:@plannotator/pi-extension@0.27.14
# Researcherを使うhostだけ
pi install npm:pi-ketch@1.0.0
```

`pi-subagents` host configはoperatorが次の値で事前設定する。pi-workflowはこのconfigを自動変更しない。

```json
{
  "intercomBridge": {
    "mode": "always",
    "resultDelivery": true
  }
}
```

`pi-subagents`のhost configはsection 13で定義する。`pi-ketch`のKetch backend configuration不足はResearcher result failure/unknownとして扱い、Brave dependencyを追加しない。

**Traceability**: `[A:35,36,42]` `[S:Pi docs/packages.md; pi-subagents/docs/extension-api.md; pi-subagents/docs/agents.md]` `[E:plannotator-direct-api-results.md, human-bridge-tui-results.md, /Users/minoru/Documents/mywork/pi-subagents-result-delivery-report.md]` `[D]`

---

## 7. Core Domain Model

### 7.1 `WorkflowType` and identity

`WorkflowType`はcore layerが所有する。domain typeを一つのglobal `types.ts`へ機械的に集約しない。

```ts
export const WORKFLOW_TYPES = ["feature", "bug", "chore", "hotfix"] as const;
export type WorkflowType = (typeof WORKFLOW_TYPES)[number];

export type WorkflowId = string & { readonly __workflowId: unique symbol };
export type RunId = string & { readonly __runId: unique symbol };
export type RequestId = string & { readonly __requestId: unique symbol };
export type ReviewId = string & { readonly __reviewId: unique symbol };
export type FindingId = string & { readonly __findingId: unique symbol };
export type PlanHashValue = string & { readonly __planHash: unique symbol };

export type WorkflowPhase =
  | "IDLE"
  | "PLANNING"
  | "PLAN_REVIEW"
  | "IMPLEMENTING"
  | "CODE_REVIEW"
  | "READY_FOR_MERGE"
  | "FAILED"
  | "CANCELLED";

export type WorkflowLifecycleState = "IDLE" | "ACTIVE" | "TERMINAL";

export type PlanningStatus =
  | "NOT_STARTED"
  | "RUNNING"
  | "COMPLETED"
  | "FAILED"
  | "CANCELLED";

export type ImplementationStatus =
  | "NOT_STARTED"
  | "RUNNING"
  | "COMPLETED"
  | "FAILED"
  | "CANCELLED";

export interface WorkflowRequest {
  workflowId: WorkflowId;
  workflowType: WorkflowType;
  request: string;
  cwd: string;
  createdAt: string;
}
```

Validation:

- `WorkflowId`: Rootが`wf-${crypto.randomUUID()}`を生成。入力から受け取らない。
- `RequestId`: 各RPC/bridge requestごとに`crypto.randomUUID()`を生成。再利用しない。
- `RunId`: `pi-subagents`が返すopaque non-empty stringを保持。UUID形式を要求しない。
- `ReviewId`: Plannotatorが返すopaque non-empty stringを保持。plan reviewのcorrelationに使う。
- `FindingId`: Implementation Coordinatorがnormalize時に`F-${crypto.randomUUID()}`を生成。
- external IDはtrimし、newlineを拒否する。IDのinvalid値はfail closed。

### 7.2 Common value models

```ts
export type TddMode = "required" | "optional" | "not-applicable";

export interface TestStrategy {
  kind: "unit" | "integration" | "mixed" | "none";
  required: boolean;
  summary: string;
}

export interface PlanHash {
  algorithm: "SHA-256";
  encoding: "hex";
  value: PlanHashValue;
}

export type ArtifactMediaType =
  | "text/markdown"
  | "application/json"
  | "text/plain"
  | "text/x-diff";

export interface ArtifactRef {
  kind: "managed";
  path: string;
  mediaType: ArtifactMediaType;
}
```

`ArtifactRef`はpath/contentのownerではなくmanaged artifactへのreferenceだけである。Root stateへartifact bodyを入れない。

### 7.3 `WorkflowLifecycleState`はderived

`WorkflowLifecycleState`は`WorkflowPhase`から次で導出し、Root stateへ別fieldとして保存しない。

```text
IDLE                 -> IDLE
PLANNING             -> ACTIVE
PLAN_REVIEW          -> ACTIVE
IMPLEMENTING         -> ACTIVE
CODE_REVIEW          -> ACTIVE
READY_FOR_MERGE      -> TERMINAL
FAILED               -> TERMINAL
CANCELLED            -> TERMINAL
```

これにより`phase`と`lifecycleState`の二重source-of-truthを作らない。

**Traceability**: `[A:4,9,21,32]` `[D]`

---

## 8. Root Lifecycle State

### 8.1 Concrete Root state

core layerが次のRoot workflow state modelとvalidationを所有する。

```ts
export type ApprovalValue = boolean | null;

export interface PendingInteraction {
  kind: "human" | "plan-review" | "code-review";
  requestId: RequestId;
  coordinatorRunId: RunId;
  reviewId?: ReviewId;
}

export interface CodeReviewResultSummary {
  requestId: RequestId;
  status: "approved" | "rejected" | "unavailable" | "timeout" | "failed";
  approved: boolean;
  feedbackRef?: ArtifactRef;
  annotationsRef?: ArtifactRef;
}

export interface RootWorkflowState {
  schemaVersion: 1;
  workflowId: WorkflowId;
  workflowType: WorkflowType;
  phase: WorkflowPhase;

  planningRunId?: RunId;
  planningStatus: PlanningStatus;
  planningHandoffRef?: ArtifactRef;

  reviewId?: ReviewId;
  approvedPlanHash?: PlanHashValue;
  approval: ApprovalValue;
  approvalFeedback?: string;

  implementationRunId?: RunId;
  implementationStatus: ImplementationStatus;

  pendingInteraction?: PendingInteraction;
  codeReviewResult?: CodeReviewResultSummary;
  finalStatus: "NONE" | "READY_FOR_MERGE" | "FAILED" | "CANCELLED";
}
```

`IDLE`は新規`workflowId`を採番した直後のper-workflow初期snapshotであり、global singletonのnull workflow stateではない。実装は`IDLE` snapshotを作成して同一atomic operation内で`PLANNING`へ遷移してよい。

### 8.2 State field rules

- `planningHandoffRef`はHandoff fileへのreferenceだけ。Plan Artifact ref、Handoff body、plan bodyは保存しない。
- `approvalFeedback`はRoot-ownedのsmall feedbackに限定し、最大16 KiB。超過するfeedbackはmanaged artifact refへ保存し、Root stateへbodyを入れない。初期実装で必要になる場合だけ`approvalFeedbackRef`を追加する。現時点ではbounded stringで十分とする。
- `codeReviewResult`はapproved/statusとfeedback/annotationsのartifact refsだけ。raw annotation arrayをstateへ入れない。
- `pendingInteraction`はwaiting observable substatusとlate reply rejectionに必要なcorrelationだけを持つ。
- `finalStatus`はterminal resultのcompact projectionであり、Ready理由全体はCoordinator artifactに保存する。
- `phase`、`planningStatus`、`implementationStatus`の矛盾はstate validation failure。
- Plan resubmission、code-review change cycle、automatic Fix Waveの上限をmachine-enforceするため、runtimeはsmall counter/flagまたは同等のbounded stateを保持する。各counterはinitial `0`、上限はそれぞれ`1`とし、exact field name/placementはImplementation Detailである。
- Root stateへ次を入れない。

```text
request body
Plan Artifact content
Planning Handoff content
raw reports
full diff
full test logs
Planning transcript
Implementation transcript
hidden model context
```

### 8.3 Persistence

Pi `appendEntry("pi-workflow.lifecycle.v1", state)`で最新snapshotをsessionへ保存する。`custom` entryはPi LLM contextに入らない。restore時はcurrent branchの最後のvalid snapshotだけを読む。

**Traceability**: `[A:31,32,37]` `[S:Pi docs/extensions.md; session-format.md]` `[D]`

---

## 9. State Machine

### 9.1 Allowed lifecycle

```text
IDLE
  → PLANNING
  → PLAN_REVIEW
  → IMPLEMENTING
  → CODE_REVIEW
  → READY_FOR_MERGE

PLANNING / PLAN_REVIEW / IMPLEMENTING / CODE_REVIEW
  → FAILED
  → CANCELLED

PLAN_REVIEW → PLAN_REVIEW は、rejection後の一度だけ許可するexplicit resubmissionだけ。initial submissionはcountしない。
CODE_REVIEW → IMPLEMENTING は、初回rejection後の一度だけ許可するsame Implementation Coordinatorによるapproved-scope change cycleだけ。
```

`WAITING_FOR_HUMAN`はtop-level phaseに追加しない。`PLAN_REVIEW`または`CODE_REVIEW`の`pendingInteraction`で表す。

### 9.2 Transition contract

| From → To | Trigger/event | Preconditions | Owner | State mutation | Side effects | Failure outcome | Idempotency |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `IDLE → PLANNING` | valid `/wf-*` | request non-empty、cwd valid、same-session active duplicateなし、global host prerequisite valid | Root | create `workflowId`、set planning RUNNING、set phase | persist snapshot、public RPC spawn Planning | spawn/ready failureは`FAILED`。host prerequisite不備はstart拒否 | same commandは新ID。既存activeはreject |
| `PLANNING → PLAN_REVIEW` | matching `subagent:async-complete` | matching `planningRunId`、success/complete、Plan ref/Handoff ref exists、Handoff valid、hash matches current plan | Root after Planning result | planning COMPLETED、set ref、phase PLAN_REVIEW、approval null | no Parent message、Root-owned Plan Review responsibilityからdirect Plannotatorへ開始 | missing/invalid artifactは`FAILED` | same run completion after transition ignored |
| `PLAN_REVIEW → PLAN_REVIEW` | plan rejection or one explicit resubmission | old Handoff remains immutable。resubmissionはfresh Planning runでnew Plan/Handoffを作る。initial submissionはcountしない | Root + Planning Coordinator | rejection: approval false/feedback。resubmit: bounded counterをincrementし、new planningRunId/status RUNNING, new refs/hash/review identity | new review only after new plan completion | second rejectionまたはinvalid resubmissionは`FAILED` | same rejection result replayed only if exact |
| `PLAN_REVIEW → IMPLEMENTING` | valid plan approval + fresh spawn | all section 23 validation passes | Root | set implementation RUNNING/runId、phase IMPLEMENTING、clear pending | public async spawn fresh Implementation Coordinator | validation/spawn failureはadvanceせず`FAILED` | duplicate launch rejected by state/run identity |
| `IMPLEMENTING → CODE_REVIEW` | Coordinator requests final review | implementation complete、required gates PASS、accepted findings resolved、Fix Waveがあればfresh Focused Re-review PASS、final inspection PASS | Implementation Coordinator requests; Root transports | implementation COMPLETED、phase CODE_REVIEW、pending code review | direct Plannotator `code-review` | unavailable/timeout/invalidは`FAILED` | same requestId one terminal result |
| `CODE_REVIEW → IMPLEMENTING` | initial code review rejection with bounded feedback | same Implementation Coordinator alive、one change cycle unused、approved scope内、新しいarchitecture/product/security decision不要 | Implementation Coordinator | change-cycle counterをincrementし、implementation RUNNING、retain code review result, clear pending | Coordinator creates one bounded change cycle; no new coordinator | second rejection、scope escape、new decision、or unsafe fixは`FAILED` | duplicate feedback ignored; conflict fails |
| `CODE_REVIEW → READY_FOR_MERGE` | code review approved | pure evaluator returns ready | Implementation Coordinator then Root records | implementation COMPLETED、finalStatus READY_FOR_MERGE、phase READY | persist final summary; no merge command | any missing check → remain/`FAILED` | first valid terminal result wins |
| active → `FAILED` | RPC/Coordinator/child/bridge/gate/integrity failure | non-terminal state | Root / Coordinator according to failure source | phase FAILED、finalStatus FAILED、reason in artifact | best-effort stop if active; no Parent fallback | terminal fail closed | duplicate failure same code no-op; conflict retains first and records conflict |
| active → `CANCELLED` | explicit user cancellation | workflow exists and non-terminal | Root | phase CANCELLED、finalStatus CANCELLED、stop requested metadata in final artifact | stop coordinator/descendants, cancel Human request | stop uncertainty remains in result; no phase advance | repeated cancel returns same final result |

### 9.3 Transition mutation rule

State mutationはRoot process-local registry lockの下でpreconditionを検証してから行う。side effectが必要なtransitionは、次の順序を使う。

```text
validate current state
→ persist intent/terminal guard
→ perform public side effect
→ persist resulting state
```

未確定のside effectを成功としてstateへ書かない。Root Parent LLMへrecover promptを送らない。

**Traceability**: `[A:32,33,38]` `[E:phase-handoff-capability-results.md, implementation-composition-results.md, full-workflow-composition-results.md]` `[D]`

---

## 10. Command Specification

### 10.1 Registration and mapping

commands layerで次のmappingを一度ずつ登録する。

```text
/wf-feature → feature
/wf-bug    → bug
/wf-chore  → chore
/wf-hotfix → hotfix
```

Architectureの`1 command = 1 file`原則を適用し、各command fileのmappingを明示する。内部のadapter/export構成はImplementation Detailとする。

### 10.2 Input contract

Pi command handlerの`args`を次の順に処理する。

1. `args.trim()`。
2. 空文字ならerror notificationを返し、state/RPCを作らない。
3. 非空ならrequest bodyとしてそのまま保持する。lowercase化、句読点削除、prompt化をしない。
4. `ctx.cwd`をrequest cwdにする。ユーザー入力からcwdを受け取らない。
5. `crypto.randomUUID()`で`workflowId = wf-${uuid}`を作る。
6. `WorkflowType`をcommand固定mappingから付与する。
7. `WorkflowRegistry`でactive duplicateを検査する。
8. Root runtimeのworkflow-start responsibilityへ委譲する。

### 10.3 Duplicate/error behavior

- 同一Root sessionでactive workflowが既にある場合、commandは新workflowを作らず、短いerrorを表示する。
- `PLAN_REVIEW` waiting、Human waiting、CODE_REVIEW waitingもactive扱い。
- terminal workflowはduplicate block対象外。
- cross-session / cross-processのglobal active-workflow registryはv1 unsupportedである。
- same cwd concurrent workflow across separate sessionsはmachine-enforced guaranteeなしとし、運用上禁止する。新しいcross-process locking mechanismは設計しない。
- RPC ready未取得、spawn reply timeoutは`FAILED` resultとしてrecordし、Parent LLMへfallbackしない。host prerequisite不備はworkflow startを拒否し、Coordinatorをspawnしない。
- handlerはworkflow prompt、`pi.sendUserMessage()`、state transition、finding synthesis、Plannotator protocolを直接実行しない。

### 10.4 CWD and source boundary

`cwd`はRoot command invocation時点の`ctx.cwd`。Coordinator/Worker/Reviewerはこのcwdで実行し、初期実装では`worktree:false`のshared cwdを使う。Root registryは同一Root sessionのactive workflowを1件に制限する。同じcwdを別sessionから同時に使うことは運用上禁止するが、machine-enforced guaranteeとはしない。durable global registry、lease、worktree isolationはv1では実装せずDeferredとする。

**Traceability**: `[A:12]` `[E:phase-a-smoke-results.md]` `[D]`

---

## 11. Root Control Plane

### 11.1 Use-case responsibilities

Root Control Planeでは、以下のuse-case responsibilityを分離する。巨大なworkflow managerへ全責務を集中させない。ただし、各responsibilityを1 file = 1 moduleにすることはcontractではない。

実際のmodule/file splitは、`/Users/minoru/Documents/mywork/pi-extension-skill-directory-structure.md`の「変更理由が異なる場合に分割する」原則に従う。以下のlayerはsuggested locationであり、exact file nameではない。

| Responsibility | Owner | Suggested layer |
| --- | --- | --- |
| workflow start | Root | runtime |
| Planning completion handling | Root | runtime |
| Human Decision request/reply | Root | runtime |
| Plan Review request/result | Root | runtime |
| fresh Implementation launch | Root | runtime |
| Code Review request/result | Root transport + same Coordinator | runtime |
| cancellation | Root | runtime |
| Coordinator/child failure normalization | Root | runtime |

### 11.2 Use-case contracts

各use-case responsibilityはdependency objectを受け取り、module-level mutable singletonを作らない。返り値はcompact structured resultであり、raw child textではない。下表の名称は責務を示すもので、exact function/export nameを固定するものではない。

| Responsibility | Input | Success result | Failure/side effect |
| --- | --- | --- | --- |
| workflow start | `WorkflowRequest`、Root deps | `workflowId`、`planningRunId`、phase `PLANNING` | duplicate/host prerequisite/ready failureはno launch、RPC failureはno launchまたは`FAILED` |
| Planning completion handling | matching async completion + compact result | phase `PLAN_REVIEW`、Plan/Handoff refs | invalid result/hash/schemaは`FAILED` |
| Human Decision request | workflow/run/request/questionnaire | structured answerまたはfailure | Root TUI request、cancel/timeout/duplicate handling |
| Plan Review request | Plan Artifact ref + current hash | `reviewId`、pending interaction | direct Plannotator request; unavailableはno approval |
| Plan Review result handling | `reviewId` + structured result | Root Approval Identityまたはrejection feedback | hash recheck; Handoffは不変 |
| fresh Implementation launch | Plan/Handoff/Approval refs | `implementationRunId`、phase `IMPLEMENTING` | any validation failureはspawnしない |
| Code Review request | workflow/run/cwd | correlated code-review response | direct Plannotator `code-review` |
| Code Review result handling | local requestId + structured result | same Coordinator continuation/readiness input | rejectionはbounded change、failureはfail closed |
| cancellation | `workflowId` | terminal `CANCELLED` result | stop/bridge cancel/artifact summary |
| Coordinator failure normalization | run ID、phase、bounded error | terminal `FAILED` result | no Parent fallback、late events ignored |

### 11.3 Root orchestration boundary

Rootは「いつ次phaseへ進めるか」「どのidentityが一致するか」「どのpublic bridgeを使うか」を決める。Planning-stage selection、Finding disposition、Fix content selectionはCoordinatorが所有する。Rootはraw reportを読んでsynthesisしない。

### 11.3 Root dependencies

```text
commands/events → runtime responsibility
runtime responsibility → registry/state store/RPC/bridges
all rule validation → core
```

Root Control Planeは`pi.sendMessage` / `pi.sendUserMessage`をworkflow transportとして使わない。成功経路でRoot Parent LLM internal turnsは0でなければならない。

**Traceability**: `[A:11,22,37]` `[E:full-workflow-composition-results.md]` `[D]`

---

## 12. pi-subagents RPC Adapter

### 12.1 Public contract only

runtime layerがpublic event-bus RPC adapterをlocal structural contractとして実装する。

```text
ready event:  subagents:rpc:v1:ready
request:      subagents:rpc:v1:request
reply:        subagents:rpc:v1:reply:<requestId>
version:      1
```

Request/Replyの概念形:

```ts
interface SubagentRpcRequest {
  version: 1;
  requestId: string;
  method: "ping" | "status" | "spawn" | "steer" | "interrupt" | "stop" | "resume";
  params?: Record<string, unknown>;
  source?: { extension?: string };
}

interface SubagentRpcReply {
  version: 1;
  requestId: string;
  method?: string;
  success: boolean;
  data?: unknown;
  error?: { code: string; message: string };
}
```

### 12.2 Ready detection

- Extension factory setup時に`ready` listenerを登録する。
- payloadの`version === 1`、`methods`に必要な`spawn`/`status`/`stop`があること、`capabilities.asyncSpawn === true`を検証する。
- `ready`を受け取る前にspawnしない。
- `ready`が再emitされたら同じversionを再検証し、既存request waiterを壊さない。
- readyが欠落している場合は`rpcReadyTimeoutMs = 5_000` msで待ち、期限到来時はfail closedにする。production向けのproject/operator timeout configurationは作らない。

### 12.3 Request ID / correlation

- requestごとに新しいUUIDを発行する。
- reply listenerを`pi.events.on(replyEvent, ...)`で先に登録してからrequest eventをemitする。
- replyの`requestId`を再検証し、別requestのreplyをconsumeしない。
- timeout、abort、reply受信でlistenerとtimerを必ずdisposeする。
- duplicate replyはterminal waiterが消えた後に無視する。
- conflicting reply（同じrequest IDでsuccess/errorが異なる）はrequestを成功扱いせず、callerへinfrastructure failureを返す。

### 12.4 Planning / Implementation spawn payload

RootからCoordinatorを次のpublic payloadでspawnする。`async:false`、management `action`、private suppression fieldは送らない。

```json
{
  "version": 1,
  "requestId": "<rpc-request-uuid>",
  "method": "spawn",
  "source": { "extension": "pi-workflow" },
  "params": {
    "agent": "pi-workflow.planning-coordinator",
    "task": "<serialized bounded coordinator contract>",
    "context": "fresh",
    "cwd": "<root cwd>",
    "async": true,
    "output": "coordinator-summary.md",
    "outputMode": "file-only",
    "artifacts": true,
    "timeoutMs": 43200000
  }
}
```

Implementation launchだけ`agent`を`pi-workflow.implementation-coordinator`へ置き換える。`task`はrequest、identity、artifact references、policy snapshot、approved identityを含むが、Root Parent transcriptは含まない。

### 12.5 Run ID capture

成功replyのhuman-readable `text`をparseしない。current public result shapeで次の順に探し、non-empty opaque stringを`RunId`として保存する。

```text
data.details.results[0].runId
→ data.details.runId
→ data.details.id
→ data.details.asyncId
→ data.runId
→ data.id
→ data.asyncId
```

どれも存在しない場合はspawn acceptedとみなさず、stateを`FAILED`にする。RPC request timeout後にrun IDが不明な場合、orphanの可能性をartifactへ記録し、同じrequestをautomatic retryしない。

### 12.6 Async lifecycle

Rootは次をlistenする。

```text
subagent:async-started
subagent:async-complete
subagent:process-terminal
```

- `runId`でRoot stateをcorrelateする。
- `async-complete`のcompact resultとmanaged artifact refsだけをconsumeする。
- `process-terminal`はprocess proofであり、execution successの代替ではない。
- `async-complete`が同じ`runId`で二度来た場合、first terminal resultを保持し、二度目はignoreする。
- unknown run ID、foreign session、invalid statusはRoot phaseを進めず、bounded diagnostic artifactへ記録する。

### 12.7 Control methods

Cancellation時はpublic `stop`をtop-level async Coordinator runへ送る。必要な場合だけstatusでchild identityを確認し、public `stop`のchild targetを使う。raw PID kill、runner private inbox、private source importは使わない。

`steer`/`resume`はinitial automatic recoveryに使わない。Coordinatorのsame-run continuationはCoordinator内部のpublic channelで行う。

**Traceability**: `[A:11,13,22,33,37]` `[S:pi-subagents/docs/extension-api.md; workflows.md; tool-reference.md; observability.md; src/extension/rpc.ts]` `[E:phase-a-smoke-results.md, b0-investigation-results.md, v068-worker-reviewer-capability-results.md]` `[D]`

---

## 13. Result Delivery Handling

### 13.1 Host prerequisite and ownership

`pi-subagents@0.68.0`ではasync external result deliveryの判定がglobal host configで行われる。RPC spawnのlaunch overrideでCoordinatorだけへlocalizeできない。v1のrequired global host configurationは次である。

```json
{
  "intercomBridge": {
    "mode": "always",
    "resultDelivery": true
  }
}
```

path:

```text
~/.pi/agent/extensions/subagent/config.json
```

scopeはhost-wide `pi-subagents` behaviorである。config ownerはoperator / `pi-subagents` host configとする。project/operator向けのworkflow policy設定ではない。

| Concern | Owner |
| --- | --- |
| global `intercomBridge.mode` / `resultDelivery` | operator / `pi-subagents` host configuration |
| `subagent:result-intercom` receiver and relay | installed `pi-intercom` extension |
| result-delivery acknowledgement | `pi-intercom`がmatching `requestId`で`subagent:result-intercom-delivery`をemit |
| workflow completion observation | `pi-workflow` Root Extensionが`subagent:async-complete`をobserve |
| phase mutation | Root Control Plane / Coordinator |
| Parent LLM wake suppression | acknowledged delivery pathのhost behavior |

`pi-workflow`はhost configを自動変更せず、result intercomのack senderにもならない。workflow start前にhost prerequisite preflightを実施し、configがmissing/invalid、または確認不能ならworkflow startを拒否する。Coordinatorをspawnしてから失敗を検出する形にしない。

### 13.2 Per-run limitation

```text
host-wide resultDelivery = required
per-run resultDelivery localization = unsupported in pi-subagents 0.68.0
```

RPC `spawn` payloadへprivate suppression fieldや独自completion transportを追加しない。launch overrideがbridge instruction/targetへ反映されても、async external deliveryの判定はglobal configから変わらない。したがって通常async runだけをoverrideで除外することも、Coordinatorだけをoverrideで有効化することも前提にしない。

### 13.3 Success path and acknowledgement

```text
subagent completion
  → pi-subagents emits subagent:result-intercom { requestId, to, message, runId, ... }
  → pi-intercom relays/handles the message
  → pi-intercom emits subagent:result-intercom-delivery { requestId, delivered:true }
  → pi-subagents marks intercomDelivered:true and suppresses normal parent notification
  → pi-workflow receives subagent:async-complete
  → Root validates the matching run/result and updates lifecycle
```

`subagent:async-complete`だけではdelivery successとみなさない。workflow startのhost prerequisite preflightとは別に、matching acknowledgementが`delivered:true`であることをworkflow completionの前提にする。`triggerTurn`のpayloadだけで判定しない。

### 13.4 Duplicate acknowledgement and late events

- `requestId`が一致しないackはconsumeしない。
- `pi-intercom`のone-shot waiterがterminalになった後の同一ackは無視する。
- `pi-workflow`はack eventを再emitしない。
- duplicate `subagent:async-complete`はrun identityでdedupeする。
- reload、phase transition後、またはterminal後のlate ack/eventはstate mutationしない。

### 13.5 Ack failure

`delivered:false`、timeout、receiver unavailable、relay exception、ack unavailableはcompletion successではない。

```text
resultDelivery failure
  → Root records bounded failure evidence
  → current coordinator result is not a trusted phase completion
  → no next phase
  → final status FAILED or CANCELLED according to current operation
  → automatic retryなし
```

current `pi-subagents`ではackされない場合にnormal notifier fallbackが発生し得る。これはhost-wide prerequisiteを満たさない場合のResidual Riskであり、Root Parent LLMへworkflow controlを戻す理由にはしない。future per-run delivery supportはDeferredとする。

### 13.6 Reload behavior

Extension reload/session shutdownで`pi-intercom` listenerがdisposeされる。late ackはconsumeしない。active Coordinatorはsection 36のreload policyに従いpublic stopをbest-effortで受け、late completionをnew runtimeが自動consumeしない。

**Traceability**: `[A:11,37,42]` `[S:pi-subagents/src/extension/index.ts; src/runs/background/result-watcher.ts; src/intercom/result-intercom.ts; docs/configuration.md; pi-intercom source]` `[E:/Users/minoru/Documents/mywork/pi-subagents-result-delivery-report.md, b0-investigation-results.md, human-bridge-tui-results.md, v068-worker-reviewer-capability-results.md]` `[D]`

---

## 14. Workflow Policy

### 14.1 Policy source and minimum model

core layerが、packageに組み込まれた共通Planning requirementとWorkflow TypeごとのScout focusを提供する。policy sourceは`pi-workflow` package built-inに固定する。project override、operator override、独立したpolicy lifecycle/version systemはv1に存在しない。RepositoryのCI、scripts、docsはpolicy overrideではなく、PlanningとImplementationが読むevidenceである。

Workflow Typeごとの差は、主にPlanning時のfocusとevidence emphasisで表す。Workflow TypeごとのGate、Reviewer、Focused Re-reviewのbehaviorをpolicy shapeへ埋め込まない。

```ts
export type PlanningCapability =
  | "scout"
  | "plan-composition"
  | "researcher"
  | "grilling"
  | "human-decision"
  | "targeted-rescout"
  | "oracle";

export type PlanningRequirement = "required" | "evidence-driven-conditional";

export const COMMON_PLANNING_REQUIREMENTS = {
  scout: "required",
  "plan-composition": "required",
  researcher: "evidence-driven-conditional",
  grilling: "evidence-driven-conditional",
  "human-decision": "evidence-driven-conditional",
  "targeted-rescout": "evidence-driven-conditional",
  oracle: "evidence-driven-conditional",
} as const satisfies Readonly<Record<PlanningCapability, PlanningRequirement>>;

export interface WorkflowTypePolicy {
  workflowType: WorkflowType;
  scoutFocus: readonly string[];
}

export interface WorkflowPolicy {
  source: "package-built-in";
  commonPlanning: typeof COMMON_PLANNING_REQUIREMENTS;
  typePolicies: Readonly<Record<WorkflowType, WorkflowTypePolicy>>;
}
```

このshapeは、全Workflow Typeに共通するrequired / evidence-driven conditionalの境界と、type-specificなScout focusだけを表す最小形である。独立したpolicy versionを追加しない。serialized coordinator contractで識別が必要な場合は、そのcontract/schema versionを使う。

### 14.2 Common planning policy

全Workflow Typeで次を適用する。

```text
Scout             required
Plan Composition  required
Researcher        evidence-driven conditional
Grilling          evidence-driven conditional
Human Decision    evidence-driven conditional
Targeted Re-scout evidence-driven conditional
Oracle            evidence-driven conditional
```

Scoutは主に次を確認する。

| Workflow Type | Scout focus / evidence emphasis |
| --- | --- |
| `feature` | existing implementation、impact scope、related tests、existing patterns、extension points |
| `bug` | symptom、reproduction evidence、expected vs actual、affected path、regression coverage、evidence-based root-cause hypothesis、blast radius |
| `chore` | target config/files、dependencies、scripts/CI/build impact、generated files/lockfiles、compatibility、cleanup/removal scope |
| `hotfix` | incident/symptom、affected component、likely cause、minimal safe change area、blast radius、regression test、rollback/revert consideration、data/security risk |

`hotfix`はPlanningを短くしてよいが、approval、authority、Gate、review boundaryは共通invariantとして弱めない。

### 14.3 Evidence-driven conditional stages

次のgeneral triggerだけをv1 policyとして残す。

```text
Researcher:
  repositoryだけでは不足するexternal factが必要

Grilling:
  implementation-affecting ambiguityがrepository/external evidenceだけで一意に解けない

Human Decision:
  複数の妥当な選択肢が残り、observable behavior / scope / architecture /
  security / compatibilityに影響する

Targeted Re-scout:
  新しいdecision/evidenceで以前のScout前提が変わった

Oracle:
  複数の現実的戦略があり、architecture / risk / blast-radiusの独立評価が有用
```

conditional capabilityは、requestと既存evidenceから必要性を判断してselectedまたはexplicitly skippedにする。必要性を安全に判断できないままstageを黙ってskipしない。必要なdecision/evidenceを得られない場合はPlanを完成扱いにせず、bounded blockerとして失敗させる。

### 14.4 Bounded capability boundary

- 上記7 capability以外のstageをWorkflow Policyへ追加しない。
- Planning Coordinatorだけがboundedなnested capability selectionを行う。
- Full Smokeのsequenceをdefault pipelineとしてhard-codeしない。
- `maxSubagentDepth = 2`をCoordinator agent contractのfixed safety ceilingとする。bounded nested capabilityを許可し、unbounded nestingを防ぐ。
- exact child agent mapping、parallelism、scope decomposition、Skill compositionはImplementation Detailであり、Architecture invariantとこのdepth ceilingを満たす最小実装で決める。
- selected/skipped capabilityとreason/evidence referenceだけをcompact Planning resultへ保存する。

### 14.5 Selection record

```ts
export interface PlanningSelectionRecord {
  capability: PlanningCapability;
  reason: string;
  evidenceRefs?: ArtifactRef[];
}
```

`reason`は必須。selected capabilityとskipped capabilityを別々に記録し、`skipped`はevidenceまたは明確な非適用理由とともに記録する。

**Traceability**: `[A:9,14,15,16,18]` `[E:full-workflow-composition-results.md, grilling-nested-capability-results.md]` `[D]`

---

## 15. Planning Coordinator

### 15.1 Agent registration

`agents/planning-coordinator.md`:

```yaml
---
name: planning-coordinator
package: pi-workflow
description: Owns bounded conditional planning and creates the plan artifact and immutable planning handoff.
tools: read, grep, find, ls, subagent, subagent_supervisor, pi_workflow_human_decision, pi_workflow_write_handoff
subagentOnlyExtensions: "<runtime child-bridge adapter path>"
allowNestedSubagents: true
maxSubagentDepth: 2
excludeTools: contact_supervisor
inheritProjectContext: false
inheritGlobalContext: false
inheritSkills: false
systemPromptMode: replace
defaultContext: fresh
async: true
acceptanceRole: writer
---
```

System promptの必須規則:

```text
You are the pi-workflow Planning Coordinator.
Own only bounded Planning orchestration, stage selection, plan composition, and handoff creation.
Do not implement source code.
Do not launch an Implementation Coordinator.
Do not ask the Root Parent LLM to orchestrate or synthesize raw reports.
Use only the bounded capability set and package-built-in Workflow Policy supplied in the task.
Scout and Plan Composition are required. Every skipped conditional capability requires a reason and evidence/uncertainty statement.
Keep raw child output in managed artifacts and pass references, not report bodies.
Create implementation-plan.md and planning-handoff.json as Planning-owned artifacts.
Do not write approval, reviewId, approvalFeedback, or approvedPlanHash into planning-handoff.json.
```

### 15.2 Input contract

```ts
export interface PlanningCoordinatorInput {
  contractVersion: 1;
  workflow: {
    workflowId: WorkflowId;
    workflowType: WorkflowType;
    request: string;
    cwd: string;
  };
  policy: WorkflowPolicy;
  artifact: {
    planFileName: "implementation-plan.md";
    handoffFileName: "planning-handoff.json";
    outputMode: "file-only";
  };
  runtime: {
    coordinatorRunId?: RunId;
    maxChildCount: number;
    timeoutMs: number;
  };
}
```

productionの`runtime.timeoutMs`は`43_200_000` ms固定とし、test seam以外で変更しない。

含めない:

```text
Root Parent transcript
Root hidden model context
prior implementation transcript
raw report body
approval identity
```

### 15.3 Output contract

```ts
export interface PlanningCoordinatorResult {
  contractVersion: 1;
  workflowId: WorkflowId;
  status: "COMPLETED" | "FAILED" | "CANCELLED";
  planArtifactRef?: ArtifactRef;
  planningHandoffRef?: ArtifactRef;
  selectedCapabilities: Array<{
    capability: PlanningCapability;
    reason: string;
  }>;
  skippedCapabilities: PlanningSelectionRecord[];
  remainingBlockers: Array<{
    code: string;
    reason: string;
    evidenceRefs?: ArtifactRef[];
  }>;
}
```

Raw Scout/Researcher/Grilling/Oracle report bodyは返さない。失敗時もstructured summaryとartifact referenceだけを返す。`status:"COMPLETED"`はvalid Plan Artifact/Handoffが存在し、blockingな`remainingBlockers`が空の場合だけ許可する。未解消blockerがある場合は`FAILED`であり、RootはPlan Reviewへ進めない。

### 15.4 Coordinator internal sequence

Coordinatorは次のbounded algorithmを使う。

```text
1. validate input、package-built-in policy、common invariants
2. required Scoutでrepository evidenceを収集する
3. request/evidenceとtype-specific Scout focusを評価する
4. evidence-driven conditional capabilityをselectedまたはexplicitly skippedにする
5. selected capabilityをfresh/read-only contractで起動する
6. Human Decisionはchild bridge tool経由だけで行う
7. returned evidenceをCoordinator内で評価する
8. new evidenceでScout前提が変わった場合だけTargeted Re-scoutを選ぶ
9. 複数の現実的戦略に独立評価が有用な場合だけOracleを選ぶ
10. Plan Compositionをrequired capabilityとしてfile-only outputで実行する
11. `pi_workflow_write_handoff`を呼び、`core` adapterでplan hashを計算する
12. managed Plan Artifactの隣にplanning-handoff.jsonを一度だけ作成する
13. HandoffをPlan Artifactと照合してからcompact resultを返す
```

Plan Artifact/Handoff作成後にPlanning Coordinatorをresume/forkしてImplementationを開始しない。Rootがapproval後にfresh Implementation Coordinatorを起動する。

**Traceability**: `[A:13,15,21,22]` `[E:phase-handoff-capability-results.md, full-workflow-composition-results.md]` `[D]`

---

## 16. Planning Capabilities

### 16.1 Scout

**Contract**

```text
agent: scout
context: fresh
read-only: yes
skill: codegraph (explicit)
outputMode: file-only
```

Input task:

- `workflowId`
- repository `cwd`
- bounded question/scope
- expected symbols/files/tests/blast-radius evidence
- CodeGraph unavailable時の禁止事項

Output artifact:

```text
relevant files
entry points
symbols/callers/callees
existing tests
blast radius
risks
known/unknown facts
```

`CodeGraph`が未初期化の場合、Scoutは勝手に初期化しない。`status`/bounded readで確認できる範囲だけを返し、必要な未確定factをblockerとして記録する。source writeは禁止。

CodeGraph CLI invocationはScout agentのexisting Skill/Tool contractに任せ、`pi-workflow`がCodeGraph implementationをcopyしない。

**Failure**: required Scoutが失敗し、planに必要なrepository factが不明ならPlanningは`FAILED`。conditional capabilityのfailureはexplicit skipとuncertaintyへ変換してよいのは、そのcapabilityが不要であることをevidenceで説明できる場合だけである。unknownをknownにしない。

**Evidence**: `[E:phase-a-smoke-results.md]`

### 16.2 Researcher

Researcherはconditional。external factが必要なときだけ起動する。

```text
agent: pi-ketch.researcher
context: fresh
read-only: yes
current pi-ketch: 1.0.0
required tools: selected Ketch tools, no Brave workaround
outputMode: file-only
```

Preflightで次を確認する。

- canonical agent name `pi-ketch.researcher`が解決する。
- `subagentOnlyExtensions`がresolvedする。
- selected Ketch toolがmodel-visibleである。
- v0.68 runtimeでrequired toolが登録されている。

`ketch_docs`、`ketch_search`、`ketch_code`、`ketch_scrape`からrequestに必要なものだけを使う。Ketch unavailable、API key/backend precondition不足、tool disappearanceはsuccessに丸めない。別検索tool、Brave package、Parent LLMへfallbackしない。

**Evidence**: `[E:pr-2143-ketch-verification.md, v068-worker-reviewer-capability-results.md, b0-2-ketch-tool-loss.md]`

### 16.3 Grilling

Grillingはevidence-driven conditional capabilityである。独立child agent `pi-workflow.grilling-coordinator`を使うか、Planning Coordinator内で実行するかはImplementation Detailとする。いずれの場合も必要なSkillはexplicitに渡し、wrapper Skillをruntime contractにしない。

```text
agent: pi-workflow.grilling-coordinator
context: fresh
skills: [grilling]
skills: [grilling, domain-modeling]  # domain decisionが必要な場合
```

独立Grilling Coordinator agentを採用する場合のreference configuration（file pathはmandatoryではない）:

```yaml
---
name: grilling-coordinator
package: pi-workflow
tools: read, grep, find, ls, subagent, subagent_supervisor, pi_workflow_human_decision
subagentOnlyExtensions: "<runtime child-bridge adapter path>"
allowNestedSubagents: true
maxSubagentDepth: 2
excludeTools: contact_supervisor
inheritSkills: false
inheritProjectContext: false
inheritGlobalContext: false
systemPromptMode: replace
defaultContext: fresh
acceptanceRole: read-only
---
```

Grillingはambiguity、scope、acceptance、non-goal、risk、test strategy、TDD modeを明確化する。回答が必要な場合は`pi_workflow_human_decision`を一度のlogical requestとして使い、default answerを作らない。

Nested Scout/Researcherが必要なら、current Grilling Coordinatorをimmediate parentとしてboundedにlaunchする。

```text
Root → Planning Coordinator → Grilling Coordinator → optional Scout/Researcher
```

nested childの`contact_supervisor`はimmediate parentが扱う。Root Parent LLMへescalateしない。

`grill-me`、`grill-with-doc`はwrapper bodyの自動Skill resolutionを期待しない。必要な`grilling`/`domain-modeling`はlaunchでexplicitに渡す。

**Evidence**: `[E:grilling-nested-capability-results.md]`

### 16.4 Targeted Re-scout

Targeted Re-scoutはnew broad scanではなく、Planning Coordinatorが新しいdecision/evidenceで変わったScout前提を一つのnarrow questionへ縮小して起動する。`agent: scout`、`context:fresh`、`skill:codegraph`、file-only outputを使う。必要性はrepository evidenceとconditional triggerから判断し、解消できない不確実性はPlan blockerとして扱う。

### 16.5 Oracle

```text
agent: oracle
context: fresh
read-only: yes
outputMode: file-only
```

Oracleはassumption、scope、risk、test strategy、simpler alternativeをadviceするだけである。approval authority、implementation authority、phase transition authorityは与えない。Coordinatorがadviceを採用/不採用/保留し、reasonをcompact resultへ記録する。Oracleはevidence-driven conditional capabilityであり、Workflow Type共通のmandatory stageにはしない。

**Evidence**: `[E:full-workflow-composition-results.md]`

### 16.6 Plan Composition

Plan Compositionはrequired responsibilityである。専用のread-only agentを使うか、Planning Coordinator内で実行するかはImplementation Detailとする。`pi-workflow.plan-composer`および下記のagent definition pathは、専用agentを分ける場合のreferenceであり、treeに存在することだけを理由にmandatory fileとはしない。

Reference agent definition:

```yaml
---
name: plan-composer
package: pi-workflow
description: Produces a self-contained implementation-plan.md from bounded planning evidence.
tools: read, grep, find, ls
excludeTools: contact_supervisor
inheritProjectContext: false
inheritGlobalContext: false
inheritSkills: false
systemPromptMode: replace
defaultContext: fresh
acceptanceRole: read-only
---
```

専用Plan Composition agentを使う場合は`output: "implementation-plan.md"`、`outputMode:"file-only"`でlaunchする。専用agentを使わない場合も、既存のmanaged output mechanismで同じcanonical Plan Artifactを生成する。Plan Composition responsibilityはsource edit、approval metadata、Handoff作成を行わない。

### 16.7 Child-only bridge tools

runtime layerのchild-only bridge adapterは、Root Extensionの通常loadで公開Toolを登録しない。Coordinator agentの`subagentOnlyExtensions`としてだけloadし、次のPi Toolsを登録する。下記の`<runtime child-bridge adapter path>`はそのadapterのreference valueであり、exact internal file pathではない。使用する場合は実際のpathを`subagentOnlyExtensions`で解決可能にする。Coordinator agentの`extensions`はambient `pi-intercom`を保持するため省略し、Root `src/index.ts`のchild guardでRoot Control Planeの二重起動を防ぐ。hostがambient extensionを禁止する場合、pi-intercomのdocumented extension pathを別途明示する。

```text
pi_workflow_human_decision
pi_workflow_code_review
pi_workflow_write_handoff
pi_workflow_inspect_diff
```

責務とauthority:

- `pi_workflow_human_decision`: `pi-intercom` channel publish、reply wait、requestId validation。source writeなし。
- `pi_workflow_code_review`: same CoordinatorからRootへのcode-review request/response wait。source writeなし。
- `pi_workflow_write_handoff`: `implementation-plan.md`をreadしてcoreのcanonical hash/schema validatorを呼び、同じdirectoryの新規`planning-handoff.json`だけをexclusive createする。既存fileの上書き、source path、approval fieldを拒否する。
- `pi_workflow_inspect_diff`: user commandを受け取らず、固定read-only Git inspectionだけを`pi.exec`で実行する。

このfileはsource implementation authorityを与えない。Planning Coordinator/Implementation Coordinator agentのtools allowlistにもgeneric `write`/`edit`/`bash`を入れない。managed child outputの保存は`output`/`outputMode:"file-only"`へ委譲する。

`pi_workflow_write_handoff`のminimum inputは、workflow identity、Plan/Handoffのmanaged references、TDD/test/constraint/non-goal metadata、必要ならPlanning run identityとする。exact tool schemaはImplementation Detailである。

toolはPlan/Handoffのbasenameがそれぞれ`implementation-plan.md`、`planning-handoff.json`で、同じmanaged artifact directoryにあることを確認する。hashはinputから受け取らず、runtimeからcoreのcanonical hash responsibilityを呼び出してschema v1 JSONを生成する。

**Traceability**: `[A:15-18]` `[S:Pi docs/extensions.md custom tools; pi-subagents/docs/agents.md subagentOnlyExtensions/output]` `[E:full-workflow-composition-results.md]` `[D]` `[ID]`

---

## 17. Human Decision Bridge

### 17.1 Production path

```text
Coordinator
  → pi-intercom Extension Channel
  → Root Extension
  → pi-ask-user-question:request:v1
  → Root TUI user
  → pi-ask-user-question:reply:<requestId>
  → Root Extension
  → pi-intercom Extension Channel
  → same Coordinator
```

### 17.2 Public request schema

`pi-ask-user-question` source/APIに合わせる。

```ts
interface AskUserQuestionRequest {
  version: 1;
  requestId: string;
  title?: string;
  questions: Array<{
    question: string;
    header?: string;
    options: Array<{
      label: string;
      description?: string;
      preview?: string;
      value?: string;
    }>;
    multiSelect?: boolean;
    allowOther?: boolean;
  }>;
}
```

Success/error:

```ts
interface AskUserQuestionSuccessResponse {
  version: 1;
  requestId: string;
  success: true;
  result: {
    status: "answered" | "user-cancelled" | "caller-aborted" | "shutdown";
    questions: unknown[];
    answers: Record<string, string | string[]>;
    selections: unknown[];
    cancelled: boolean;
    response?: string;
  };
}

interface AskUserQuestionErrorResponse {
  version: 1;
  requestId: string;
  success: false;
  error: {
    code: "invalid-request" | "unsupported-version" | "duplicate-request-id" | "tui-unavailable" | "internal-error";
    message: string;
  };
}
```

### 17.3 `pi-intercom` channel

Rootとchildは同じnamespaceのpublic Extension Channelをstructural contractで登録する。

```ts
interface IntercomExtensionChannel {
  readonly namespace: string;
  snapshot(): {
    connected: boolean;
    supported: boolean;
    owner?: { sessionId: string; epoch: string };
  };
  publish(payload: unknown, options?: { audience?: "owner" | "capable"; ownerOnly?: boolean }): void;
  listSessions(): Promise<unknown[]>;
}
```

Registration event:

```text
intercom:extension-register
```

Root registration:

```text
namespace: pi-workflow
ownerEligible: true
```

Child registration:

```text
namespace: pi-workflow
ownerEligible: false
```

Root `onEvent({type:"message", fromSessionId, payload})`は次を検証する。

- payload version/kindがknown。
- `originSessionId === fromSessionId`。
- `workflowId`がactive registryで一致。
- `coordinatorRunId`がcurrent planning/implementation runと一致。
- requestIdがpending interactionと一致。

### 17.4 Request payload

```ts
interface HumanDecisionBridgeRequest {
  version: 1;
  kind: "human-decision-request";
  workflowId: WorkflowId;
  requestId: RequestId;
  originSessionId: string;
  coordinatorRunId: RunId;
  title?: string;
  questions: AskUserQuestionRequest["questions"];
}

interface HumanDecisionBridgeResponse {
  version: 1;
  kind: "human-decision-response";
  workflowId: WorkflowId;
  requestId: RequestId;
  recipientSessionId: string;
  status: "answered" | "user-cancelled" | "caller-aborted" | "shutdown" | "failure";
  result?: AskUserQuestionSuccessResponse["result"];
  error?: { code: string; message: string };
}
```

### 17.5 Timeout/cancel/duplicate

- Rootは`ctx.mode === "tui"`を確認する。RPC/print/jsonまたはTUI unavailableではquestionnaireを開始せず、`tui-unavailable`としてfail closedする。
- Rootはreply listenerを登録してからrequest eventをemitする。
- `humanDecisionTimeoutMs = 14_400_000` msを使う。timeoutはfail closedで、default answerやautomatic retryに変換しない。test seamとしてdependency injectionすることだけを許可する。
- timeout前に`pi-ask-user-question:cancel:v1`を同じrequestIdでemitする。
- `pi-ask-user-question`はactive/queued duplicate requestを再実行せず、completed responseをreplayする。Rootも同一fingerprintをbounded cacheする。
- same requestId + different payloadはconflictとしてoriginalを妨げず、conflictをfailure recordにする。
- `answered`以外はCoordinatorのdecisionを満たさない。
- `tui-unavailable`、shutdown、cancel、timeout、publish failureはdefault answerにしない。
- responseは同じ`requestId`、同じ`recipientSessionId`で一度だけpublishする。

### 17.6 Reload/shutdown

session shutdown時:

```text
Root marks pending interaction terminal/non-advancing
→ emits pi-ask-user-question cancel when possible
→ publishes failure/shutdown to same Coordinator when channel live
→ clears waiter/listener
→ late answer is ignored
```

`pi-ask-user-question` sourceのsession shutdown responseは`status:"shutdown"`としてfail closedに扱う。

**Evidence**: `[E:human-bridge-tui-results.md, human-bridge-capability-results.md, grilling-nested-capability-results.md]` `[S:pi-ask-user-question/src/api.ts; src/runtime/event-adapter.ts; README.md; pi-intercom source]` `[D]`

---

## 18. Plan Artifact

### 18.1 Canonical file

```text
implementation-plan.md
```

Plan ArtifactはImplementation CoordinatorがPlanning transcriptなしで実装を開始できるself-contained contentである。Rootがplan bodyを読むのはdirect Plannotator UIとhash validationのためだけであり、Root Parent LLMへ送らない。

### 18.2 Formal template

Plan Composerは次のheadingをすべて生成する。headingの追加は許可するが、必須headingを削除しない。

```md
# Implementation Plan

## Goal
<!-- User outcome and measurable end state. -->

## Requirements
<!-- Numbered, testable requirements. Include acceptance-relevant behavior. -->

## Non-goals
<!-- Explicitly excluded behavior, files, automation, and authority. -->

## Constraints
<!-- Architecture, compatibility, security, dependency, and repository constraints. -->

## Expected change areas
<!-- Candidate source/test/config paths. Do not claim files not supported by evidence. -->

## Implementation approach
<!-- Ordered bounded steps, ownership, and stop conditions. -->

## TDD mode
<!-- required | optional | not-applicable, with reason. -->

## Test strategy
<!-- Unit/integration scope, command intent, regression cases, and failure interpretation. -->

## Test seams
<!-- Public functions, adapters, fake event buses, or integration seams to exercise. -->

## Verification
<!-- Exact commands whose existence is confirmed by repository evidence, and expected evidence. -->

## Trusted Gate expectations
<!-- Required Gate expectations from the Plan and repository evidence; no fabricated PASS results. -->

## Risks / assumptions
<!-- Known risks, unresolved facts, and explicit decision requests. -->
```

### 18.3 Content rules

- Goal/Requirements/Non-goals/Constraintsは具体的であること。
- Expected change areasはrepository evidenceに基づき、globally arbitraryな範囲を指定しない。
- TDD modeが`required`ならImplementation CoordinatorはWorkerへexplicit `tdd` Skillを渡す。
- Test strategyはfailureとREDの区別を記述する。syntax/dependency/infrastructure failureをvalid REDと扱わない。
- Test seamsはpublic function、adapter、fake event bus、managed command boundaryを指定する。
- Verificationに書くcommandは、package scripts、build targets、CI configuration、repository documentationのいずれかで存在を確認できるものだけにする。存在を確認できないcommandを発明しない。
- `pnpm check`がrequiredとPlanに記載されている場合、Implementationはそのaggregate commandをそのまま実行し、componentsへ勝手に展開しない。
- VerificationとTrusted Gate expectationsはPlan Review対象であり、plan approvalはそれらを含むPlan全体に対するapprovalである。
- planにはapproval、reviewId、approvedPlanHash、review feedbackを入れない。
- planにはraw report/transcriptを貼らず、必要ならbounded evidence referenceを記載する。

### 18.4 Plan Composer output ownership

Plan ComposerはPlanning Coordinatorからdelegatedされるが、canonical Plan Artifactのlogical ownerはPlanning Coordinatorである。RootはPlan Artifactをrewriteしない。

**Traceability**: `[A:19]` `[E:phase-handoff-capability-results.md, full-workflow-composition-results.md]` `[D]`

---

## 19. Planning Handoff

### 19.1 Canonical file and ownership

```text
planning-handoff.json
```

- Planning Coordinatorが一度だけ生成する。
- Planning completion後にRoot、Plannotator、Implementation Coordinatorは書き換えない。
- plan revisionは新しいPlan Artifact/new Handoffを生成する。既存Handoffをpatchしない。

### 19.2 Exact schema version 1

`additionalProperties: false`相当のstrict validationを実装する。

```json
{
  "schemaVersion": 1,
  "kind": "pi-workflow.planning-handoff",
  "workflowId": "wf-<uuid>",
  "planArtifact": {
    "path": "implementation-plan.md",
    "mediaType": "text/markdown"
  },
  "planHash": {
    "algorithm": "SHA-256",
    "encoding": "hex",
    "value": "<64 lowercase hex characters>"
  },
  "tddMode": "required",
  "testStrategy": {
    "kind": "unit",
    "required": true,
    "summary": "..."
  },
  "testSeams": ["..."],
  "constraints": ["..."],
  "nonGoals": ["..."],
  "planningRunId": "<optional opaque run id>"
}
```

Required:

```text
schemaVersion
kind
workflowId
planArtifact.path
planArtifact.mediaType
planHash
planHash.algorithm
planHash.encoding
planHash.value
tddMode
testStrategy
testSeams
constraints
nonGoals
```

Optional:

```text
planningRunId
```

Excluded:

```text
reviewId
approval
approvalFeedback
approvedPlanHash
```

### 19.3 Value bounds

- `planArtifact.path`はHandoff directoryからのrelative pathで、初期実装では`implementation-plan.md`に固定する。absolute path、`..`、symlink escapeを拒否する。
- arraysは最大32 items。各stringは最大4096 UTF-8 bytes。
- `testStrategy.summary`は最大8192 UTF-8 bytes。
- hashはlowercase hex 64文字のみ。
- unknown field、wrong type、missing required field、invalid pathはfail closed。

### 19.4 Validation owner

Planning Coordinatorが作成直後にvalidateする。RootはPlan Review前とImplementation launch前に再validateする。Implementation CoordinatorもWorker launch前に再validateする。三者のvalidatorは同じ`core` ruleを使うが、file contentはRoot stateへ複製しない。

**Traceability**: `[A:20,21]` `[E:phase-handoff-capability-results.md]` `[D]`

---

## 20. Plan Identity / Hashing

### 20.1 Algorithm

```text
algorithm: SHA-256
output: lowercase hexadecimal, 64 characters
```

Node `crypto.createHash("sha256")`を使う。Plan hash logicはPi非依存のcore responsibilityとし、Pi APIへ依存しない。

### 20.2 Canonicalization contract

`implementation-plan.md`をbytesでreadし、次の順にcanonicalizeする。

1. UTF-8をfatal decoderでdecodeする。invalid UTF-8はfailure。
2. 先頭のU+FEFFがあれば一つだけ除去する。
3. `CRLF`を`LF`へ変換する。
4. bare `CR`を`LF`へ変換する。
5. 末尾にLFがなければ一つ追加する。
6. それ以外の文字、Unicode normalization、leading/trailing spaces、Markdown content、blank linesは変更しない。
7. canonical textをUTF-8 bytesへ再encodeする。
8. bytesへSHA-256を適用する。

末尾の複数LFをtrimしない。blank lineの変更はplan content changeとしてhashを変える。BOMとline-endingだけはcross-platform canonicalizationで吸収する。

### 20.3 Compute points and owner

```text
Planning Coordinator:
  plan write → hash compute → Handoff write → self-validate

Root before plan review:
  read current Plan Artifact → compute hash → compare Handoff

Root after plan approval:
  read current Plan Artifact → compute hash → compare approvedPlanHash

Root before Implementation spawn:
  same checks again

Implementation Coordinator before Worker:
  same checks again
```

Plannotatorへ渡す`planContent`はcanonicalized textを使う。approval identityはその同じcanonical bytesのhashへbindする。

### 20.4 Mechanical anti-reuse guarantee

Implementation launch precondition:

```text
currentPlanHash === Handoff.planHash.value
currentPlanHash === Root.approvedPlanHash
approval === true
reviewId is valid
```

どれかが違えばlaunchしない。Planがapproval後に変更されるとcurrent hashが変わるため、以前のapprovalは機械的に再利用できない。RootがHandoffへapproved metadataを書き戻してhashを合わせる処理は禁止する。

**Traceability**: `[A:19,20,21,40]` `[E:phase-handoff-capability-results.md]` `[D]`

---

## 21. Plannotator Plan Review

### 21.1 Direct API

Root Extensionからpublic shared eventを直接呼ぶ。

```text
channel: plannotator:request
action:  plan-review
```

Plan modeを使わない。

### 21.2 Request

```ts
interface PlannotatorRequest<TPayload> {
  requestId: string;
  action: "plan-review" | "review-status" | "code-review";
  payload: TPayload;
  respond: (response: PlannotatorResponse<unknown>) => void;
}

interface PlanReviewPayload {
  planContent: string;
  planFilePath?: string;
  origin?: string;
}
```

RootはrequestIdを生成し、`planContent`をcanonical plan textから設定する。`planFilePath`はmanaged pathをbrowserが必要とする場合だけ渡す。

### 21.3 Pending/result lifecycle

Current Plannotator handler contract:

```text
request.respond({
  status: "handled",
  result: { status: "pending", reviewId }
})

later:
plannotator:review-result {
  reviewId,
  approved,
  feedback?,
  savedPath?,
  agentSwitch?,
  permissionMode?
}
```

Rootはpending responseから`reviewId`を保存し、`pendingInteraction.kind = "plan-review"`にする。

### 21.4 Status recovery

timeoutまたはstartup raceのとき、同じ`reviewId`で次を一度だけqueryできる。

```text
channel: plannotator:request
action:  review-status
payload: { reviewId }
```

result:

```text
{ status: "pending" }
{ status: "completed", reviewId, approved, feedback? }
{ status: "missing" }
```

`completed`のstructured resultだけをconsumeする。`missing`、unavailable、invalid responseはapprovalではない。status queryはrecovery readであり、automatic review retryではない。

### 21.5 Rejection/resubmission

v1では`maxPlanResubmissions = 1`とする。initial Plan submissionはcountしない。approvalに時間 expiryは設けない。

- `approved:false`は`approval=false`とfeedback記録で`PLAN_REVIEW`に留める。
- rejectionはImplementationを起動しない。
- 一度だけ許可するexplicit resubmissionでは、fresh Planning Coordinator、新しいPlan Artifact、新しいimmutable Handoff、新しいplan hash、新しいPlannotator request/review identityを使う。
- old Handoff/planを上書きしない。
- `reviewId`を使い回さない。
- 二度目のPlan rejectionは`FAILED`とし、新しいautomatic planning loopを作らない。
- approved Plan content/hashが変わればapprovalは無効になる。時間経過だけではapprovalを失効させない。

### 21.6 Unavailable/timeout

Plannotator responseが`unavailable`/`error`、browser startup failure、timeout、missing resultの場合:

```text
approval is not true
phase does not advance
Root records bounded failure
no plan-mode fallback
no Parent LLM fallback
no automatic retry
```

**Evidence**: `[E:plannotator-direct-api-results.md]` `[S:@plannotator/pi-extension/plannotator-events.ts; README.md]` `[D]`

---

## 22. Approval Identity

### 22.1 Concrete schema

core layerのApproval Identity validation:

```ts
export interface ApprovalIdentity {
  approvedPlanHash: PlanHashValue;
  reviewId: ReviewId;
  approval: true;
  approvalFeedback?: string;
}
```

`approvalFeedback`はoptional、最大16 KiB。approval false/pendingを`ApprovalIdentity` typeで表さない。Root stateでは未成立を`approval: null`または`false`で表す。

### 22.2 Owner and storage

Approval IdentityはRoot Control Planeだけがcanonical ownerである。Root stateへ次を保存する。

```text
reviewId
approvedPlanHash
approval
approvalFeedback (bounded)
```

`planning-handoff.json`へ次を追加しない。

```text
reviewId
approval
approvalFeedback
approvedPlanHash
```

### 22.3 Validity

Approval Identityがvalidなのは次のすべてを満たす場合だけ。

```text
approval === true
reviewId is non-empty valid ReviewId
approvedPlanHash is exactly 64 lowercase hex
approvedPlanHash === currentPlanHash
Handoff.planHash.value === currentPlanHash
```

Plannotator rejection、browser close、timeout、unavailable、invalid response、conflicting duplicateはvalid approvalではない。

**Traceability**: `[A:20,21,30]` `[E:plannotator-direct-api-results.md, phase-handoff-capability-results.md]` `[D]`

---

## 23. Planning → Implementation Transition

### 23.1 Pre-launch validation checklist

Rootがfresh Implementation Coordinatorをlaunchする直前に、次を順番に検証する。

```text
[ ] Plan Artifact exists
[ ] Planning Handoff exists
[ ] Handoff schemaVersion/kind valid
[ ] Handoff has no unknown/approval fields
[ ] Handoff planArtifact path resolves to the Plan Artifact
[ ] Handoff planHash equals current Plan Artifact hash
[ ] Root-owned Approval Identity exists
[ ] approval === true
[ ] approvedPlanHash equals current Plan Artifact hash
[ ] reviewId is valid
[ ] Plan has not changed since approval
[ ] Workflow phase is PLAN_REVIEW
[ ] Planning Coordinator is terminal/completed
[ ] approved Plan required Gates resolve against current repository with no detected drift
[ ] no active conflicting Implementation Coordinator
```

### 23.2 Launch contract

```ts
export interface ImplementationCoordinatorInput {
  contractVersion: 1;
  workflow: {
    workflowId: WorkflowId;
    workflowType: WorkflowType;
    cwd: string;
  };
  planArtifactRef: ArtifactRef;
  planningHandoffRef: ArtifactRef;
  approval: ApprovalIdentity;
  runtime: {
    timeoutMs: number;
    maxSubagentDepth: 2;
    outputMode: "file-only";
  };
}
```

productionの`runtime.timeoutMs`は`43_200_000` ms固定とし、test seam以外で変更しない。Plan bodyはinput JSONへ複製しない。Implementation Coordinatorがartifact refをreadする。

### 23.3 Failure

validation failureはspawnを実行しない。Root stateは`PLAN_REVIEW`からadvanceしない。approval metadataをHandoffへ書いて修復しない。failure reasonはRoot stateのbounded failure summaryとmanaged artifactへ保存する。

### 23.4 Freshness

Planning Coordinator run/sessionとImplementation Coordinator run/sessionは異なる。Planning contextをresume/forkしない。Implementation Coordinatorはfresh contextで起動し、Plan Artifact/Handoff/Approval Identityを明示的に読む。

**Traceability**: `[A:21,22,23]` `[E:phase-handoff-capability-results.md, full-workflow-composition-results.md]` `[D]`

---

## 24. Implementation Coordinator

### 24.1 Agent registration

`agents/implementation-coordinator.md`:

```yaml
---
name: implementation-coordinator
package: pi-workflow
description: Owns bounded implementation, trusted gates, review finding disposition, fixes, and readiness.
tools: read, grep, find, ls, subagent, subagent_supervisor, pi_workflow_code_review, pi_workflow_inspect_diff
subagentOnlyExtensions: "<runtime child-bridge adapter path>"
allowNestedSubagents: true
maxSubagentDepth: 2
excludeTools: contact_supervisor
inheritProjectContext: false
inheritGlobalContext: false
inheritSkills: false
systemPromptMode: replace
defaultContext: fresh
async: true
acceptanceRole: writer
---
```

System promptの必須規則:

```text
You are the pi-workflow Implementation Coordinator.
Read Plan Artifact, Planning Handoff, and Root-owned Approval Identity before launching any Worker.
Do not edit source directly.
Do not ask Root Parent LLM to synthesize reports or choose dispositions.
Launch Workers with bounded approved scope.
Launch Reviewers fresh and read-only.
Normalize raw reports into Findings and own Disposition.
Never send raw Reviewer prose to a Worker.
Use one bounded Fix Worker for BLOCKER/FIX_NOW findings in a wave.
Run Plan-approved required gates, any mechanically required additional gates, a fresh Focused Re-review after every Fix Wave, and final diff inspection.
Request code review through pi_workflow_code_review and continue in this same Coordinator run.
Do not merge, push, release, or deploy.
```

### 24.2 Internal responsibility

```text
handoff validation
→ Worker launch/TDD
→ approved Trusted Gate validation/execution
→ fresh Reviewer wave
→ Finding normalization
→ Disposition
→ bounded Fix Wave
→ affected Re-gates
→ Focused Re-review (iff Fix Wave occurred)
→ Final Diff Inspection
→ Root code-review bridge
→ Ready-for-Merge evaluation
```

### 24.3 Output contract

```ts
export interface ImplementationCoordinatorResult {
  contractVersion: 1;
  workflowId: WorkflowId;
  status: "COMPLETED" | "FAILED" | "CANCELLED";
  trustedGateSummaryRef?: ArtifactRef;
  findingDispositionSummaryRef?: ArtifactRef;
  workerArtifactRefs: ArtifactRef[];
  reviewerArtifactRefs: ArtifactRef[];
  fixArtifactRefs: ArtifactRef[];
  reReviewArtifactRefs: ArtifactRef[];
  finalInspectionRef?: ArtifactRef;
  codeReviewResult?: CodeReviewResultSummary;
  readyForMerge: ReadyForMergeResult;
  remainingBlockers: string[];
}
```

Raw Worker/Reviewer report body、full diff、full gate logsはRoot Parent contextへ返さない。Rootにはこのsummaryとartifact refsだけを返す。`status:"COMPLETED"`はfinal code review approved後に`readyForMerge.ready === true`となった場合だけ許可する。未成立のreadinessは`FAILED`またはCoordinator内部のnon-terminal continuationとして扱う。

**Traceability**: `[A:22]` `[E:implementation-composition-results.md, full-workflow-composition-results.md]` `[D]`

---

## 25. Worker / TDD

### 25.1 Worker launch

Workerはcurrent builtin `worker`を使う。package内でWorker agentをcopyしない。

```text
agent: worker
context: fresh
skills: [tdd] when Handoff.tddMode === required
outputMode: file-only
worktree: false (initial single-writer cwd policy)
```

Worker prompt contract:

```text
workflow identity
approved requirements
approved scope
allowed files/areas if known
non-goals
TDD mode
Test strategy
Test seams
Verification commands
Trusted Gate expectations
stop condition
no merge/push/release/deploy
```

Workerのsource/test writeはapproved scopeへ限定する。`write`/`edit`のexact path validationはWorker task、Coordinator diff inspection、Gate evidenceの三点で確認する。OS sandboxを装ったpromptだけに依存しない。

### 25.2 TDD contract

`TddMode === "required"`なら`tdd` Skillをexplicit injectする。Workerは次をartifactへ残す。

```text
RED: relevant behavioral test fails
GREEN: implementation makes required test pass
REFACTOR: performed or explicitly skipped with reason
```

次はREDではない。

```text
syntax error
missing dependency
broken test runner
infrastructure failure
```

Test commandはPlan Artifact/Repository-declared sourceから取得し、Workerが成功と書いたことだけでGate PASSにしない。

### 25.3 Authority prohibition

Workerは次を実行しない。

```text
merge
push
release
deploy
approval decision
architecture change outside plan
```

**Evidence**: `[E:v068-worker-reviewer-capability-results.md, implementation-composition-results.md]` `[D]`

---

## 26. Trusted Gates

### 26.1 Gate model

core layerは、repository evidenceから確認したverificationとその実行結果を表す最小Trusted Gate modelを提供する。

```ts
export type TrustedGateStatus = "PASS" | "FAIL" | "SKIPPED" | "UNKNOWN";
export type GateRequirement = "required" | "optional";

export interface TrustedGate {
  name: string;
  command: string;
  requirement: GateRequirement;
  status: TrustedGateStatus;
  evidence?: ArtifactRef;
  reason?: string;
  source: "package-script" | "build-target" | "ci-config" | "repository-doc";
}
```

Rules:

- `PASS`: managed runnerがexact commandを実行し、exit successとbounded evidenceを返した。
- `FAIL`: managed runnerがcommandを実行し、nonzero/failed resultを返した。
- `SKIPPED`: 実行不要である根拠とreasonを記録した。
- `UNKNOWN`: command、evidence、statusを安全に確定できない。required Gateならblockする。

### 26.2 Planning responsibility and evidence-backed commands

Planning Coordinatorが次のrepository evidenceを確認し、今回必要なverificationをPlanの`Verification` / `Trusted Gate expectations`へ記述する。

```text
package.json scripts
build configuration / targets
CI configuration
repository documentation
```

Planへ書くcommandは存在を確認できたものだけにする。arbitrary shell snippet、free-form user command、未確認のcommandをTrusted Gateとして発明しない。CI/docsに示されたcommandも、repository上の実体へ安全に解決できる場合だけ記載する。evidence間に矛盾があり安全に解決できない場合はPlanをblockし、推測で分類しない。

Plan Reviewは`Verification`と`Trusted Gate expectations`を含むPlan全体を対象にする。したがって、required Gateの選択とcommandはPlan approvalに含まれる。

`pnpm check`がPlanでrequiredなら、Implementationは`pnpm check`をexact Gateとして実行する。`pnpm typecheck`、`pnpm lint`、`pnpm test:run`などへ勝手に展開して二重実行しない。Planまたはrepository evidenceにより別の独立Gateがrequiredなら、そのGateは別途実行する。

### 26.3 Implementation validation and runner

Implementation CoordinatorはPlanのrequired Gateを再分類・再発見しない。Implementation開始時に、approved PlanのGateが現在もrepository上で解決でき、Plan approval後に前提がdriftしていないことをvalidateする。

```text
approved required Gateが消失・変更し、安全に解決できない
  → plan/repository drift
  → fail closed
  → optionalへdowngradeしない
```

actual implementation changeにより、repositoryの明示的ルールから追加verificationが機械的に必要と判断できる場合だけrequired Gateを追加してよい。

```text
approved Plan required Gates ⊆ final required Gates
```

required Gateを減らしてはならず、「念のため」のGateを発明してはならない。

Gate executionはImplementation Coordinatorがorchestrateし、Workerのacceptance claimに委ねない。current public `pi-subagents`のmanaged `gate` / verified acceptance pathを使う。

概念上のCoordinator script:

```js
const gateResult = await runs.run("gate-" + gate.name, {
  agent: "<selected read-only gate validation role>",
  context: "fresh",
  task: "Run the exact repository-declared gate. Report no invented success; runtime evidence is authoritative.",
  gate: gate.command,
  timeoutMs: timeouts.gateTimeoutMs
});
return gateResult;
```

Managed Gate validationはImplementation Coordinator内で直接構成しても、read-onlyの専用validatorへ委譲してもよい。専用validatorを使う場合の`gate-validator`はreference roleであり、独立fileをmandatoryにはしない。

Reference configuration:

```yaml
---
name: gate-validator
package: pi-workflow
description: Read-only managed verification gate validator.
tools: read, grep, find, ls
excludeTools: contact_supervisor
inheritProjectContext: false
inheritGlobalContext: false
inheritSkills: false
systemPromptMode: replace
defaultContext: fresh
acceptanceRole: read-only
completionGuard: false
---
```

`gate`のhost-run result、exit code、timeout、saved logをevidenceにする。model proseはPASS根拠にしない。runtimeのGate execution responsibilityは独自process runnerやartifact storeを実装せず、Coordinator内のpublic `runs.run`/`gate` invocationを構成し、返ったmanaged evidenceをGate modelへ写像するだけである。timeoutはsection 34の固定値を使い、test seam以外のruntime configurationは持たない。

### 26.4 Required / optional semantics

```text
required FAIL    → block
required UNKNOWN → block
required SKIPPED → invalid/unknownとしてblock
required PASS    → condition satisfied

optional PASS    → record
optional FAIL    → record。requiredでない限り単独blockなし
optional UNKNOWN → record。requiredでない限り単独blockなし
optional SKIPPED → record。単独blockなし
```

`Ready-for-Merge`はapproved Planの全required GateのPASSを要求する。Optional Gateのsemanticsは保持するが、v1通常フローでoptional Gateを積極的に生成するpolicyは設けない。`optional SKIPPED`単独でblockしない。

### 26.5 Affected re-gate selection

変更後にどのGateを再実行するかのexact algorithmはImplementation Detailであり、ここではproduct policyとして固定しない。実装は次のbounded inputsを使ってよい。

```text
approved Plan / repository-declared Gate evidence
changed files and Fix Worker changed files
Gate declared scope
accepted Finding locations
approved required Gate set
```

minimum rules:

- approved required Gateをfinal required Gateから除外しない。
- actual changeとrepositoryの明示的ルールから機械的に必要なadditional required Gateだけを追加する。
- `pnpm check`などaggregate commandは、requiredならaggregateのまま扱う。
- additional Gateを「念のため」で発明しない。
- rerun / skipのreasonとevidenceをrecordする。

全Gateの無条件rerunも、optional Gateの積極的生成もv1 policyにはしない。

**Traceability**: `[A:24,27,30]` `[S:pi-subagents/docs/tool-reference.md#acceptance-gates; workflows.md#host-command-steps]` `[E:implementation-composition-results.md, full-workflow-composition-results.md]` `[D]`

---

## 27. Reviewer / Finding Model

### 27.1 Reviewer launch

Reviewerはfresh contextかつread-onlyで起動し、Worker sessionをresume/forkしない。利用可能なpublic reviewer mechanismを使い、source/test mutation toolとWorkerへのdirect channelを与えない。

```text
agent: reviewer
context: fresh
read-only: yes
outputMode: file-only
```

Reviewer input:

```text
workflow identity
Plan Artifact ref
Planning Handoff ref
Worker output/diff artifact refs
current cwd
non-goals
bounded review scope
```

Reviewerの人数、scope分割、specialization、Skill compositionはここでproduct policyとして固定しない。Implementation Coordinatorがapproved Planとavailable evidenceを満たす最小構成をImplementation Detailとして選ぶ。Runtime evidenceとしてReviewer + Ponytail compositionが存在することは保持するが、mandatory topologyやalways-on Skill policyにはしない。

### 27.2 Reviewer composition boundary

- Workflow Type policyにReviewer構成を埋め込まない。
- exact Reviewer count、review scope分割、specialized Reviewerの種類、Skill selectionはImplementation Detailである。
- Reviewerは常にfresh/read-onlyで、Reviewer自身がWorkerを制御しない。
- review resultはraw artifactとcompact referenceでCoordinatorへ渡し、Root Parent LLMへ送らない。

### 27.3 Finding schema

Findingは、raw Reviewer reportをImplementation Coordinatorがdisposition可能なbounded recordへnormalizeしたものとする。minimum semanticsは次である。

```text
stable Finding ID
review provenance/source
location when applicable
severity/priority when useful
evidence
reason
recommended action when useful
```

Exact TypeScript fields、severity enum、location bounds、string limitsはImplementation Detailとしてproduction implementation時に決める。Severity/priorityを持つ場合もDispositionを自動決定しない。normalized Findingにはdispositionに必要なevidenceとreasonを必ず含める。

Raw Reviewer proseは同じreview artifactへ保存し、Root stateへ複製しない。

**Evidence**: `[E:v068-worker-reviewer-capability-results.md, implementation-composition-results.md]` `[D]` `[ID]`

---

## 28. Finding Disposition

### 28.1 Concrete enum

```ts
export type Disposition = "BLOCKER" | "FIX_NOW" | "DEFERRED" | "REJECTED";

export interface FindingDisposition {
  findingId: FindingId;
  disposition: Disposition;
  reason: string;
}
```

### 28.2 Rules

| Disposition | Rule | Readiness |
| --- | --- | --- |
| `BLOCKER` | 今回解消しない限り進められない | unresolvedならblock |
| `FIX_NOW` | approved scope内で今回修正する | unresolvedならblock |
| `DEFERRED` | scope外/別workへ明示的に送る | reason/documentation必須 |
| `REJECTED` | evidence不足、false positive、要求外 | reason/documentation必須 |

Implementation CoordinatorだけがDispositionを決める。Root Parent LLM、Reviewer、Workerへ委譲しない。

`BLOCKER`/`FIX_NOW`が一件以上あればFix Waveが必要。`DEFERRED`/`REJECTED`はfinal summaryへ残す。Dispositionのreasonが空ならvalidation failure。

### 28.3 Normalization

Coordinatorは各raw reportからbounded Findingを作る。raw proseをFix Worker promptへcopyしない。Promptへ入れるのは、accepted Finding ID、必要なlocation/evidence/reason、approved disposition、approved scopeだけとし、実装に不要なreview detailを複製しない。Exact prompt fieldsはImplementation Detailである。

複数Reviewerのfindingが重複する場合のmerge方法もImplementation Detailとし、重複を黙って失うことだけを禁止する。各accepted Findingは一意に追跡できるようにする。

**Traceability**: `[A:26,34]` `[E:implementation-composition-results.md, full-workflow-composition-results.md]` `[D]`

---

## 29. Fix Wave

### 29.1 Selection

Accepted findingsは`BLOCKER`と`FIX_NOW`だけである。同じreview waveのaccepted findingsは一つのbounded Fix Worker promptへ統合し、FindingごとにWorkerを増殖させない。

```text
max automatic Fix Waves = 1
no accepted Finding → no Fix Wave
Fix Waveあり → fresh Focused Re-review必須
```

### 29.2 Prompt contract

```text
Accepted finding IDs: [F-...]
Required changes:
  - one bounded change per accepted finding
Allowed scope:
  - approved files/areas only
Non-goals:
  - no scope expansion, no merge/push/release/deploy
Tests/gates:
  - Plan-approved required gates and mechanically affected verification
Stop condition:
  - report changed files, verification results, unresolved findings, and stop
```

Raw Reviewer report全文、未accepted Finding、free-form reviewer commandは渡さない。

### 29.3 Fix Worker

Fix Workerはcurrent `worker`をfreshで起動する。同一Coordinatorのbounded promptだけをinputにする。TDD mode requiredなら`tdd` Skillを再度explicit injectする。Fix Worker failure、approved scopeからのescape、required verification failureはfail closedとし、Ready-for-Mergeへ進めない。

### 29.4 Wave bound

自動Fix Waveの上限は1回である。Focused Re-reviewが`STILL_PRESENT`、Fix Workerがfailure、scope escape、またはrequired verificationがfailureになった場合、workflowは`FAILED`とする。Focused Re-review後にFix Wave #2を自動起動しない。automatic retryや新しいre-planning loopも作らない。

**Evidence**: `[E:implementation-composition-results.md, full-workflow-composition-results.md]` `[D]`

---

## 30. Re-gates / Focused Re-review

### 30.1 Re-gates

Fix Worker完了後、Coordinatorはsection 26.5のImplementation Detail algorithmで再実行対象を決める。approved Planのrequired Gateは必ずfinal required setに残す。

```text
Fix changed files
+ accepted Finding locations
+ Plan/repository Gate evidence
+ approved required Gate set
→ bounded re-gate selection
```

- actual changeとrepositoryの明示的ルールから機械的に必要なGateを再実行する。
- approved required Gateを減らさない。
- `pnpm check`などaggregate commandはrequiredならaggregateのまま実行する。
- additional Gateを「念のため」で発明しない。
- rerun/skip reasoningとevidence refをGate summaryへ保存する。

### 30.2 Focused Re-review

Fix Waveが存在した場合、例外なくfresh Focused Re-reviewを実行する。固定的なfile数、severity、影響の大小によるskipは認めない。

```text
agent: reviewer
context: fresh
read-only: yes
scope:
  accepted Finding IDs
  Fix Worker diff
  Finding判断に必要なPlan context
result: RESOLVED | STILL_PRESENT
```

元Reviewer sessionをresumeして自己確認させない。Focused Re-reviewはFix Workerの変更とaccepted Findingの状態だけを確認し、source writeやWorker direct controlを持たない。

### 30.3 Result semantics

```text
RESOLVED      → affected gates/final inspectionへ進む
STILL_PRESENT → Finding unresolved、workflow FAILED、Ready-for-Merge禁止
```

**Traceability**: `[A:27]` `[E:implementation-composition-results.md, full-workflow-composition-results.md]` `[D]`

---

## 31. Final Diff Inspection

### 31.1 Owner

Implementation Coordinatorがread-only inspectionを行う。Coordinator自身はsourceを直接修正しない。

### 31.2 Minimum checklist

```text
requirements implemented
non-goals respected
unexpected files absent
accepted BLOCKER/FIX_NOW resolved
deferred/rejected findings documented
approved required Gates PASS
optional gate outcomes recorded
working tree understood
```

### 31.3 Inspection mechanism

Coordinatorが`pi_workflow_inspect_diff` child-only toolを一度呼ぶ。toolは任意commandを受けず、固定read-only Git operationだけを実行する。

```text
git status --short
git diff --name-only
git diff --stat
git diff --check
```

必要なsource contentは`read`で読む。full diffはRoot/Parent contextへ送らず、managed artifactに保存する。unexpected file、scope drift、unresolved findingは、未使用の一度だけのFix Waveへ戻すか、使用済みなら`FAILED`にする。Fix Wave #2は起動しない。

**Traceability**: `[A:28]` `[E:implementation-composition-results.md, full-workflow-composition-results.md]` `[D]`

---

## 32. Plannotator Code Review

### 32.1 Direct API

Root Extensionは次だけを直接呼ぶ。

```text
channel: plannotator:request
action:  code-review
```

payload:

```ts
interface CodeReviewPayload {
  cwd: string;
  useLocal: true;
  defaultBranch?: string;
  diffType?: string;
  vcsType?: string;
  prUrl?: string;
}
```

`cwd/useLocal`はsame local repository reviewのinitial contract。その他はrepository/sourceが明示した場合だけ渡す。

### 32.2 No plan-mode dependency

次を呼ばない。

```text
plan-mode status
plan-mode enter
plan-mode toggle
--plan
```

Installed handlerは`code-review`を直接処理し、plan-mode availabilityを同等capability checkにしない。

### 32.3 Child-to-Root bridge

Implementation Coordinatorは`pi_workflow_code_review`を呼ぶ。child toolは次をpublishする。

```ts
interface CodeReviewBridgeRequest {
  version: 1;
  kind: "code-review-request";
  workflowId: WorkflowId;
  requestId: RequestId;
  originSessionId: string;
  coordinatorRunId: RunId;
  cwd: string;
}
```

Rootはrequestを検証し、direct Plannotator requestを発行する。Plannotator installed `code-review` resultに`reviewId` fieldはないため、Root local `requestId`をcorrelation identityとして使う。

### 32.4 Response

```ts
interface CodeReviewBridgeResponse {
  version: 1;
  kind: "code-review-response";
  workflowId: WorkflowId;
  requestId: RequestId;
  recipientSessionId: string;
  status: "approved" | "rejected" | "unavailable" | "timeout" | "failed";
  approved: boolean;
  feedbackRef?: ArtifactRef;
  annotationsRef?: ArtifactRef;
  error?: { code: string; message: string };
}
```

feedback/annotations raw contentはmanaged artifactへ保存し、Root stateはrefsとapproved/statusだけ保持する。

### 32.5 Same Coordinator continuation

Code review responseはsame `implementationRunId`のsame Coordinator sessionへpi-intercom channelで戻す。新Implementation Coordinatorをspawnしない。

v1では`maxCodeReviewChangeCycles = 1`とする。initial code reviewはcountしない。初回rejection後に限り、same Implementation Coordinatorがapproved scope内で、かつ新しいarchitecture/product/security decisionなしに、一度だけbounded change cycleを実行できる。そのcycleではrequired verification、finding処理、Fix Waveがあればfresh Focused Re-review、Final Diff Inspection、code reviewを再成立させる。二度目のrejection、scope escape、または新しいdecisionが必要な場合は`FAILED`/blockとし、自動re-planning loopを作らない。approvedならCoordinatorがreadiness evaluatorを呼ぶ。safe fixがない場合もFAILEDとする。

**Evidence**: `[E:plannotator-direct-api-results.md, implementation-composition-results.md, full-workflow-composition-results.md]` `[S:@plannotator/pi-extension/plannotator-events.ts]` `[D]`

---

## 33. Ready-for-Merge

### 33.1 Pure evaluator

Ready-for-Merge evaluatorはcore layerのPi非依存logicとし、Pi API、filesystem、RPC、UIに依存しない。

```ts
export type ReadinessCheckStatus = "PASS" | "FAIL" | "MISSING" | "UNKNOWN";

export interface ReadinessCheck {
  id:
    | "approved-plan-identity"
    | "implementation-complete"
    | "required-gates"
    | "accepted-findings"
    | "focused-re-review"
    | "final-diff-inspection"
    | "code-review";
  status: ReadinessCheckStatus;
  reason: string;
  evidenceRefs?: ArtifactRef[];
}

export interface ReadyForMergeResult {
  ready: boolean;
  status: "READY_FOR_MERGE" | "BLOCKED";
  checks: ReadinessCheck[];
  blockers: Array<{
    code: string;
    reason: string;
    evidenceRefs?: ArtifactRef[];
  }>;
}
```

### 33.2 Required conditions

```text
approved plan identity valid
implementation complete
all required Trusted Gates PASS
all BLOCKER resolved
all FIX_NOW resolved
Fix Waveなし、またはFix Wave後のfresh Focused Re-reviewがPASS
Final Diff Inspection PASS
Plannotator code review approved === true
```

### 33.3 Blocking semantics

- required Gateの`FAIL` / `UNKNOWN` / `SKIPPED`、またはmissing required Gateはblockする。
- Optional Gateの`SKIPPED`単独はblockしない。
- `approval !== true`、hash mismatch、invalid Handoffはblockする。
- Worker/Fix Worker failureはblockする。
- Fix Waveがあるのにfresh Focused Re-reviewがない、または`STILL_PRESENT`ならblockする。Fix Waveがない場合のFocused Re-reviewはnot applicableであり、実行しない。
- Plannotator unavailable/timeout/rejectionはblockする。
- code review change cycleの上限超過、scope escape、新しいdecision要求はblockする。
- checkが一つでも成立しない場合は`ready:false`とする。ただしFix WaveなしのFocused Re-review checkは「not applicable」を成立扱いにする。
- `ready` booleanだけを返さず、全checkとblocker reasonを返す。

### 33.4 Ownership

Final readiness decisionはImplementation Coordinatorが行う。Rootはphase/lifecycle/identityをrecordする。Root Parent LLMはdecision ownerではない。`READY_FOR_MERGE`はmerge実行許可ではなく、merge前conditionsが満たされたeligibilityである。

**Traceability**: `[A:30]` `[E:implementation-composition-results.md, full-workflow-composition-results.md]` `[D]`

---

## 34. Cancellation / Failure / Timeout

### 34.1 Cancellation ordering

Rootのcancellation responsibilityは次の順序で実行する。

```text
1. Root process-local registry lockを取得し、current non-terminal stateとworkflowIdを確認
2. phaseをCANCELLED、finalStatusをCANCELLEDへ固定し、snapshotをpersist
3. pending Human requestをcancel eventへ送る
4. pending Plannotator waiterをlocalでterminalにし、late resultを拒否
5. active top-level Coordinatorへpublic RPC stopを送る
6. statusで必要ならstoppable child identityを確認し、public child stopを送る
7. Coordinatorが保持するnested descendantsはtop-level stopで停止させる
8. artifactを削除せず、cancellation summaryとstop outcomesをmanaged artifactへ保存
9. final CANCELLED resultを一度だけemit/record
10. lockを解放
```

`stop`はstopped proofではなくstop requestである。stop failure/unknownでもRootはCANCELLED phaseからadvanceしない。childが遅れてsourceを変更する可能性はResidual Riskとして記録し、automatic recovery/restartをしない。

Plannotatorにはcurrent public cancel APIがないため、Rootはlate resultをcorrelation mapで拒否するだけでbrowserをprivate APIでcloseしない。

### 34.2 Failure table

| Failure | Status/result | Retry |
| --- | --- | --- |
| RPC ready missing / RPC request failure | no phase advance、Root `FAILED` | automatic retryなし |
| Coordinator failure | current phase `FAILED`、raw outputはartifact | automatic retryなし |
| child capability failure | required capabilityならCoordinator `FAILED`; conditional capabilityはevidence付きexplicit skipまたは`FAILED` |なし |
| Human unavailable/cancel/timeout | no answer、no approval、Coordinator failure |なし |
| Plannotator unavailable/timeout/missing | no approval、phase advance禁止 | status query以外のautomatic retryなし |
| Worker failure | implementation incomplete、`FAILED` |なし |
| Fix Worker failure | accepted finding unresolved、`FAILED` |なし |
| required Gate FAIL | readiness block、Coordinator `FAILED` | automatic fix/retryなし |
| required Gate UNKNOWN/timeout | block、evidence reason保存 |なし |
| optional Gate SKIPPED | recordのみ、単独blockなし |なし |
| Focused Re-review `STILL_PRESENT` | readiness block、`FAILED` |なし |
| second Plan rejection / invalid resubmission | `FAILED`、Implementationを起動しない |なし |
| second code-review rejection / scope escape / new decision | `FAILED`、Ready-for-Merge禁止 |なし |
| Fix Wave #2 request | `FAILED`、automatic loopなし |なし |
| resultDelivery ack failure | completion not trusted、`FAILED` |なし |
| conflicting duplicate event | fail closed、first valid terminal result以外を採用しない |なし |
| extension reload | active workflow stale/failed、no auto resume |なし |

### 34.3 Timeout classes and fixed defaults

無限待機は禁止する。production packageのfixed defaultsは次のとおりである。

| Timeout | Value | Scope / semantics |
| --- | ---: | --- |
| `rpcReadyTimeoutMs` | `5_000` | `ready` event待機 |
| `rpcReplyTimeoutMs` | `30_000` | 各RPC reply待機 |
| `coordinatorTimeoutMs` | `43_200_000` | Coordinator全体の12h wall-clock outer safety cap |
| `humanDecisionTimeoutMs` | `14_400_000` | Root Human Decision待機 |
| `planReviewTimeoutMs` | `14_400_000` | Plannotator plan review待機 |
| `codeReviewTimeoutMs` | `14_400_000` | Plannotator code review待機 |
| `gateTimeoutMs` | `1_200_000` | 各Trusted Gate実行 |

`coordinatorTimeoutMs`はactive execution時間ではなく、Coordinatorの開始から完了までの単純なwall-clock deadlineである。Human、Plannotator、Gateの待機中にpauseしない。個別timeoutもそれぞれ適用し、どのtimeoutでも結果はfail closedとする。

これらの値をproject/operator向けconfigurationとして公開しない。test seamとしてdependency injectionで値を差し替えることだけを許可する。未設定や無限deadlineへfallbackしない。

### 34.4 Retry policy

v1はtimeoutを含むすべてのfailureにautomatic retryを行わない。explicit plan resubmissionとsame Coordinatorのcode-review change cycleは、各上限内のstate transitionでありretry frameworkではない。Plan rejectionは一度、Code Review change cycleは一度だけ許可する。timeout後のstatus queryは既存reviewの状態確認であり、reviewを再起動しない。

**Traceability**: `[A:33,42]` `[S:Pi docs/extensions.md ctx.shutdown; pi-subagents/docs/tool-reference.md status/stop/resume; pi-ask-user-question README.md; Plannotator source]` `[D]`

---

## 35. Artifact Model

### 35.1 Managed artifact priority

独自artifact storeを実装しない。`pi-subagents` managed artifact mechanismの`outputMode:"file-only"`、`outputReference`、`artifactPaths`、async/workflow artifactsを使う。

### 35.2 Artifact ownership table

| Artifact | Owner | Canonical/derived | Reference | Retention/cleanup |
| --- | --- | --- | --- | --- |
| `implementation-plan.md` | Planning Coordinator | canonical execution content | `ArtifactRef` + Handoff relative path | Implementation/final result後まで保持。cleanupはpi-subagents/operator |
| `planning-handoff.json` | Planning Coordinator | canonical immutable Planning metadata | `ArtifactRef` | approval/implementation/final result後まで保持。Rootはwrite不可 |
| Scout report | Scout/Planning Coordinator | derived raw evidence | child `outputReference` | managed artifact ownerのcleanup |
| Researcher report | Researcher/Planning Coordinator | derived raw external evidence | file-only ref | managed artifact ownerのcleanup |
| Grilling/Human transcript | child/runtime bridge | derived evidence | bounded artifact ref | Root stateへbodyを複製しない |
| Oracle report | Oracle/Planning Coordinator | derived advisory | file-only ref | managed artifact ownerのcleanup |
| Worker report | Worker/Implementation Coordinator | derived implementation evidence | file-only ref | final summary参照中は保持 |
| Reviewer raw report | Reviewer | derived raw review | file-only ref | Finding summaryのsource evidence |
| normalized Finding/Disposition summary | Implementation Coordinator | canonical implementation decision artifact | artifact ref | final resultと共に保持 |
| gate log | managed gate runner | derived verification evidence | gate evidence ref | final readiness evidence |
| Fix Worker report/diff | Fix Worker | derived change evidence | artifact ref | re-review/final inspection evidence |
| Focused Re-review | fresh Reviewer | derived validation | artifact ref | readiness evidence |
| Final Diff Inspection | Implementation Coordinator | derived final validation | artifact ref | code review/readiness evidence |
| Plannotator plan/code feedback | Root bridge | external/derived review evidence | feedback/annotation refs | Plannotator/managed owner; Rootはbounded ref |
| final coordinator summary | Coordinator | derived compact summary | outputReference | `pi-subagents` result lifecycle |
| Root lifecycle snapshot | Root Extension | canonical lifecycle/identity state | Pi custom entry | Pi session retention; no raw body |

### 35.3 Retention boundary

- active workflow中にartifactを削除しない。
- Rootはmanaged artifactを自前のcleanup scanで削除しない。
- `pi-subagents`のtemporary result/replay retentionによりreferenceが後からstaleになり得る。phase transition前のmissing artifactはfail closed。
- terminal後の保存期間、project artifact directoryのcleanup、manual archivalはpi-subagents/operator policyへ委譲する。正確なretention/cleanup mechanismはImplementation Detailである。
- package publish対象から`.pi/subagents/`を除外する。

### 35.4 Path/content rule

Artifact pathはreferenceであり、request text内のfilename instructionがruntime bindingをoverrideしない。output bindingは`runs.run` itemの`output`/`outputMode`に設定する。

**Traceability**: `[A:31,37]` `[S:pi-subagents/docs/tool-reference.md#output-mode-details; observability.md#async-run-artifacts]` `[E:phase-a-smoke-results.md, full-workflow-composition-results.md]` `[D]` `[ID]`

---

## 36. Persistence / Reload

### 36.1 Supported initial behavior

| Situation | Initial behavior |
| --- | --- |
| Root process restart with same persisted Pi session | latest small Root snapshotをrestore。active workflowはstaleとして`FAILED`、auto resumeなし |
| Extension reload | `session_shutdown` cleanup、active Coordinatorへbest-effort public stop、new runtimeはlate resultを自動consumeしない |
| stale active state | phase advance禁止。`ROOT_RUNTIME_RELOADED`/`STALE_CHILD` reasonでterminal failure |
| active child after reload | detached childはpi-subagents semantics上継続し得るが、new Rootがcompletion authorityを自動claimしない |
| pending Human question | cancel/shutdownを返し、default answerなし |
| pending Plannotator review | pending waiterを破棄。public statusはmanual diagnosticに使えるが、自動approval適用なし |
| completed Coordinator before reload | event replayを仮定しない。artifact/statusの自動phase recoveryなし |
| completed terminal workflow | custom state snapshotをrestoreし、terminal resultとして表示可能 |
| `/tree` navigation | active Root workflow中は`session_before_tree`で拒否する。terminalまたはworkflowなしでは許可し、`session_tree`後にcurrent branchのlatest valid Root snapshotをrestoreする |
| no persisted session / different Root process | cross-process recovery/ownership claimはunsupported |

### 36.2 Shutdown hook

`session_shutdown`で次を行う。

```text
stop accepting new workflow commands
cancel bridge waiters
best-effort public stop active top-level Coordinator
persist terminal/stale Root snapshot
clear in-memory registry/listeners/channel
```

Pi docs上、`ctx.shutdown()`はgraceful requestであり、child processのunconditional kill proofではない。stop outcomeをsuccessと偽らない。

### 36.3 Why no auto-recovery

current public sourceはdetached childがsession shutdown後も継続し、notificationだけ失われ得ることを明記する。reload後のidentity claim、pending browser ownership、Coordinator same-session continuationを安全に保証するpublic APIは確認していない。したがって初期実装でrecoveryを発明しない。durable recoveryはDeferredである。

**Traceability**: `[A:37,42]` `[S:Pi docs/extensions.md session_shutdown/reload; pi-subagents/docs/observability.md host session lifetime]` `[E:b0-investigation-results.md, human-bridge-tui-results.md]` `[D]`

---

## 37. Correlation / Idempotency

### 37.1 Identity ownership

| Identity | Generated/owned by | Scope | Used for |
| --- | --- | --- | --- |
| `workflowId` | Root Extension | one workflow | all Root state/bridge payloads |
| RPC `requestId` | Root RPC adapter | one RPC attempt | RPC reply correlation |
| `planningRunId` | pi-subagents, recorded by Root | one Planning Coordinator run | planning completion/status/stop |
| `implementationRunId` | pi-subagents, recorded by Root | one Implementation Coordinator run | implementation completion/status/stop |
| `humanRequestId` | child bridge tool | one logical Human question | pi-ask request/reply/cancel |
| plan-review `requestId` | Root Plannotator bridge | one Plannotator request | pending response/status query |
| plan-review `reviewId` | Plannotator | one browser review | `review-result`/`review-status` |
| code-review `requestId` | Root Plannotator bridge | one code review request | result and child return; installed code API has no reviewId |
| `FindingId` | Implementation Coordinator | one normalized Finding | disposition/fix/re-review |
| Fix Wave identity | none initially | artifact path + review round | one bounded wave; separate IDは作らない |

### 37.2 Event/request dedupe

- RPC: exact requestId waiter。duplicate replyはignore。
- async completion: `(sessionId, runId)`でdedupe。
- Human: `(requestId, fingerprint)`。same payloadはactive result/replay、different payloadはconflict。
- Plannotator plan: `(reviewId, planHash)`。同じdecision replay、conflicting decisionはfail closed。
- Plannotator code: local requestId。late response/duplicate responseはignore、conflictはfailure。
- intercom: `requestId + originSessionId + workflowId`を検証。foreign senderをconsumeしない。
- command: active registryでduplicate block。
- cancellation: terminal state後はsame resultを返し、second stopを送らない。

### 37.3 Conflicting terminal result

同じidentityでpayloadが異なる場合:

```text
first valid terminal resultを採用
conflictをbounded diagnostic artifactへ記録
phase advanceは止める
approval/readinessをconflictから復元しない
```

特に`approved:true`後の`approved:false` conflictはapprovalを自動でtoggleせず、workflowをfail closedにする。

### 37.4 Late delivery

`pendingInteraction`がない、phaseが変わった、coordinator run IDが違う、workflowがterminalの場合、late reply/eventはstate mutationしない。必要なら`late-event` diagnosticだけを保存する。

**Traceability**: `[A:37]` `[S:pi-subagents/docs/extension-api.md; pi-ask-user-question/src/runtime/event-adapter.ts; Plannotator events source; pi-intercom source]` `[D]`

---

## 38. Testing Strategy

### 38.1 Test principles

- Test runnerはVitest固定。
- CoreはPi-independent pure unitを中心にする。
- Runtimeはfake event bus、fake RPC、fake channel、fake filesystem adapterで検証する。
- 既存Architecture Smokeを機械的に全再実行しない。Full Smokeをuniversal pipelineのsuccess oracleにしない。
- Integrationはpublic contractのbounded pathだけを検証する。
- raw model proseをsuccess oracleにしない。
- exact test file/class/function nameは固定せず、responsibilityごとに最小のtest seamを置く。

### 38.2 Core semantic tests

最低限、次のsemantic contractを検証する。

```text
WorkflowType four values and command mapping
same Root session has one active workflow
cross-session/process global registry is unsupported; no lock mechanism is assumed
common Planning requirements: Scout/Plan Composition required, others evidence-driven conditional
Workflow Type changes Scout focus, not Gate/Reviewer matrix
package-built-in policy source; no project/operator override
phase transition and invalid transition rejection
Planning Handoff strictness, immutability, and plan/hash binding
Approval Identity true/review/hash validation
Trusted Gate PASS/FAIL/SKIPPED/UNKNOWN semantics
required Gate cannot be downgraded
plan/repository Gate drift fails closed
aggregate required command is not expanded into component commands
optional SKIPPED alone does not block; optional gates are not proactively generated
minimal Finding normalization and all dispositions with required reason
Fix Wave maximum one
no Fix Wave means no Focused Re-review
Fix Wave always requires fresh Focused Re-review; STILL_PRESENT fails
Plan resubmission maximum one; initial submission is not counted; approval has no time expiry
Code Review change cycle maximum one; initial review is not counted
all seven fixed timeout defaults, wall-clock Coordinator cap, no pause, fail closed, no automatic retry
Ready-for-Merge every blocking condition
```

### 38.3 Command tests

```text
registration names
trim request
empty request rejection
WorkflowType mapping
ctx.cwd propagation
workflowId creation
same-session active duplicate rejection
separate-session same-cwd operation is rejected by operational policy, not a machine guarantee
runtime delegation without Parent LLM message
host prerequisite failure refuses workflow start
runtime error notification
```

### 38.4 RPC / resultDelivery tests

```text
ready detection and all fixed timeout defaults
version/method/capability validation
request ID generation and reply correlation
reply timeout cleanup and fail-closed result
spawn async-only payload and run ID extraction
subagent:async-started/completion correlation
process-terminal treated as proof only
global intercomBridge.mode/resultDelivery prerequisite preflight
missing/invalid host prerequisite refuses start before Coordinator spawn
ack true suppresses normal completion path
ack false/timeout/unavailable fails closed
duplicate ack/unknown requestId
duplicate/conflicting completion
no automatic retry
reload disposes listeners
```

### 38.5 Bridge tests

```text
pi-intercom extension-register and owner/capable publish
Human request/reply/cancel, timeout, TUI unavailable, and default-answer prohibition
same request replay and conflicting duplicate
Plan review pending/review-status/rejection/approval
one explicit Plan resubmission uses fresh run/artifact/hash/review identity
second Plan rejection fails
approval remains valid across time when plan content/hash is unchanged
code review direct action and no plan-mode requests
code-review response uses local request correlation
same Coordinator continuation
one bounded code-review change cycle; second rejection fails
late response rejection
```

### 38.6 Lifecycle / gate tests

```text
IDLE → PLANNING → PLAN_REVIEW → IMPLEMENTING → CODE_REVIEW → READY_FOR_MERGE
failure from each active phase
cancellation ordering and terminal guard
Root custom state append/restore and no raw body
approved Plan required Gate resolution at Implementation start
missing/changed required Gate is plan/repository drift and fails closed
approved required Gates are never removed
additional Gate only when mechanically required by explicit repository rule
aggregate `pnpm check` runs as one exact Gate when required
one Fix Wave consolidates accepted findings
Fix Wave always runs fresh read-only Focused Re-review
RESOLVED continues; STILL_PRESENT fails
Final Diff Inspection and readiness evaluation
stale reload behavior and no auto recovery
```

### 38.7 Idempotency tests

```text
RPC duplicate
completion duplicate
Human same/different fingerprint
Plan result duplicate/conflict
Code result duplicate/conflict
unknown/late workflow event
repeated cancellation
```

### 38.8 Public integration tests

実Pi/外部Browserを常時起動するSmokeではない。fake/fixtureで次をboundedに確認する。

```text
Pi Extension registration shape
public RPC event envelope and async spawn contract
pi-intercom Extension Channel structural contract
pi-ask-user-question v1 request/reply contract
Plannotator plan-review/review-status/code-review contract
managed artifact reference boundary
Coordinator output contains refs, not raw reports
Reviewer fresh/read-only and no direct Worker control
```

実runtime integrationを追加する場合も、既存Architecture Smokeを全再実行せず、production codeのseamに対応するone-path testだけを追加する。

### 38.9 Agent static tests

`agents/*.md`について、次のauthority boundaryをstatic assertionで検証する。exact file/class/function nameやReviewer compositionは固定しない。

```text
package names resolve as pi-workflow.<name>
Coordinator has only bounded nested authority
Reviewer/gate validator have no write tool
subagentOnlyExtensions path exists
inheritSkills:false where explicit Skill control is required
selected Skill is passed explicitly when a Skill is used
```

**Traceability**: `[A:38,43]` `[E:v068-worker-reviewer-capability-results.md, implementation-composition-results.md, /Users/minoru/Documents/mywork/pi-subagents-result-delivery-report.md]` `[D]`

---

## 39. Quality Gates

### 39.1 Local canonical entry

```bash
pnpm check
```

実行順序:

```text
1. pnpm typecheck
2. pnpm lint
3. pnpm format:check
4. pnpm test:run
```

typecheck failureでlint/testを実行しない。lintはOxlint/type-aware、formatはBiome format-only、testはVitest single runである。

### 39.2 CI assumption

CI workflow fileは今回作成しないが、CIは次を実行できる前提とする。

```bash
pnpm install --frozen-lockfile
pnpm check
```

`pnpm-lock.yaml`がない、manifestとlockが不一致、tool exact pinが解決できない場合は失敗する。CI provider選定はscope外。

### 39.3 Gate vs quality check

`pnpm check`はpackage development quality gateであり、workflowのRepository Trusted Gate evidence validationとは別のconceptである。

- package CI: `pnpm check`
- target repository workflow: Planningが宣言済みscript/CI/docsをevidenceとして確認し、Planへrequired verificationを記載。ImplementationはそのGateの解決とdriftだけをvalidate
- Workflow Policy: Gate commandやrequired setのsourceではない

この二つを混同して、すべてのworkflowで固定`pnpm check`だけを実行しない。

### 39.4 Format/lint non-overlap

- Biome `linter.enabled:false`。
- `format:check`は`biome format .`。
- Oxlintがlint owner。
- ESLint、Prettierは導入しない。
- `biome check` / `biome ci`を`check`へ入れない。

**Traceability**: `[A:35,39]` `[S:official Oxlint/Biome/Vitest/pnpm docs]` `[D]`

---

## 40. Legacy Reference

### 40.1 Reference path

```text
/Users/minoru/Documents/mywork/change-workflow-legacy/
```

### 40.2 Useful reference

- `/wf-feature`、`/wf-bug`、`/wf-chore`、`/wf-hotfix`のuser-facing UX。
- empty request拒否、active duplicate拒否、start notification。
- explicit plan approvalとfeedback。
- explicit code reviewとfail-closed readiness。
- historical Worker/Reviewer/fix semantics。

### 40.3 Explicitly not reused

```text
workflowPrompt() giant Parent prompt
pi.sendUserMessage(workflowPrompt(...))
Parent LLM orchestration/state ownership
workflow-tui.ts module/file structure
fixed seven-card progress UI
workflow_status as lifecycle authority
status.json polling as sole authority
plan-mode status precheck before code review
legacy SKILL.md as new agent foundation
legacy source code migration
```

Legacyをいつ停止するか、new packageへ切り替えるか、rollback/coexistenceするかはこのSpecificationに含めない。legacy cutoverはNOT APPLICABLE。

**Traceability**: `[A:5,39,42]` `[D]`

---

## 41. Decision Classification

Architecture Open Questionsと今回確定したpolicyを、`RESOLVED`、`IMPLEMENTATION DETAIL`、`DEFERRED`、`NOT APPLICABLE`へ分類する。Production implementation agentは、このsectionでResolvedにした内容を変更せず、Implementation DetailだけをArchitecture invariantを満たす最小形で決める。

### 41.1 RESOLVED

| Item | Resolution |
| --- | --- |
| same-Root concurrency | same Root sessionではactive workflowを1件だけ許可し、second requestをrejectする |
| cross-session / cross-process concurrency | global registryはv1 unsupported。same cwd concurrent workflowはmachine guaranteeなし、運用上禁止する |
| planning policy | ScoutとPlan Compositionはrequired。Researcher、Grilling、Human Decision、Targeted Re-scout、Oracleはevidence-driven conditional |
| Workflow Type差分 | `feature`、`bug`、`chore`、`hotfix`はfirst-class。差分は主にPlanningのScout focus / evidence emphasisとする。hotfixでもapproval/authority/Gate/review boundaryを弱めない |
| nested capability safety ceiling | `maxSubagentDepth = 2`をfixedとし、bounded nested capabilityを許可しながらunbounded nestingを防ぐ |
| policy source | `pi-workflow` package built-inのみ。project/operator overrideはunsupported |
| policy lifecycle | 独立したpolicy migration/version frameworkは作らない。serializationが必要なら既存のcontract/schema versionを使う |
| resultDelivery config | host-wide `intercomBridge.mode = "always"`、`intercomBridge.resultDelivery = true`をoperator / `pi-subagents` host configで設定する。pi-workflowは自動変更しない |
| resultDelivery localization | per-run localizationは`pi-subagents 0.68.0`でunsupported。workflow start前にhost prerequisiteをpreflightし、missing/invalid/確認不能ならstartを拒否する |
| resultDelivery acknowledgement | `pi-intercom`のmatching acknowledgementを必須とし、ack false/timeout/unavailableはfail closed。private transportやoverride workaroundは作らない |
| timeout defaults | `5_000`、`30_000`、`43_200_000`、`14_400_000`、`14_400_000`、`14_400_000`、`1_200_000` msを固定値として使う |
| coordinator timeout semantics | `coordinatorTimeoutMs`は12h wall-clock outer safety cap。Human/Plannotator/Gate待機中にpauseしない |
| timeout failure | timeoutはfail closed。automatic retryなし。test seam以外のproject/operator timeout configurationなし |
| Planning Gate responsibility | Planningがrepository evidenceを確認し、存在確認済みのverificationをPlanへ記述する。Plan approvalはVerification / Trusted Gate expectationsを含むPlan全体のapprovalである |
| Implementation Gate responsibility | Implementation Coordinatorはrequired Gateを再分類しない。開始時にapproved PlanのGate resolutionとrepository driftをvalidateし、消失/変更を安全に解決できなければfail closedする |
| additional Gate | actual changeによりrepositoryの明示的ルールから機械的に必要な場合だけ追加可能。approved required Gates ⊆ final required Gates。「念のため」の追加は禁止 |
| aggregate command | Planで`pnpm check`がrequiredなら、exact `pnpm check`を実行し、componentsへ展開しない |
| optional Gate | semanticsは保持するが、v1通常フローでoptional Gateを積極的に生成しない。optional `SKIPPED`単独はblockしない |
| Fix Wave | max automatic Fix Wavesは1。同じreview waveのaccepted findingsを一つのbounded Fix Workerへまとめる |
| Focused Re-review | Fix Waveなしは実行しない。Fix Waveありはfresh/read-only Focused Re-reviewを必須とし、`STILL_PRESENT`はFAILED |
| plan resubmission | maxPlanResubmissionsは1。initial submissionはcountしない。rejection後はfresh coordinator、新Plan、新immutable Handoff、新hash、新review identityを使う。二度目のrejectionはFAILED |
| approval expiry | approvalは時間経過だけでは失効しない。Plan content/hashが変われば失効する |
| code-review change cycle | maxCodeReviewChangeCyclesは1。initial reviewはcountしない。初回rejection後、same Coordinator・approved scope・新decisionなしの場合だけ一度許可し、二度目のrejection等はFAILED |
| Reviewer boundary | Reviewerはfresh/read-onlyで、Workerを直接制御しない。Finding normalization/dispositionはImplementation Coordinatorが所有する |
| Reviewer composition | exact Reviewer count、scope、specialization、Skill composition、Ponytail適用先はproduct decisionにしない。Runtime evidenceのReviewer + Ponytail compositionはcapability evidenceとしてのみ扱う |
| Finding / disposition semantics | Findingはbounded evidence/reason付きでCoordinatorがnormalizeする。Dispositionは`BLOCKER`、`FIX_NOW`、`DEFERRED`、`REJECTED`で、reasonを必須とする。追加schema detailは固定しない |
| public RPC | version 1 event RPC、async-only spawn、structured reply/run ID capture |
| package/runtime baseline | Pi `0.85.1`、`pi-subagents 0.68.0`、`pi-intercom 0.13.0`、`pi-ask-user-question 1.0.0`、Plannotator `0.27.14` |
| plan mode | workflow dependencyにしない |
| plan identity / Handoff | `implementation-plan.md`をcanonical content、`planning-handoff.json`をimmutable Planning-owned metadataとし、Root-owned Approval Identityを別管理する |
| artifact mechanism | `pi-subagents` managed artifactsとreferencesを使い、独自artifact storeを作らない |
| retry | timeoutを含むautomatic retryなし |
| Root state / reload | Pi custom entryのsmall snapshotのみ。reload後はstale/fail closed、auto recoveryなし |
| authority | Workerはbounded write、Reviewerはfresh/read-only、CoordinatorがFinding/Disposition/Fix/readinessを所有する |

### 41.2 IMPLEMENTATION DETAIL

次はproduct decisionではなく、production implementation時に最小形を選ぶ。

```text
exact TypeScript field names、class names、function signatures
exact core/runtime file split beyond the stated responsibility boundary
exact serialized coordinator envelope fields beyond existing contract/schema version
exact conditional child agent mapping、parallelism、artifact path
exact Reviewer invocation count、review scope分割、specialization、Skill composition
exact Finding fields、severity/location enum、bounds、deduplication detail
exact affected/additional Gate selection algorithm
exact Gate environment、working-directory、process/managed invocation details
exact timeout dependency-injection seam
exact Root registry lock implementation within one Root session
exact artifact retention/cleanup mechanism
exact UI、logging、metrics、tracing representation
```

これらは、Workflow Type policyへGateやReviewerのmatrixを追加せず、Architecture invariantと上記Resolved semanticsを満たすために決める。Repository evidenceの読み方はPlanning responsibilityであり、Implementation-sideのinitial Gate classificationを復活させない。

### 41.3 DEFERRED

| Item | Reason |
| --- | --- |
| durable cross-session / cross-process global registry、lease、worktree isolation | v1はsame Root sessionのprocess-local registryとoperational prohibitionで開始する |
| per-run `resultDelivery` localization | current `pi-subagents 0.68.0`のglobal watcher behaviorを変更できないため |
| project/operator Workflow Policy override | v1 policy sourceをpackage built-inに固定するため |
| independent policy migration/versioning framework | package versionまたは既存contract/schemaで十分なため |
| automatic retry、backoff、re-planning loop | v1はfail closedとbounded explicit transitionだけにするため |
| arbitrary multi-agent topology / dynamic Reviewer registry | bounded capability compositionを優先するため |
| durable reload recovery | current public APIでsafe identity claimを保証できないため |
| artifact retention duration / archival / custom store | cleanup authorityをpi-subagents/operatorに残すため |
| future monitoring UI / metrics / tracing | 初期はartifact/run/state observabilityで足りるため |

### 41.4 NOT APPLICABLE

```text
legacy cutover scheduling
legacy disable timing
legacy runtime switch
rollback to legacy
legacy production coexistence
merge/push/release/deploy automation
Plannotator plan-mode orchestration
ESLint adoption
Prettier adoption
new status polling UI as lifecycle authority
```

Legacy `change-workflow-legacy`はreference-onlyであり、cutover、rollback、coexistence、runtime switch、source migrationはこのSpecificationの対象外である。

### 41.5 Blocking Decision Required: 0件

今回のDecisionを反映した結果、Production implementation開始前に残る既知のblockingなHuman product / operational Decision Requiredは0件である。Implementation Detailはproduction implementation時に決め、Deferredはv1へ持ち込まない。

**Traceability**: `[A:42]` `[S:pi-subagents docs/configuration.md, extension-api.md; Pi/bridge/Plannotator source]` `[E:/Users/minoru/Documents/mywork/pi-subagents-result-delivery-report.md]` `[D]` `[ID]`

---

## 42. Implementation Sequence

各stepは新規実装であり、legacy fileを改修しない。

このsectionの`Primary responsibilities / likely area`欄はresponsibilityの想定配置を示すreferenceであり、exact mandatory internal layoutではない。Production implementationは`/Users/minoru/Documents/mywork/pi-extension-skill-directory-structure.md`に従い、責務境界を守りながら必要最小限のfile/module splitを選択する。StepのGoal、Dependencies、semantic contract、Tests、Exit criteriaがfile/module名より優先される。

各Step完了時に`pnpm check`がPASSし、lint resultが0 warnings / 0 errorsであること。

### Step 1 — Repository/package skeleton + toolchain

- **Goal**: `package.json`、pnpm lock、TS/Biome/Oxlint/Vitestを成立させる。
- **Primary responsibilities / likely area**: package manifest/config、thin `src/index.ts`、README、ignore rules。
- **Dependencies**: Node >=22.19、pnpm 11.22、Pi peer。
- **Tests**: `pnpm typecheck`、`pnpm lint`、`pnpm format:check`、`pnpm test:run`。
- **Exit criteria**: `pnpm check`がnon-interactiveで通り、ESLint/Prettierが存在しない。

### Step 2 — Core domain model

- **Goal**: identity、phase、status、policy、Handoff、hash、Gate、Finding、readinessのpure rules。
- **Primary responsibilities / likely area**: core layerのdomain rulesと、責務に対応するtest。具体的なfile nameは実装時に決める。
- **Dependencies**: Step 1。
- **Tests**: section 38.2全項目。
- **Exit criteria**: coreからPi importsがなく、invalid inputがfail closed。

### Step 3 — Root lifecycle/state machine

- **Goal**: minimal Root state、transition、custom entry persistence、same-Root one-active concurrency。
- **Primary responsibilities / likely area**: coreのstate/lifecycle rules、runtimeのpersistence/registry、eventsのsession lifecycle integration。
- **Dependencies**: Step 2、Pi session API。
- **Tests**: lifecycle/persistence cases、same-session duplicate rejection、cross-session guaranteeを作らないこと。具体的なtest file nameは実装時に決める。
- **Exit criteria**: Root stateにraw contentがなく、same Root sessionのactive workflowが1件に制限される。cross-process lockはない。

### Step 4 — `/wf-*` Commands

- **Goal**: four thin command adapters。
- **Primary responsibilities / likely area**: `src/commands/`の4 thin adaptersと、runtimeのworkflow-start responsibility。
- **Dependencies**: Step 3。
- **Tests**: command responsibilityのbounded tests。具体的なtest file nameは実装時に決める。
- **Exit criteria**: exact mapping、trim/empty/duplicate/cwdが動き、Parent messageがない。

### Step 5 — Public pi-subagents RPC adapter

- **Goal**: ready、request/reply、spawn、run ID、status/stop contract。
- **Primary responsibilities / likely area**: runtimeのpublic `pi-subagents` RPC adapterと、eventsのsubagent lifecycle observation。
- **Dependencies**: Step 3/4、external `pi-subagents@0.68.0`。
- **Tests**: RPC/resultDelivery responsibilityのbounded tests。具体的なtest file nameは実装時に決める。
- **Exit criteria**: public event only、async fresh Coordinator launch payload、timeout cleanup。

### Step 6 — resultDelivery handling

- **Goal**: global `intercomBridge.mode = "always"` / `resultDelivery = true`をhost prerequisiteとしてpreflightする。
- **Primary responsibilities / likely area**: runtimeのresultDelivery prerequisite/observationとREADMEのhost setup。
- **Dependencies**: Step 5、`pi-intercom@0.13.0`、resultDelivery調査report。
- **Tests**: prerequisite missing/invalid refusal、ack success/failure/duplicate/reload。
- **Exit criteria**: pi-workflowがhost configを変更せず、per-run localizationを前提にせず、ack failureはfail closed。

### Step 7 — Planning Coordinator

- **Goal**: package agent、bounded input/output、plan/handoff ownership。
- **Primary responsibilities / likely area**: `agents/`のPlanning Coordinator boundary、runtimeのPlanning completion、Plan Composition responsibility。
- **Dependencies**: Steps 2/5/6、artifact refs。
- **Tests**: planning result schema、missing artifact failure。
- **Exit criteria**: Rootはcompact refsだけ受信し、Planning transcriptをImplementationへ渡さない。

### Step 8 — Planning capabilities

- **Goal**: required Scout/Plan Compositionとevidence-driven conditional capabilities、Workflow TypeごとのScout focusを接続する。
- **Primary responsibilities / likely area**: coreのpackage-built-in Planning policy、必要なGrilling/Plan Composition agent responsibility。
- **Dependencies**: Step 7、current external agents/Skills。
- **Tests**: common requirement、conditional trigger/reason、type-specific focus、nested boundary。
- **Exit criteria**: Workflow TypeにGate/Reviewer matrixを埋め込まず、Full Smoke順序をhard-codeせず、CodeGraph/Ketch/wrapper rulesを満たす。

### Step 9 — Human Decision Bridge

- **Goal**: Coordinator→intercom→Root→pi-ask→TUI→same Coordinator。
- **Primary responsibilities / likely area**: runtimeの`pi-intercom`/Human bridgeと、child-only bridge tools。
- **Dependencies**: Steps 6/8、`pi-intercom@0.13.0`、`pi-ask-user-question@1.0.0`。
- **Tests**: bridge contract、answer/cancel/timeout/duplicate。
- **Exit criteria**: success answerがsame request/correlationで戻り、Root Parent turns 0。

### Step 10 — Plan Artifact / Planning Handoff

- **Goal**: canonical template、managed output、immutable Handoff。
- **Primary responsibilities / likely area**: coreのPlan/Handoff validation、runtimeのmanaged artifact references、docsのPlan template、必要なPlan Composition responsibility。
- **Dependencies**: Steps 2/7。
- **Tests**: template/Handoff strict schema/path/owner rules。
- **Exit criteria**: Handoffにapproval fieldsがなく、Planning completion前にself-validation。

### Step 11 — Plan Review + Approval Identity

- **Goal**: direct Plan review、review-status、hash-bound Root approval。
- **Primary responsibilities / likely area**: runtimeのPlan Review bridgeと、coreのApproval Identity/hash rules。
- **Dependencies**: Steps 9/10、Plannotator external prerequisite。
- **Tests**: pending/reject/one resubmission/second rejection/approve/hash mismatch/no plan mode、approval time expiryなし。
- **Exit criteria**: Root-owned approvalだけがImplementation launchを許可し、content/hash driftで再利用できない。

### Step 12 — Fresh Implementation launch

- **Goal**: pre-launch validationとfresh Implementation Coordinator。
- **Primary responsibilities / likely area**: runtimeのfresh Implementation launchと、`agents/`のImplementation Coordinator boundary。
- **Dependencies**: Step 11、RPC adapter。
- **Tests**: every checklist failure refuses spawn; distinct run ID。
- **Exit criteria**: Plan/Handoff/Approvalの三点以外のPlanning contextを渡さない。

### Step 13 — Worker / TDD

- **Goal**: bounded source implementationとexplicit TDD。
- **Primary responsibilities / likely area**: Implementation Coordinatorのagent configuration/promptとWorker/TDD launch responsibility。
- **Dependencies**: Step 12、current `worker`/`tdd`。
- **Tests**: fake Worker handoff、valid RED/GREEN、scope check。
- **Exit criteria**: Workerだけがsource write、merge/push authorityなし。

### Step 14 — Trusted Gates

- **Goal**: Planningのevidence-backed verification、Implementation開始時のGate/drift validation、managed gate execution、status/evidence。
- **Primary responsibilities / likely area**: coreのTrusted Gate model、runtimeのmanaged Gate execution、必要なread-only Gate validation responsibility。
- **Dependencies**: Step 13、public acceptance gate。
- **Tests**: evidence-backed command/no-guess、required/optional semantics、Gate drift fail closed、aggregate command no expansion、timeout/unknown。
- **Exit criteria**: approved required Gateをdowngradeせず、actual changeによる機械的追加以外のGateを発明せず、required FAIL/UNKNOWNがreadinessをblock。

### Step 15 — Reviewer / Finding / Disposition

- **Goal**: fresh read-only Reviewer、minimal Finding、Coordinator disposition。Reviewer count/scope/Skill topologyは固定しない。
- **Primary responsibilities / likely area**: coreのFinding/Disposition rulesと、Reviewer/Coordinatorのagent prompts。
- **Dependencies**: Steps 13/14、available reviewer mechanism。
- **Tests**: raw artifact isolation、normalization、all dispositions、Reviewer boundary。
- **Exit criteria**: Reviewer→Worker direct pathなし、Root Parent synthesisなし、Reviewer + Ponytailはmandatoryにしない。

### Step 16 — Fix Wave / Re-gates / Focused Re-review

- **Goal**: accepted findingsを一つのbounded Fix Workerへ統合し、最大1回のFix Wave後に必ずfresh Focused Re-reviewを行う。
- **Primary responsibilities / likely area**: runtimeのaffected Gate/Re-review coordination、Coordinator prompt、coreのFinding semantics。
- **Dependencies**: Steps 14/15、TDD if required。
- **Tests**: one wave maximum、accepted-only prompt、affected selection、fresh re-review、RESOLVED/STILL_PRESENT。
- **Exit criteria**: raw Reviewer proseがFix promptになく、Fix Wave #2を自動起動しない。

### Step 17 — Final Diff Inspection

- **Goal**: Coordinator-owned read-only final checklist。
- **Primary responsibilities / likely area**: runtimeのread-only Final Diff Inspection responsibilityとCoordinator prompt。
- **Dependencies**: Step 16。
- **Tests**: unexpected files/scope/non-goal/working tree evidence。
- **Exit criteria**: Coordinator direct source editなし、inspection artifact exists。

### Step 18 — Plannotator Code Review

- **Goal**: direct code-review、same Coordinator continuation、最大1回のbounded change cycle。
- **Primary responsibilities / likely area**: runtimeのdirect Plannotator Code Review bridgeとchild bridge responsibility。
- **Dependencies**: Step 17、Plannotator/pi-intercom。
- **Tests**: direct action/no plan mode/rejection/approval/correlation、one cycle maximum、second rejection failure。
- **Exit criteria**: code review resultがsame Implementation Coordinatorへ戻り、scope外または新decision要求でblockする。

### Step 19 — Ready-for-Merge evaluator

- **Goal**: pure fail-closed readiness result。
- **Primary responsibilities / likely area**: coreのpure Ready-for-Merge evaluatorとImplementation Coordinatorのfinal path。
- **Dependencies**: Steps 14/16/17/18。
- **Tests**: every required condition and optional skip case。
- **Exit criteria**: structured checks/blockersと`ready`が一致。

### Step 20 — Cancellation / failure / idempotency

- **Goal**: all terminal outcomes、fixed timeout fail-closed、stop ordering、duplicate/late behavior。
- **Primary responsibilities / likely area**: runtimeのcancellation/failure handlingとidempotency responsibilityのtest。
- **Dependencies**: all runtime bridges。
- **Tests**: failure table、fixed timeout values、wall-clock Coordinator cap/no pause、reload、duplicate/conflict、late response。
- **Exit criteria**: automatic retry/fallbackなし、terminal guardが全pathで機能。

### Step 21 — Integration verification

- **Goal**: production source seamsのbounded public-contract integration。
- **Primary responsibilities / likely area**: public-contract integration responsibilityのtestとREADME/setup。
- **Dependencies**: all prior steps。
- **Tests**: `pnpm check` + bounded integration test。
- **Exit criteria**: Acceptance Criteria全項目、traceability、no production implementation outside new repository。

**Traceability**: `[A:43]` `[D]`

---

## 43. Acceptance Criteria

production implementation完了時、次を満たす。

```text
[ ] /wf-feature, /wf-bug, /wf-chore, /wf-hotfixがRoot Parent LLM orchestrationなしで開始できる
[ ] command inputがtrimされ、emptyが拒否される
[ ] WorkflowTypeが正しくmappingされる
[ ] same Root sessionではactive workflowを1件だけ許可し、second requestをrejectする
[ ] cross-session/process global registryやcross-process lockを前提にしない
[ ] same cwd concurrent workflow across separate sessionsは運用上禁止し、machine guaranteeとは主張しない
[ ] Planning Coordinatorがpublic RPCでasync launchされる
[ ] `async:true` / `context:"fresh"` / run ID captureがstructuredに検証される
[ ] PlanningはScout/Plan Composition required、その他はevidence-driven conditionalである
[ ] feature/bug/chore/hotfixのScout focusが指定どおりである
[ ] Workflow Type policyにGate/Reviewerのmatrixを埋め込まない
[ ] Full Smoke sequenceをmandatory universal pipelineとしてhard-codeしない
[ ] Planning Coordinatorがstage selection ownerである
[ ] raw Planning outputがRoot Parent contextへ入らない
[ ] Scoutがfresh/read-only/CodeGraph-awareで、CodeGraph未初期化を勝手に直さない
[ ] Researcherはexternal factが必要な場合だけcurrent `pi-ketch.researcher`/Ketchで起動する
[ ] Ketch unavailableでBrave workaround/fallbackをしない
[ ] Grilling/Human/Re-scout/Oracleがgeneral triggerに基づくconditional capabilityである
[ ] GrillingがSkillを使う場合はexplicitに指定され、wrapperの自動resolutionに依存しない
[ ] nested authorityがboundedである
[ ] Human DecisionがCoordinator→pi-intercom→Root→pi-ask→User→Root→same Coordinatorで戻る
[ ] Human cancel/timeout/unavailableがdefault answerにならない
[ ] policy sourceがpackage built-inで、project/operator overrideがない
[ ] independent policy lifecycle/version frameworkがない
[ ] plan reviewがdirect `plannotator:request` action `plan-review`である
[ ] plan mode dependencyがない
[ ] `planning-handoff.json`がimmutableで、approval metadataを含まない
[ ] Plan Artifactがcanonical `implementation-plan.md`である
[ ] hash identityが同じcanonical bytesへ適用される
[ ] plan hash mismatchでImplementation launchが拒否される
[ ] Approval IdentityがRoot-ownedで、RootがHandoffへ書き戻さない
[ ] fresh Implementation CoordinatorがPlan Artifact+Handoff+Approval Identityだけで起動する
[ ] Planning transcript/contextをImplementationが継承しない
[ ] Workerがbounded write authorityを持ち、merge/push/release/deploy authorityがない
[ ] TDD required時にexplicit `tdd` Skillがある
[ ] Planningがrepository evidenceで存在確認したcommandだけをPlanへ記載する
[ ] Plan approvalがVerification / Trusted Gate expectationsを含む
[ ] Implementationがrequired Gateを再分類せず、Gate/repository driftをfail closedにする
[ ] approved required Gates ⊆ final required Gatesである
[ ] Planでrequiredなaggregate command（例: `pnpm check`）をcomponentsへ展開しない
[ ] additional Gateが明示的repository ruleから機械的に必要な場合以外に発明されない
[ ] required Gate FAIL/UNKNOWN/SKIPPEDでreadinessがblockされる
[ ] optional Gate SKIPPEDだけではblockされず、v1通常フローで積極生成されない
[ ] Reviewerがfresh/read-onlyで、Workerを直接制御しない
[ ] Reviewer count/scope/specialization/Skill/Ponytail適用がmandatory product topologyになっていない
[ ] Finding normalization/dispositionがImplementation Coordinator-ownedである
[ ] Findingがminimal bounded evidence/reasonを持つ
[ ] BLOCKER/FIX_NOWだけがaccepted Fix Waveへ入る
[ ] Fix Waveが同一review waveのaccepted findingsを一つのbounded Fix Workerへまとめる
[ ] automatic Fix Waveの上限が1である
[ ] Fix WaveなしではFocused Re-reviewを実行しない
[ ] Fix Waveありではfresh read-only Focused Re-reviewを必ず実行する
[ ] Focused Re-reviewがaccepted Finding IDs、Fix Worker diff、必要なPlan contextだけを対象にする
[ ] Focused Re-review resultがRESOLVED/STILL_PRESENTで、STILL_PRESENTはFAILEDになる
[ ] raw Reviewer proseがFix Workerへ渡らない
[ ] affected Gateのexact algorithmをproduct policyとして固定せず、required Gateを必ず維持する
[ ] Final Diff Inspectionがsourceを直接修正せずpassする
[ ] code reviewがdirect `action: "code-review"`である
[ ] code review前のplan-mode status precheckがない
[ ] same Implementation Coordinatorがcode review後も継続する
[ ] Plan resubmissionは一度だけで、initial submissionをcountしない
[ ] resubmissionがfresh coordinator/new Plan/new immutable Handoff/new hash/new review identityを使う
[ ] approvalは時間経過では失効せず、content/hash変更で無効になる
[ ] code-review change cycleは一度だけで、initial reviewをcountしない
[ ] change cycle後にrequired verification、Finding処理、必要なFocused Re-review、Final Diff、code reviewが再成立する
[ ] second Plan rejection / second code-review rejection / scope escape / new decision要求がFAILEDになる
[ ] Ready-for-Mergeがpure structured evaluatorである
[ ] approved plan identity、implementation complete、required gates、findings、Focused Re-review条件、final inspection、code approvalを確認する
[ ] Root host configが`intercomBridge.mode = "always"`かつ`resultDelivery = true`である
[ ] resultDelivery preflightがworkflow start前に行われ、missing/invalid/確認不能でstartを拒否する
[ ] per-run resultDelivery localizationを前提にしない
[ ] resultDelivery acknowledgementが必須で、ack false/timeout/unavailableがsuccessにならない
[ ] Root Parent LLM internal orchestrationが不要である
[ ] raw child reports/full logsがRoot Parent contextへ入らない
[ ] fixed timeout defaults、wall-clock Coordinator cap、no pause、fail-closedが実装される
[ ] timeoutを含めautomatic retryがない
[ ] cancellationがstate→stop→bridge cancel→artifact/final resultのorderingを守る
[ ] RPC/child/coordinator/bridge/gate/review failureが扱われる
[ ] reload/stale/late eventがauto recoveryやphase advanceを起こさない
[ ] Correlation/idempotencyがworkflowId/runId/requestId/reviewId/FindingIdで追跡できる
[ ] `pnpm check`がtypecheck + oxlint/tsgolint + Biome format check + Vitest runを含む
[ ] ESLintを導入していない
[ ] Prettierを導入していない
[ ] legacy source migration/cutover/coexistenceを実装していない
[ ] new package/repository前提である
```

### 43.1 Specification self-review

```text
[✓] Canonical Architectureを変更していない
[✓] legacyをreference-onlyとして扱った
[✓] legacy cutoverを設計していない
[✓] pnpmを固定した
[✓] oxlint + oxlint-tsgolintをlint ownerにした
[✓] Biomeをformatter-onlyにした
[✓] Vitestを固定した
[✓] Root Parent LLM orchestrationを復活させていない
[✓] Planning/Implementation Coordinatorを分離した
[✓] Scout/Plan Composition required、その他conditionalの共通Planning policyにした
[✓] Workflow Type差分をScout focus/evidence emphasisに限定した
[✓] package-built-in policy、overrideなし、独立policy lifecycleなしを反映した
[✓] Plan Artifact/Handoff/Approval ownershipを分離した
[✓] Handoff immutable、approval metadata excludedを定義した
[✓] PlanningがGate evidenceを記録し、Implementationがdriftをvalidateする責務分離を反映した
[✓] aggregate Gateを勝手に展開しないことを反映した
[✓] Reviewer topologyを固定せず、fresh/read-only/Coordinator dispositionだけを維持した
[✓] Fix Wave最大1回、Fix Wave後のfresh Focused Re-review必須を反映した
[✓] Plan resubmission最大1回、code-review change cycle最大1回を反映した
[✓] fixed timeout、wall-clock cap、no pause、fail-closedを反映した
[✓] global resultDelivery prerequisite、per-run unsupported、ack requiredを反映した
[✓] public API/source boundaryを記載した
[✓] RESOLVED/IMPLEMENTATION DETAIL/DEFERRED/NOT APPLICABLEへ分類した
[✓] known blocking Decision Requiredを0件とした
[✓] implementation sequence、acceptance、traceabilityを含めた
[✓] production codeを作成していない
```

**Traceability**: `[A:44]` `[D]`

---

## 44. Traceability Matrix

| Specification area | Architecture section | Public source/API | Runtime evidence |
| --- | --- | --- | --- |
| Purpose/boundary | `[A:1,3,5]` | Pi package model | `pi-workflow-architecture.md` |
| Baseline | `[A:2,6]` | installed package metadata | `phase-a-smoke-results.md`, `v068-worker-reviewer-capability-results.md` |
| Root Control Plane | `[A:7,11,22,37]` | Pi Extensions API、public RPC | `full-workflow-composition-results.md` |
| Commands | `[A:12]` | `pi.registerCommand` | legacy UX evidence in Architecture; command contract is `[D]` |
| Package layout | `[A:35,36]` | Pi packages/extensions/skills docs | directory structure basis |
| Package dependencies | `[A:35,42]` | Pi `peerDependencies` convention、package metadata | `human-bridge-tui-results.md`, `plannotator-direct-api-results.md` |
| WorkflowType/policy | `[A:9,14,38]` | package-built-in common Planning requirements and type focus | `full-workflow-composition-results.md`; exact child selection is `[ID]` |
| Lifecycle state | `[A:32]` | Pi custom entries/session format | `phase-handoff-capability-results.md` |
| State transitions | `[A:32,33]` | public stop/shutdown | `implementation-composition-results.md` |
| RPC adapter | `[A:11,13]` | `subagents:rpc:v1:*`, `spawn` | `phase-a-smoke-results.md`, `b0-investigation-results.md` |
| resultDelivery | `[A:11,37,42]` | global `intercomBridge.mode/resultDelivery`, result intercom events | `/Users/minoru/Documents/mywork/pi-subagents-result-delivery-report.md`, `b0-investigation-results.md`, `human-bridge-tui-results.md` |
| Scout | `[A:15]` | `scout`, `codegraph` Skill | `phase-a-smoke-results.md` |
| Researcher | `[A:16]` | `pi-ketch.researcher`, Ketch tools | `pr-2143-ketch-verification.md`, `v068-worker-reviewer-capability-results.md` |
| Grilling/nested authority | `[A:17]` | explicit Skills、nested `subagent`/supervisor | `grilling-nested-capability-results.md` |
| Human Bridge | `[A:17]` | `pi-intercom` Extension Channel、`pi-ask-user-question` events | `human-bridge-tui-results.md` |
| Plan Artifact | `[A:19]` | `outputMode:file-only` | `phase-handoff-capability-results.md` |
| Handoff | `[A:20,21]` | managed artifact refs | `phase-handoff-capability-results.md` |
| Plan hash | `[A:19,20,21]` | Node SHA-256 stdlib | `phase-handoff-capability-results.md` |
| Plan review | `[A:20]` | Plannotator `plan-review`, `review-status` | `plannotator-direct-api-results.md` |
| Approval Identity | `[A:20,21,30]` | Plannotator structured result | `phase-handoff-capability-results.md` |
| Implementation launch | `[A:21,22]` | fresh public RPC spawn | `phase-handoff-capability-results.md`, `full-workflow-composition-results.md` |
| Worker/TDD | `[A:23]` | `worker` + explicit `tdd` Skill | `v068-worker-reviewer-capability-results.md` |
| Trusted Gates | `[A:24,30]` | `acceptance.verify`/`gate` public contract | `implementation-composition-results.md`, `full-workflow-composition-results.md` |
| Reviewer | `[A:25,34]` | fresh `reviewer`, read-only contract | `v068-worker-reviewer-capability-results.md` |
| Finding/Disposition | `[A:26]` | Coordinator artifact/result boundary | `implementation-composition-results.md`, `full-workflow-composition-results.md` |
| Fix Wave | `[A:27]` | `runs.run` bounded child | `implementation-composition-results.md` |
| Re-gates/re-review | `[A:27]` | affected gate/fresh Reviewer composition | `implementation-composition-results.md`, `full-workflow-composition-results.md` |
| Final Diff Inspection | `[A:28]` | read-only Pi/managed command boundary | `implementation-composition-results.md` |
| Code Review | `[A:29]` | Plannotator `code-review` | `plannotator-direct-api-results.md` |
| Ready-for-Merge | `[A:30]` | pure core rule `[D]` | `implementation-composition-results.md`, `full-workflow-composition-results.md` |
| Cancellation/failure | `[A:33]` | public stop/abort/shutdown/status | source-confirmed; failure injection not newly run |
| Artifact/context boundary | `[A:31,37]` | `file-only`, refs/artifacts | `phase-a-smoke-results.md`, `full-workflow-composition-results.md` |
| Persistence/reload | `[A:37,42]` | Pi session custom entries、shutdown/reload | source-confirmed; auto recovery deferred |
| Correlation/idempotency | `[A:37]` | public request IDs/events | bridge source + reports; exact Root implementation `[D]` |
| Skills | `[A:36]` | Pi Skills progressive loading | `grilling-nested-capability-results.md`, `v068-worker-reviewer-capability-results.md` |
| Testing/toolchain | `[A:35,43]` | official CLI docs | current package metadata/docs inspection |
| Legacy Reference | `[A:5,39]` | legacy source only as UX evidence | Architecture legacy inspection |
| Decision classification | `[A:42]` | current source/docs limits | Section 41 `[D]/[ID]` |
| Implementation sequence | `[A:43]` | public API contracts | capability composition reports |
| Acceptance | `[A:44]` | all above | this self-review |

### 44.1 Source index

```text
Pi:
  /Users/minoru/.local/share/mise/installs/pi/0.85.1/docs/extensions.md
  /Users/minoru/.local/share/mise/installs/pi/0.85.1/docs/rpc.md
  /Users/minoru/.local/share/mise/installs/pi/0.85.1/docs/packages.md
  /Users/minoru/.local/share/mise/installs/pi/0.85.1/docs/skills.md
  /Users/minoru/.local/share/mise/installs/pi/0.85.1/docs/session-format.md

pi-subagents:
  /Users/minoru/.pi/agent/npm/node_modules/pi-subagents/package.json
  /Users/minoru/.pi/agent/npm/node_modules/pi-subagents/docs/extension-api.md
  /Users/minoru/.pi/agent/npm/node_modules/pi-subagents/docs/workflows.md
  /Users/minoru/.pi/agent/npm/node_modules/pi-subagents/docs/tool-reference.md
  /Users/minoru/.pi/agent/npm/node_modules/pi-subagents/docs/observability.md
  /Users/minoru/.pi/agent/npm/node_modules/pi-subagents/docs/configuration.md
  /Users/minoru/.pi/agent/npm/node_modules/pi-subagents/docs/agents.md
  /Users/minoru/.pi/agent/npm/node_modules/pi-subagents/src/extension/rpc.ts
  /Users/minoru/.pi/agent/npm/node_modules/pi-subagents/src/intercom/result-intercom.ts
  /Users/minoru/.pi/agent/npm/node_modules/pi-subagents/src/intercom/intercom-bridge.ts
  /Users/minoru/.pi/agent/npm/node_modules/pi-subagents/src/runs/background/result-watcher.ts

resultDelivery investigation:
  /Users/minoru/Documents/mywork/pi-subagents-result-delivery-report.md

pi-ask-user-question:
  /Users/minoru/.pi/agent/git/github.com/minorunakamura/pi-ask-user-question/package.json
  /Users/minoru/.pi/agent/git/github.com/minorunakamura/pi-ask-user-question/src/api.ts
  /Users/minoru/.pi/agent/git/github.com/minorunakamura/pi-ask-user-question/src/runtime/event-adapter.ts
  /Users/minoru/.pi/agent/git/github.com/minorunakamura/pi-ask-user-question/README.md

Plannotator:
  /Users/minoru/.pi/agent/npm/node_modules/@plannotator/pi-extension/package.json
  /Users/minoru/.pi/agent/npm/node_modules/@plannotator/pi-extension/plannotator-events.ts
  /Users/minoru/.pi/agent/npm/node_modules/@plannotator/pi-extension/README.md

pi-intercom runtime source inspected:
  /Users/minoru/Documents/mywork/pi-subagents-smoke/.smoke-runs/2026-09-14T19-29-04-905Z-116f53d4/human-bridge/runtime-agent/git/github.com/nicobailon/pi-intercom/package.json
  /Users/minoru/Documents/mywork/pi-subagents-smoke/.smoke-runs/2026-09-14T19-29-04-905Z-116f53d4/human-bridge/runtime-agent/git/github.com/nicobailon/pi-intercom/index.ts
  /Users/minoru/Documents/mywork/pi-subagents-smoke/.smoke-runs/2026-09-14T19-29-04-905Z-116f53d4/human-bridge/runtime-agent/git/github.com/nicobailon/pi-intercom/extension-api.ts
  /Users/minoru/Documents/mywork/pi-subagents-smoke/.smoke-runs/2026-09-14T19-29-04-905Z-116f53d4/human-bridge/runtime-agent/git/github.com/nicobailon/pi-intercom/types.ts

pi-ketch:
  /Users/minoru/.pi/agent/git/github.com/minorunakamura/pi-ketch/package.json
  /Users/minoru/.pi/agent/git/github.com/minorunakamura/pi-ketch/agents/researcher.md

Toolchain official docs:
  https://oxc.rs/docs/guide/usage/linter/config-file-reference.html
  https://oxc.rs/docs/guide/usage/linter/type-aware
  https://biomejs.dev/guides/getting-started/
  https://biomejs.dev/reference/cli/
  https://vitest.dev/guide/cli
  https://www.typescriptlang.org/docs/handbook/compiler-options.html
  https://pnpm.io/cli/install
```

**Traceability**: `[A:40,41]` `[D]`

---

## 45. Final Implementation Contract Summary

Implementation agentは次をMUSTとして実装する。

```text
new repository/package: pi-workflow
Root Extension = control plane
four /wf-* commands
WorkflowType first-class
public pi-subagents RPC only
separate fresh Planning/Implementation Coordinators
conditional bounded Planning: Scout/Plan Composition required, others evidence-driven conditional
`maxSubagentDepth = 2` fixed safety ceiling; no unbounded nesting/arbitrary topology
Workflow Type差分はScout focus/evidence emphasis
package-built-in policy only; project/operator overrideなし
explicit upstream Skills only
Root-owned pi-intercom/pi-ask/Plannotator bridges
implementation-plan.md canonical
immutable planning-handoff.json
Root-owned Approval Identity
SHA-256 plan identity binding
bounded Worker write authority
fresh read-only Reviewer
Coordinator-owned Finding/Disposition/Fix/Re-review/readiness
managed Trusted Gates: Planning evidence-backed, Implementation validates drift without downgrade
one automatic Fix Wave maximum; every Fix Wave gets fresh Focused Re-review
one Plan resubmission maximum; one code-review change cycle maximum
fail-closed Ready-for-Merge
small Root state only
managed artifacts, refs not raw context
fixed timeouts; Coordinator is a 12h wall-clock cap with no pause
no automatic retry
host-wide resultDelivery prerequisite and required acknowledgement; no per-run localization assumption
reload stale/fail-closed
pnpm check quality gate
```

Implementation agentは次をMUST NOTとして扱う。

```text
Root Parent LLMへworkflow promptを送る
Root Parent LLMへraw reportを送る
Planning contextをImplementationへresume/forkする
planning-handoff.jsonへapproval metadataを書く
ReviewerからWorkerへdirect commandを送る
optional SKIPPEDだけでreadinessをblockする
plan modeをworkflow dependencyにする
private Pi/pi-subagents/Plannotator moduleをimportする
Brave workaroundをResearcherへ追加する
cross-process lock/lease/global registryを新設する
policy migration framework、project/operator policy configを新設する
Reviewer plugin registry、dynamic lane router、custom artifact/gate/resultDelivery transportを新設する
automatic retry frameworkを新設する
legacy sourceをcopy/migrateする
legacy cutoverを設計する
merge/push/release/deployを自動化する
unresolved product policyを推測する
```

Production implementation開始条件:

```text
このSpecificationを実装contractとして採用する
AND Section 41のResolved policyを変更しない
AND Implementation Detailだけを最小形で確定する
AND new pi-workflow repositoryを作成する
```

本作業の停止条件:

```text
implementation specification complete
architecture traceability complete
package/toolchain specification complete
open questions classified
implementation sequence complete
acceptance criteria complete
production implementation: NOT STARTED
```
