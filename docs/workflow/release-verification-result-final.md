# Phase 1 Release Candidate 再検証結果

## 判定

**Phase 1 Release: NOT ELIGIBLE**

`INSUFFICIENT EVIDENCE` が1件あるため、Phase 1 Releaseは宣言しない。

## Release Candidate固定

- Current HEAD: `dd297d0b9cee0a81d283f5c061f44e67634a80e2`
- Branch: `main`
- `pnpm check`実行後に固定。tracked working treeはclean。
- Evidence: `release-evidence/phase-1-rc-dd297d0b9cee/release-candidate-verification.json`

## Evidence Ledger（すべてRC HEAD対応）

| Area | Result | Evidence |
|---|---|---|
| Static prerequisites | PASS | `01-static-prerequisites.log` — 10 files / 36 tests |
| Gate A | PASS | `02-gate-a.log` — 7 files / 36 tests |
| Core Skills | PASS | 9 Skill実装・allowlist・packed discoveryをcurrent testで確認 |
| Gate B | INSUFFICIENT EVIDENCE | `03-gate-b.log` — 12 files / 55 tests。Repository/Securityのproduction E2Eが不足 |
| Gate C | PASS | `04-gate-c.log` — 11 files / 35 tests |
| Packed Package Installation / Loading | PASS | `05-packed-package-installation-loading.log`、CI matrix artifact |
| Packed Production Runtime Operation | PASS | `06-packed-production-runtime.log` — 実Pi bridgeでWorker → Verifier → Reviewer → Outcome |
| Persistence / Recovery | PASS | `07-persistence-recovery.log` — 12 files / 61 tests |
| Repository / Security | INSUFFICIENT EVIDENCE | `08-repository-security.log` — 12 files / 65 tests。ただし必須production security E2Eなし |
| Cross-platform | PASS | GitHub Actions `33708236691`、head SHA一致。macOS/Linux/Windows各8 files / 39 tests |
| Gate D | PASS | `09-gate-d.log` — 6 files / 16 tests。generated evaluation projection/rebuild/API |
| Context Independence | PASS | `10-context-independence.log` — 4 files / 11 tests |
| Legacy Cutover | NOT ELIGIBLE | `legacy-cutover.test.log` — 4 files / 10 tests。前提Evidence不足 |
| Full Check | PASS | `11-full-check.log` — 76 files / 300 tests |

## Cross-platform hardening

RC HEAD `dd297d0b9cee0a81d283f5c061f44e67634a80e2` に対する GitHub Actions run `33708236691` が成功した。

- `macos-latest`: 8 files / 39 tests PASS
- `ubuntu-latest`: 8 files / 39 tests PASS
- `windows-latest`: 8 files / 39 tests PASS

Evidence artifactは `release-evidence/phase-1-rc-dd297d0b9cee/cross-platform-ci/` に保存した。

## Legacy Cutover certification

- `LEGACY_PATH_ABSENT`: PASS
- `NEW_RUNTIME_OPERATIONAL`: PASS
- `NO_LEGACY_FALLBACK`: PASS
- `CUTOVER_ELIGIBLE`: **NOT ELIGIBLE**（Repository/Security Evidence不足）

## Release blocker

- **Classification:** `INSUFFICIENT EVIDENCE`
- **Story:** STORY-13-08
- **影響範囲:** Gate B、Repository/Security、`CUTOVER_ELIGIBLE`、Phase 1 Release
- **原因:** current HEADには、通常のinstalled/default production compositionを通じて、dirty/pre-existing、out-of-scope mutation、drift、read-only/verify-onlyの禁止mutation、Tool-capability denialを一つのrelease-level security E2Eで証明するEvidenceがない。`PiSubagentsAdapter`のTool denialテストはcomponent-levelであり、production compositionの代替にはならない。`workflow-extension-production.test.ts`のdelegation応答もテスト境界で合成されている。
- **必要な修正:** synthetic delegation shortcutやmanual use-case injectionを使わず、実installed/default Pi bridgeを通るproduction-composition E2Eを追加・PASSさせる。dirty/pre-existing、out-of-scope、drift、禁止Agent mutation、Tool capability denial（必要ならsame-file attribution uncertaintyも含む）を検証し、EvidenceをRC HEADに紐付ける。

`11-implementation-backlog.md` の未完了 `[ ]` は今回も完了扱いに変更していない。

## Residual Risk

- `pnpm check`はPASSだが、既存のnon-fatal type assertion warningがある。
- 外部live LLM/provider実行は今回の必須Evidence範囲外。

コミットおよびpushは行っていない。
