# pi-workflow

Pi packageとして配布する、Root-owned workflowの実装です。

現在はImplementation Specification Section 42のStep 21（Integration verification）までを実装しています。fresh read-only Reviewer、Coordinator-ownedのFinding normalization、最大1回のbounded Fix Wave、affected Gate再実行、fresh Focused Re-review、Coordinator-ownedのread-only Final Diff Inspection、Root-ownedのdirect Plannotator Code Review bridge、pure fail-closed Ready-for-Merge evaluatorに加え、固定timeoutのfail-closed処理、`session_shutdown` reason `quit`から呼ばれるRoot runtimeの`requestWorkflowCancellation(workflowId)`、reload時のstale failure、coordinator停止、duplicate/conflict/late eventのterminal guardを提供します。Human DecisionはRoot TUIで、Plan ReviewとCode ReviewはRoot-ownedのPlannotator bridgeで利用します。

## 開発

```bash
pnpm install --frozen-lockfile
pnpm check
```

`pnpm check`は`tsc`、Oxlint + `oxlint-tsgolint`、Biome formatter、Vitestを順に実行します。依存関係の操作にはpnpmを使用します。

## Pi host prerequisites

Extension runtimeで使用するhost packageは、pi-workflowのdependencyとしてbundleしません。host側で次をinstallしてください。

```bash
pi install npm:pi-subagents@0.68.0
pi install npm:pi-intercom@0.13.0
pi install npm:pi-ask-user-question@1.0.0
pi install npm:@plannotator/pi-extension@0.27.14
# Researcherを使うhostだけ
pi install npm:pi-ketch@1.0.0
```

`pi-subagents`のhost config（`~/.pi/agent/extensions/subagent/config.json`）には、次を設定します。pi-workflowはruntime初期化時にこの設定をpreflightし、configを変更しません。`resultDelivery`はglobal host settingであり、Coordinatorごとのper-run設定ではありません。config変更後は`/reload`またはPi restartが必要です。

```json
{
  "intercomBridge": {
    "mode": "always",
    "resultDelivery": true
  }
}
```

Step 21のbounded public-contract integration testは、外部Coordinatorやbrowserを起動せず、Pi RPC、async completion/resultDelivery、Plannotator、session shutdownのpublic event contractをfake event busで検証します。

```bash
pnpm test:run -- tests/integration/public-contract.test.ts
```

ESLintとPrettierは導入しません。
