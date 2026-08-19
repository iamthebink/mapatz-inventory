---
title: 'Establish formatting and linting baseline'
type: 'chore'
created: '2026-08-20'
status: 'done'
review_loop_iteration: 0
baseline_commit: '2eac2d323195bd67bb3864b2b4abcaf35e6f64ff'
context: []
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** The repository has ESLint configuration and a `lint` script, but no formatter dependency, configuration, format scripts, or demonstrated clean baseline. This makes future diffs noisier and leaves code-quality enforcement uncertain before development resumes.

**Approach:** Preserve the existing TypeScript/React ESLint foundation, add Prettier with explicit repository scripts and ignores, then apply mechanical fixes and formatting across maintained text source. Report any remaining finding whose resolution could change behavior or encode a product/architecture choice.

## Boundaries & Constraints

**Always:** Use pinned project-local tooling through pnpm; keep formatting and linting independently runnable; format only maintained text/code/configuration files; preserve runtime behavior; ensure generated output, dependencies, BMAD internals, databases, and binary assets are excluded; keep CI-suitable non-mutating check commands.

**Ask First:** Any lint finding requiring a behavior change, public API change, broad type-policy relaxation, deletion, or architectural judgment; any dependency migration beyond formatter/linter support.

**Never:** Reformat binaries, generated `dist`, runtime `data`, `node_modules`, `_bmad`, or `_bmad-output`; suppress legitimate findings merely to obtain a green command; refactor application behavior as part of this hygiene pass.

</frozen-after-approval>

## Code Map

- `package.json` -- Existing `lint` and `typecheck` scripts; add formatter dependency and consistent check/fix entry points here.
- `pnpm-lock.yaml` -- Lockfile must record the project-local formatter dependency reproducibly.
- `eslint.config.js` -- Existing ESLint 9 flat config using recommended JavaScript, TypeScript, and React Hooks rules; preserve its policy unless an evidenced defect requires a mechanical correction.
- `.gitignore` and `.dockerignore` -- Existing artifact boundaries inform formatter exclusions; neither should be broadened without need.
- `.prettierignore` and formatter configuration -- New explicit scope and stable formatting policy.
- `src/**/*.{ts,tsx,css}`, `tests/**/*.ts`, `scripts/**/*.mjs`, and root text/config files -- Maintained source subject to formatting and lint inspection.
- `dist/`, `data/`, `node_modules/`, `_bmad/`, `_bmad-output/`, and `2025_inventory.xslx` -- Read-only/excluded generated, runtime, dependency, workflow, and binary material.

## Tasks & Acceptance

**Execution:**
- [x] `package.json`, `pnpm-lock.yaml`, formatter config, and `.prettierignore` -- add a project-local Prettier baseline plus `format` and `format:check` commands while retaining `lint` as the non-mutating lint gate.
- [x] Maintained source and configuration files -- run formatter and ESLint autofix, accepting only mechanical changes that preserve behavior.
- [x] Remaining lint output -- fix unambiguous correctness issues; record any choice-bearing findings for the user without changing them.

**Acceptance Criteria:**
- Given a fresh dependency install, when `pnpm format:check` runs, then all in-scope maintained files satisfy the committed formatting policy without mutation.
- Given the formatted repository, when `pnpm lint` runs, then it exits successfully or the handoff names every remaining finding and why it requires a human choice.
- Given existing application behavior, when typecheck and tests run after cleanup, then they pass without behavior-oriented source changes introduced by this task.
- Given generated, runtime, workflow, dependency, and binary paths, when formatting is applied, then those paths remain untouched.

## Spec Change Log

## Verification

**Commands:**
- `pnpm format:check` -- expected: formatter reports all matched files compliant.
- `pnpm lint` -- expected: ESLint exits zero, unless explicitly surfaced choice-bearing findings remain.
- `pnpm typecheck` -- expected: both browser and server TypeScript checks exit zero.
- `pnpm test` -- expected: existing Vitest suite passes.
- `git diff --check` -- expected: no whitespace errors.

## Suggested Review Order

**Tooling entry points**

- Start with the contributor-facing format, lint, and verification commands.
  [`package.json:6`](../../package.json#L6)

- Confirm the pinned formatter policy is deliberately small and stable.
  [`.prettierrc.json:1`](../../.prettierrc.json#L1)

**Scope and lint policy**

- Verify generated, runtime, dependency, and workflow material stays outside formatting scope.
  [`.prettierignore:1`](../../.prettierignore#L1)

- Review zero-warning TypeScript, Hooks, and Vite Fast Refresh enforcement.
  [`eslint.config.js:6`](../../eslint.config.js#L6)

**Mechanical baseline**

- Sample the largest formatter-only UI transformation for behavioral neutrality.
  [`App.tsx:1`](../../src/web/App.tsx#L1)

- Sample server-domain formatting across SQL and transactional control flow.
  [`inventory.ts:1`](../../src/domain/inventory.ts#L1)

**Evidence and follow-ups**

- Integration coverage exercises permissions, persistence, validation, and lifecycle invariants.
  [`api.test.ts:32`](../../tests/integration/api.test.ts#L32)

- Deferred entries isolate CI and stricter type-lint policy decisions.
  [`deferred-work.md:17`](deferred-work.md#L17)
