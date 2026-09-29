Closes #

## Summary

## Regression testing
<!-- Commands run and results (see AGENTS.md → Testing policy). -->

## Checklist
- [ ] Branch is `issue-<n>-<slug>`, based on `dev`, PR targets `dev`
- [ ] Linked issue has the `plan-approved` label
- [ ] Every new/changed function has thorough tests (happy path, edge cases, invalid input, errors)
- [ ] Regression tests for changed modules + dependents pass, and `npm run typecheck` passes
- [ ] No keys, tokens, or `.env` files included (see SECURITY.md)

<!-- Release PRs (dev → master) only: -->
- [ ] Release PR: full regression (`npm ci && npm run typecheck && npm run build && npm test`) passed, and output is attached
