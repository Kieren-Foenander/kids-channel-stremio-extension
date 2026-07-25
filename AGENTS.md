## Agent skills

### Issue tracker

Issues and PRDs are tracked in GitHub Issues. See `docs/agents/issue-tracker.md`.

### Triage labels

Use the five canonical triage labels configured for this repository. See `docs/agents/triage-labels.md`.

### Domain docs

This is a single-context repository. See `docs/agents/domain.md`.

## Cloudflare Worker runtime gotcha

Workerd brand-checks native runtime functions such as `fetch`. Do not detach a native function and later invoke it as an object property; for example, storing `fetch` in a provider field and calling `this.request(...)` changes its receiver and throws `Illegal invocation` before any HTTP response exists.

- Call the global function directly: `fetch(input, init)`.
- When an outbound HTTP function is injected, invoke it with the Worker global receiver: `request.call(globalThis, input, init)`.
- Add a regression test whose injected function rejects an incorrect `this` receiver.
- Exercise outbound HTTP through the complete Worker/workerd seam. A Node-only contract probe can succeed while the Worker call still fails.

See `StremioAddonProvider` in `src/stream-provider.ts` and its receiver regression test in `test/worker.test.ts`.
