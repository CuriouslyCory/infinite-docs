---
name: bulletproof-plan
description: Produces a bulletproof implementation plan for a GitHub issue by collaborating with three specialist subagents — senior engineer, application architect, and technical writer — in parallel, validating every claim against CONTEXT.md and the ADRs, then presenting the plan in plan mode for approval before any code is written. Use when the user wants to plan or spec out a GitHub issue, runs /bulletproof-plan with an issue number or URL, or asks for a rigorous multi-specialist implementation plan.
---

# Bulletproof Plan

Turn a GitHub issue into a battle-tested implementation plan: three specialists analyze it in parallel, you reconcile and red-team their findings, then present the plan for approval before writing a line of code.

This whole skill is read-only research, so run it in **plan mode**. If you're not already in plan mode when invoked, enter it (`EnterPlanMode`) at the start — every phase here is plan-mode-safe.

## Invocation

`/bulletproof-plan <issue-number-or-url>` — e.g. `/bulletproof-plan 8`.
No argument? Ask which issue (or whether to plan the current conversation's context instead).

## Workflow

### Phase 0 — Ground yourself

1. Read the issue: `gh issue view <number> --comments` (see `docs/agents/issue-tracker.md`). Capture title, body, and comments.
2. Read the grounding docs so your specialist briefs are precise:
   - `CLAUDE.md` — the six philosophies (perf, good defaults, convenience, security, delight, never disable a rule to pass).
   - `CONTEXT.md` — the binding glossary; note which domain terms the issue touches (Component/Node, Connection/Edge, Actor, service layer…).
   - `docs/adr/` — skim titles; pull the ADRs in the issue's area.
3. Locate the code the issue touches (Glob/Grep) so briefs can cite real `file:line` anchors.

### Phase 1 — Parallel specialist analysis

Spawn **all three subagents in one message** for true parallelism. Each starts fresh with zero context, so every brief MUST be self-contained: paste the issue text inline, list the exact doc paths to read, and name the files to inspect.

| Role | `subagent_type` | Lens |
| --- | --- | --- |
| Senior engineer | `general-purpose` (swap to `Backend Architect` for service-layer issues, `Frontend Developer` for canvas/UI issues) | Implementation path, edge cases, failure modes, test strategy, optimistic-update & waterfall concerns. |
| Application architect | `Software Architect` | System fit, the `(db, actor, input)` service-layer contract and `access`-module authz (ADR-0001), pattern choices, trade-offs, ADR alignment. |
| Technical writer | `Technical Writer` | Terminology vs the `CONTEXT.md` glossary, naming, which docs/ADRs must change, user-facing clarity. |

Direct each specialist to **challenge assumptions** and return: findings, assumptions questioned, doc/ADR validations (conflicts called out), risks, and their recommended slice with `file:line` pointers.

### Phase 2 — Synthesize and red-team

1. Reconcile the three into one plan; where they disagree, decide and say why.
2. **Flag ADR conflicts explicitly**, in the `docs/agents/domain.md` format: _"Contradicts ADR-XXXX (title) — but worth reopening because…"_ Never silently override an ADR.
3. Use the glossary's exact words. A concept the glossary lacks is a signal — note it for `/grill-with-docs`.
4. Red-team your own plan: name the single weakest assumption, the riskiest step, and what would make this fail — then resolve each. If specialists conflicted on something load-bearing, spawn one focused critique subagent rather than hand-wave.

### Phase 3 — Present to build

Write the finalized plan to the plan file, then call `ExitPlanMode` to gate on approval before implementing (it reads the plan from the file — no plan content is passed as an argument). Pre-declare the build commands you'll need as `allowedPrompts` (e.g. `pnpm check`, `pnpm db:push`) to cut prompts later.

Structure the plan: **goal · the vertical slice · ordered steps (each naming its files) · risks + mitigations · assumptions & open questions · docs to update.**

## Quality bar

- Every step respects the service-layer contract and routes authz through the `access` module (ADR-0001).
- Honors `CLAUDE.md` — especially performance (optimistic updates, no waterfalls) and never disabling a lint/test rule to make it pass.
- Treats user-authored content as untrusted (the prompt-injection standing note in `CONTEXT.md`).

## Handoffs

- Too big for one issue → `/to-issues` to split into tracer-bullet slices.
- Want to stress-test interactively first → `/grill-with-docs`.
- Async/AFK handoff → offer to post the plan via `gh issue comment` and apply `ready-for-agent`.
