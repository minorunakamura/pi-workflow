# pi-workflow

Pi packageとして配布する、Root-owned workflowの実装です。

現在はImplementation Specification Section 42のStep 6（resultDelivery handling）までを実装しています。CoordinatorとSkillは後続Stepの対象です。

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

`pi-subagents`のhost config（`~/.pi/agent/extensions/subagent/config.json`）には、次を設定します。pi-workflowはworkflow開始前にこの設定をpreflightしますが、configを変更しません。`resultDelivery`はglobal host settingであり、Coordinatorごとのper-run設定ではありません。

```json
{
  "intercomBridge": {
    "mode": "always",
    "resultDelivery": true
  }
}
```

ESLintとPrettierは導入しません。
