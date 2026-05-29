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
2. **Map the scope boundary against sibling issues.** Recent plans have over-reached by silently absorbing work that belongs to other issues. Build an explicit out-of-scope list before briefing specialists:
   - `gh issue list --state open --limit 100` — skim every open title for adjacent work.
   - Pull every issue the target references (`blocks #X`, `blocked by #X`, `see #X`, `part of #X`, `epic #X`) and every issue sharing a label or milestone: `gh issue view <n> --json title,body,labels,milestone,number`.
   - For each adjacent open issue that touches the same files, domain term, or feature surface, record a one-line **"#NN — owns: <thing>"** entry. These are off-limits — the plan must stop at the seams between them.
   - If the target issue is silent on a capability that an adjacent issue clearly owns, that capability is **out of scope** here, even when bundling would be convenient. Record it as a dependency or follow-up instead.
   - If the issue's own scope is ambiguous, ask the user "Does this include X?" before continuing — narrow the slice to exactly what *this* issue owns.
3. Read the grounding docs so your specialist briefs are precise:
   - `CLAUDE.md` — the six philosophies (perf, good defaults, convenience, security, delight, never disable a rule to pass).
   - `CONTEXT.md` — the binding glossary; note which domain terms the issue touches (Component/Node, Connection/Edge, Actor, service layer…).
   - `docs/adr/` — skim titles; pull the ADRs in the issue's area.
4. Locate the code the issue touches (Glob/Grep) so briefs can cite real `file:line` anchors.

### Phase 1 — Parallel specialist analysis

Spawn **all three subagents in one message** for true parallelism. Each starts fresh with zero context, so every brief MUST be self-contained: paste the issue text inline, list the exact doc paths to read, name the files to inspect, **and paste the Phase 0 out-of-scope list verbatim with the directive: "Do not propose work that belongs to any of these sibling issues — call the seam out as a dependency instead."**

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
5. **Scope-creep check.** Walk the ordered steps and ask of each: "does this belong to any sibling issue on the Phase 0 out-of-scope list?" If yes, cut it from the plan and record it as a dependency on that issue. If a step *touches* a sibling's surface but is genuinely required here, state the seam explicitly: what this plan changes vs. what the sibling will change.

### Phase 3 — Present to build

Write the finalized plan to the plan file, then call `ExitPlanMode` to gate on approval before implementing (it reads the plan from the file — no plan content is passed as an argument). Pre-declare the build commands you'll need as `allowedPrompts` (e.g. `pnpm check`, `pnpm db:push`) to cut prompts later.

Structure the plan: **goal · the vertical slice · ordered steps (each naming its files) · risks + mitigations · assumptions & open questions · docs to update.**

## Quality bar

- **Plan scope is explicitly bounded.** Related work in other issues is called out by name; if overlap exists, the plan states what it excludes and why.
- Every step respects the service-layer contract and routes authz through the `access` module (ADR-0001).
- Honors `CLAUDE.md` — especially performance (optimistic updates, no waterfalls) and never disabling a lint/test rule to make it pass.
- Treats user-authored content as untrusted (the prompt-injection standing note in `CONTEXT.md`).

## Handoffs

- Too big for one issue → `/to-issues` to split into tracer-bullet slices.
- Want to stress-test interactively first → `/grill-with-docs`.
- Async/AFK handoff → offer to post the plan via `gh issue comment` and apply `ready-for-agent`.
