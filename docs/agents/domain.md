# Domain Docs

This is a single-context repository.

## Before exploring

- Read `CONTEXT.md` at the repository root.
- Read ADRs under `docs/adr/` that affect the area being changed.
- Read `docs/MVP.md` when working on the initial product scope.

If a referenced domain document does not exist, proceed silently. Domain producer skills create these documents lazily as terminology and decisions are resolved.

## Use the glossary vocabulary

Use terms defined by `CONTEXT.md` in issue titles, implementation plans, tests, and code. Do not drift to synonyms that the glossary explicitly marks under `_Avoid_`.

If a required domain concept is absent, reconsider whether new language is necessary or note the gap for a future grilling session.

## Flag ADR conflicts

Explicitly surface any proposed work that contradicts an existing ADR rather than silently overriding it.
