# Ultracite Code Standards

This project uses **Ultracite**, a zero-config preset that enforces strict code quality standards through automated formatting and linting.

## Quick Reference

- **Format code**: `bun run fix`
- **Check for issues**: `bun run check`
- **Type check all workspaces**: `bun run check-types`
- **Run the Default test portfolio**: `bun run test`
- **Run TUI E2E tests**: `bun run test:e2e`
- **Start the CLI in watch mode**: `bun run dev:cli`
Biome (the underlying engine) provides robust linting and formatting. Most issues are automatically fixable.

---

## Core Principles

Write code that is **accessible, performant, type-safe, and maintainable**. Focus on clarity and explicit intent over brevity.

### Type Safety &amp; Explicitness

- Use explicit types for function parameters and return values when they enhance clarity
- Prefer `unknown` over `any` when the type is genuinely unknown
- Use const assertions (`as const`) for immutable values and literal types
- Leverage TypeScript's type narrowing instead of type assertions
- Use meaningful variable names instead of magic numbers - extract constants with descriptive names

### Modern JavaScript/TypeScript

- Use arrow functions for callbacks and short functions
- Prefer `for...of` loops over `.forEach()` and indexed `for` loops
- Use optional chaining (`?.`) and nullish coalescing (`??`) for safer property access
- Prefer template literals over string concatenation
- Use destructuring for object and array assignments
- Use `const` by default, `let` only when reassignment is needed, never `var`

### Async &amp; Promises

- Always `await` promises in async functions - don't forget to use the return value
- Use `async/await` syntax instead of promise chains for better readability
- Handle errors appropriately in async code with try-catch blocks
- Don't use async functions as Promise executors

### React &amp; JSX

- Use function components over class components
- Call hooks at the top level only, never conditionally
- Specify all dependencies in hook dependency arrays correctly
- Use the `key` prop for elements in iterables (prefer unique IDs over array indices)
- Nest children between opening and closing tags instead of passing as props
- Don't define components inside other components
- Use semantic HTML and ARIA attributes for accessibility:
  - Provide meaningful alt text for images
  - Use proper heading hierarchy
  - Add labels for form inputs
  - Include keyboard event handlers alongside mouse events
  - Use semantic elements (`<button>`, `<nav>`, etc.) instead of divs with roles

### Error Handling &amp; Debugging

- Remove `console.log`, `debugger`, and `alert` statements from production code
- Throw `Error` objects with descriptive messages, not strings or other values
- Use `try-catch` blocks meaningfully - don't catch errors just to rethrow them
- Prefer early returns over nested conditionals for error cases

### Code Organization

- Keep functions focused and under reasonable cognitive complexity limits
- Extract complex conditions into well-named boolean variables
- Use early returns to reduce nesting
- Prefer simple conditionals over nested ternary operators
- Group related code together and separate concerns

### Security 

- Validate and sanitize user input

### Performance

- Avoid spread syntax in accumulators within loops
- Use top-level regex literals instead of creating them in loops
- Prefer specific imports over namespace imports
- Avoid barrel files (index files that re-export everything)

### Framework-Specific Guidance

**React 19+:**

- Use ref as a prop instead of `React.forwardRef`

---

## Testing

Tests are contract-first. Every test must defend one externally observable behavior,
state transition, error mapping, precedence rule, or regression-prone boundary, and
its name or nearby rationale must state the consumer-visible failure mode.

### Ownership and layout

Every package owns its tests under `packages/<package>/test/`. Small package test
trees stay flat. A larger package may add one shallow product-area directory when
test volume makes navigation meaningfully better; do not mirror technical source
roots such as `src`, `modules`, `shared`, or `app`. Test support code belongs under
`test/support`; inert inputs and expected outputs belong under `test/fixtures`.

The TUI keeps high-volume journeys in `test/sessions` and `test/mcp`, and groups
command and permission coverage in `test/commands` and `test/permissions`.
Other small product areas stay flat at the test root. Do not split a small test
into additional folders only to mirror production structure, and merge closely
related small tests when a shared file improves navigation without hiding a
contract.

### Portfolios and naming

- **Default**: deterministic, offline, credential-free tests, including Unit
  behavior and local Integration seams such as filesystem, SQLite, subprocess, or
  composed-application boundaries. Default files use ordinary `*.test.ts` or
  `*.test.tsx` names.
- **Unit** and **Integration** remain descriptive test kinds, not execution lanes.
- **E2E**: a complete user journey through a real interface. E2E files use
  `*.e2e.test.ts` or `*.e2e.test.tsx` and run separately.
- **External**: a real provider or service contract. External files use
  `*.external.test.ts` or `*.external.test.tsx` and remain outside required
  workflows until their credential and cost contract exists.
- **Smoke**: only a narrow install, packaging, worker, native-addon, or runtime
  failure that lower seams cannot expose.

The central runner discovers every package test tree, rejects colocated tests,
unsupported suffixes and extensions, excludes generated output, and prints
discovered and executed counts. `bun run test` runs one sequential subprocess per
Default package and reports all package failures. `bun run test:e2e` runs one
subprocess per E2E file and stops after the first failure. Both use a 30-second
test timeout and no retries.

Package-local `test` scripts delegate to the central Default runner with a package
filter, while direct development remains available with `bun test path/to/file`.
The audit still covers the whole repository when execution is filtered.

Prefer observable readiness transitions over sleeps. Real failures must be
triggered at the responsible boundary; mocking the final error is not error
coverage. Own cleanup of temporary files, processes, databases, environment
changes, and spies. CI scrubs provider credentials from deterministic jobs.

The required Ubuntu checks are type checking, Default, and E2E, followed by one
stable aggregate gate. macOS Default and E2E checks run weekly and on demand.

## When Biome Can't Help

Biome's linter will catch most issues automatically. Focus your attention on:

1. **Business logic correctness** - Biome can't validate your algorithms
2. **Meaningful naming** - Use descriptive names for functions, variables, and types
3. **Architecture decisions** - Component structure, data flow, and API design
4. **Edge cases** - Handle boundary conditions and error states
5. **User experience** - Accessibility, performance, and usability considerations
6. **Documentation** - Add comments for complex logic, but prefer self-documenting code

---

Most formatting and common issues are automatically fixed by Biome. Run `bun fix` before committing to ensure compliance.

---

## Agent skills

### Persistence rule

This is a solo-dev project. The local SQLite schema is synchronized directly
from the current Drizzle schema; Wincode does not maintain migration history.
Use `bun run --cwd packages/tui db:push` after schema changes. If a schema change
cannot be reconciled safely, delete the local database and attachment data
before restarting; no compatibility migration is provided.

### Issue tracker

Issues and PRDs for this repo live as GitHub issues, created and read via the `gh` CLI. See `docs/agents/issue-tracker.md`.

### Triage labels

Five canonical triage roles mapped to label strings: `needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`. See `docs/agents/triage-labels.md`.

### Domain docs

Multi-context layout: a root `CONTEXT-MAP.md` points to per-context `CONTEXT.md` + `docs/adr/` files, with system-wide decisions at the root `docs/adr/`. See `docs/agents/domain.md`.