# Package-root test portfolios

Wincode distinguishes Unit and local Integration as test kinds, but runs both in
one deterministic Default Test Portfolio because both are offline,
credential-free, hermetic, and cheap enough to run on every canonical test
invocation. E2E tests form a separate portfolio because they exercise a complete
user journey through a real interface; External tests call real providers and
remain outside required pull-request checks.

Every package owns its tests under a package-root `test/` tree rather than
colocating them with production source. Default tests use
`*.test.{ts,tsx}`; E2E tests use `*.e2e.test.{ts,tsx}`; a future External
portfolio uses `*.external.test.{ts,tsx}`. Files may remain flat inside
`test/`; product-area directories are added only when they improve navigation,
group cohesive test infrastructure, or avoid a collision.

`bun run test` is the canonical Default runner. Root runners own common Bun
execution and discovery, while package scripts may delegate to the root runner
for focused execution. Default tests run in one subprocess per package,
sequentially, and report every package failure before exiting. E2E tests run
process-per-file and fail fast. Both use a 30-second test timeout, no retries,
and a 15-minute CI job timeout.

Discovery audits every source-owned test under `packages/*/test`, excludes
generated output, and rejects tests outside a package test tree or with an
unsupported classification suffix. It does not require packages without tests
to contain empty directories. Executable test infrastructure is named
`support`; inert sample inputs and expected outputs are named `fixtures`;
generic `utils`, `helpers`, `common`, and `data` directories are avoided.

Required pull-request checks run on Ubuntu as separate `check-types`, Default,
and E2E jobs; one aggregate gate requires all three without rerunning them.
macOS runs Default and E2E weekly and through manual dispatch. E2E failures
retain runner logs and final terminal character frames for seven days, but never
database contents, attachments, environment values, or credentials.

The repository migrates to this structure atomically; no runner supports both
colocated and package-root layouts. We do not create an empty External runner
or workflow. It becomes concrete with its first real provider contract, starts
as a manually dispatched credential-gated check, and becomes scheduled only
after cost, quota, and ownership are explicit.
