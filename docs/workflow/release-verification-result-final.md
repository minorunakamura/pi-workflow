# Phase 1 Release Candidate 最終検証結果

## 判定

**Phase 1 Release: ELIGIBLE — 宣言可能**

今回のRC HEADに対する必須Evidenceで、FAILおよびINSUFFICIENT EVIDENCEは残っていない。

## Release Candidate固定

- Current HEAD: `9197c6f451f4f6b7069cac93d1244855fbfd25e7`
- Branch: `main`
- RC HEAD変更なし
- 初回および最終 `pnpm check`: PASS — 77 test files / 301 tests
- Evidence: `release-evidence/phase-1-rc-9197c6f451f4/`
- Commit / push: 実施していない

## Evidence Ledger

| Area | Result | Evidence |
|---|---|---|
| Static prerequisites | PASS | `release-verification/01-static-prerequisites.log` — 10 files / 36 tests |
| Gate A | PASS | `release-verification/02-gate-a.log` — 7 files / 36 tests |
| Core Skills | PASS | Static、packed discovery、production Skill path Evidence |
| Gate B | PASS | `release-verification/03-gate-b.log` — 13 files / 56 tests |
| Gate C | PASS | `release-verification/04-gate-c.log` — 11 files / 35 tests |
| Packed Package Installation / Loading | PASS | `release-verification/05-packed-package-installation-loading.log` |
| Packed Production Runtime Operation | PASS | `release-verification/06-packed-production-runtime.log` — 実Pi bridgeでWorker → Verifier → Reviewer → Outcome |
| Persistence / Recovery | PASS | `release-verification/07-persistence-recovery.log` — 12 files / 61 tests |
| Repository / Security | PASS | `release-verification/08-repository-security.log` — 13 files / 66 tests |
| Cross-platform | PASS | `cross-platform-ci/revalidation-summary.json`、GitHub Actions run `33716075977` |
| Gate D | PASS | `release-verification/09-gate-d.log` — 6 files / 16 tests |
| Context Independence | PASS | `release-verification/10-context-independence.log` — 4 files / 11 tests |
| Legacy Cutover | PASS | `legacy-cutover/legacy-cutover.test.log` — 4 files / 10 tests |
| Full Check | PASS | `release-verification/11-full-check.log` — 77 files / 301 tests |

## Cross-platform hardening

GitHub Actions run [`33716075977`](https://github.com/minorunakamura/pi-workflow/actions/runs/33716075977) は `main` のRC HEADを対象に実行され、workflow `head_sha` はRC HEADと一致している。

- `macos-latest`: PASS — 8 files / 39 tests
- `ubuntu-latest`: PASS — 8 files / 39 tests
- `windows-latest`: PASS — 8 files / 39 tests
- RC SHA: `9197c6f451f4f6b7069cac93d1244855fbfd25e7`
- 各jobのartifact: `release-evidence/phase-1-rc-9197c6f451f4/cross-platform-ci/main-run-33716075977/`

## Legacy Cutover certification

- `LEGACY_PATH_ABSENT`: **PASS**
- `NEW_RUNTIME_OPERATIONAL`: **PASS**
- `CUTOVER_ELIGIBLE`: **PASS** — Gate A〜D、packed runtime、persistence/recovery、repository/security、cross-platform、その他の必須hardening Evidenceが今回のRC HEADでPASS
- `NO_LEGACY_FALLBACK`: **PASS**
- Legacy session transcript migration: 導入なし

## STORY-13-08 security Evidence

`tests/e2e/production-security.test.ts` は concrete Pi Agent Runtime bridge経由でPASS。

- prohibited Agent mutation: **PASS**
  - read-only Scoutの`edit`を拒否
  - verify-only Verifierの`write` / `bash`を拒否
  - 保護対象ファイルを不変に維持
- Tool-capability denial: **PASS**
  - denied Toolをadvertiseせず、呼び出しをエラー化

## Final Release Eligibility

今回のRC HEADに対する全必須項目がPASSし、FAIL / INSUFFICIENT EVIDENCEはない。

**Phase 1 Releaseは宣言可能。**

## Residual Risk

- `pnpm check`には既存のnon-fatal type assertion/lint warningsがある。
- 外部live LLM/provider実行は必須Release Evidence範囲外。

コミットおよびpushは行っていない。
