# Golden fixtures for the deterministic markdown serializer (#15 / ADR-0017)

These `.md` files are **byte-for-byte expected outputs** of `serializeGraph` /
`exportMarkdown` for the deterministic graph built in
`markdown-export.test.ts`.

- They are byte-stable across runs (same graph → same bytes) and locale-invariant
  (the locale-mutation case proves the serializer never reaches for
  `localeCompare` / `Intl`).
- Update them ONLY on purpose — when the serializer's format intentionally
  changes. To regenerate after an intentional change:

      UPDATE_FIXTURES=1 pnpm test markdown-export

  Then `git diff` and commit the new shape together with the format change.

- Fixed Node / Project ids in the test seed make the output reproducible
  (cuid defaults are random — they would break byte-equality).

- Flows / FlowRoutes are **not** present in these fixtures: Slice 5 (#38)
  extends the format additively with its own Flow-bearing fixture without
  re-baselining what's here.
