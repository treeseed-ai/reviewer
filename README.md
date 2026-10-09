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

For installed native acceptance, invoke the installed binary with
`--installed-packages /absolute/isolated-install/node_modules`. Keep each actual
owner archive beside `node_modules`, using the filename from its retained native
`npm pack --json` output, and install those archives with production dependencies
and scripts disabled. The source workspace still supplies exact Git candidates
and complete suites. Reviewer compares native package inventory, archive bytes,
installed files, selected definitions and executable assets; its existing run
bundle retains archive SHA256 and installed-byte evidence. `--plan` checks the
same installed custody without running suites or scenes. Missing archives,
altered assets, extra files, symlinks, source-runner fallback and verifier imports
outside the installation fail closed. Installed scene execution requires native
Node verifiers. The executing package participates in fresh source prerequisites
without adding its unrelated browser companion dependencies.

Every invocation runs complete declared owner unit/integration suites before
any coded scene, once per owner, with ongoing exact Git/source custody.
Canonical unfiltered Vitest entrypoints and owner-contained native Node runners
are supported. Native entrypoints retain their original `npm test` build and
recursive discovery; they must forward the standard reporter/destination pair.
The same Node terminal-event normalizer reports source and compiled execution;
test stdout and error prose are not prerequisite evidence. Failed, skipped,
todo, cancelled, empty, filtered, malformed, missing or candidate-mutating
results block scenes. Unsupported entrypoints and unknown owners remain blocked;
this does not attest arbitrary browser/managed admission or selected runtime
artifact/source correspondence.

Package-owned test verifier declarations may set `timeoutMs` to an integer
between 1 and 86,400,000 milliseconds for long campaign scenes. The default
remains 120,000. Invalid values fail during planning; an expired process
watchdog fails the run and records its timeout and process error code. This
watchdog does not alter workday or assignment deadlines, reserve capacity, or
replace a campaign scene's supported stop/settlement/cleanup responsibilities.

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

For an explicitly authorized stage, repeat `--acceptance-section` with each
exact heading path, including every shared requirement applicable to that
stage. A path includes its descendants only at the ` / ` heading boundary;
unknown, empty or duplicate paths fail. The complete original Markdown remains
the input, and original criterion identities and stale-binding checks remain.
For example, a specification headed `Acceptance` can select
`--acceptance-section "Acceptance / Shared" --acceptance-section "Acceptance / First project"`.
The owning acceptance workflow—not Reviewer—defines the authorized stage and
its required shared sections; arbitrary selection cannot certify that policy.

Scoped plans and run receipts retain `acceptanceSelection`: exact sections,
whole criterion count, selected IDs, deferred IDs and `wholeSpecification`.
Deferred criteria are unproven, never passed. A stage pass with
`wholeSpecification: false` cannot be presented as final acceptance. Omit all
section options for the unchanged full gate. Section selection does not filter
or reuse complete participating-owner prerequisite suites.

When a shared requirement is directly under a heading whose children belong to
later stages, `--acceptance-exact-section "Acceptance / Projects"` selects only
that heading's own requirements. Combine it with ordinary section selections
for the current child project. Newly added or changed shared requirements still
fail without bindings; no requirement text or identity is rewritten. The receipt
retains these heading-only paths as `acceptanceSelection.exactSections`.
