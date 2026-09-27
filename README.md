# TreeSeed Reviewer

Reviewer is the unified interface for package-owned guarantees and scenes.
Definitions and verifier assets belong to the package being tested, not to a
central copy in Reviewer.

## Automated guarantee execution

```sh
treeseed-reviewer-guarantees --workspace /path/to/package \
  --ids guarantee.agent.golden.results --environment local --run-id unique-id
```

Use comma-separated IDs to select several guarantees. Dependencies compose
larger suites from the same checks. `--plan` validates the selection without
executing it. A workspace containing `packages/` discovers owner catalogs
across those package roots. The local web interface reviews the same immutable
run receipts. Component and integrated-runtime evidence remain separate;
passing component tests cannot attest a live golden campaign.

Native TypeScript verifiers use Reviewer's installed loader. They do not require
the tested package's development dependencies. Missing assets, missing exact
test names, skipped tests, unavailable services and incomplete evidence cannot
pass. Failed native checks retain error classification and source location,
never raw credential-bearing test output.

## Acceptance specification coverage

```sh
treeseed-reviewer-guarantees --workspace /path/to/platform \
  --ids guarantee.agent.golden.runtime-readback --plan \
  --acceptance-spec docs/agent-acceptance.md
```

This is a **whole-specification** coverage gate. A partial suite is expected to
fail it. The planner derives exact criterion digests from the authoritative
Markdown, excluding progress diaries and checkbox completion state. Each
owning guarantee can bind a criterion to its executable verifier references:

```yaml
acceptanceCriteria:
  - criterion: <exact SHA-256 of section and normalized requirement>
    verifierRefs: [<registered exact verifier>]
```

Unbound or changed criteria fail closed with their source line and section.
Bindings are proof obligations, not automatic claims of semantic coverage;
reviews must confirm that the assertion proves the entire criterion. Existing
read-back scenes do not yet cover the full agent acceptance specification.
