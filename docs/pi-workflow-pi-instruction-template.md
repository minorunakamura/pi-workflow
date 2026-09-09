# pi-workflow — Pi 実装指示テンプレート

このテンプレートは、各Stepを**新しいPi sessionで開始するための短い起動指示**である。

実装内容、Goal、Acceptance Criteria、Tool / Skill利用方針は
`docs/pi-workflow-implementation-steps.md` に集約する。
このテンプレートへ重複記載しない。

## 使用方法

`<STEP>` と `<STEP NAME>` を置き換えて、新しいPi sessionへそのまま入力する。

```text
新規プロジェクト `pi-workflow` の Step <STEP> — <STEP NAME> を実装してください。

最初に以下を読んでください。

- docs/pi-workflow-basic-design.md
- docs/pi-workflow-implementation-spec.md
- docs/pi-workflow-implementation-steps.md

役割:
- 基本設計書: architecture / ownership / design principles
- 実装仕様書: implementation contracts / package structure / runtime behavior
- 実装ステップ計画: 今回のStepのScope / Goal / Acceptance Criteria / Tool・Skill利用方針

`pi-workflow-implementation-steps.md` の Step <STEP> に従って実装してください。

Rules:
- 前StepのPrerequisiteを最初に確認してください。未達なら実装を開始せず報告してください。
- 現在のStepのScopeだけを実装し、後続Stepを先取りしないでください。
- 設計書・実装仕様書から機械的に決められる内容は自分で判断してください。
- 文書間に矛盾がある場合や設計変更が必要な場合は、推測で実装せず判断を仰いでください。
- 外部contractが不明確な場合は一次情報を確認してください。
- commit / push / PR作成は行わないでください。

完了前に、StepのAcceptance Criteria、tests、git diff、architecture/contract、correctness review、Ponytail reviewを確認してください。

完了報告は `pi-workflow-implementation-steps.md` の Completion Report Format に従ってください。
```

## Step指定

```text
Step 1 — Foundation
Step 2 — Planning Flow
Step 3 — Single End-to-End
Step 4 — Parallel Lanes
Step 5 — Recovery / Hardening / Release
```

同じStep内の軽微な修正は、新しいsessionを作らず継続してよい。
