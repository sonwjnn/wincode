# Ultracite Code Standards

This project uses **Ultracite**, a zero-config preset that enforces strict code quality standards through automated formatting and linting.

## Quick Reference

- **Format code**: `bun run fix`
- **Check for issues**: `bun run check`
- **Type check all workspaces**: `bun run check-types`
- **Run deterministic tests**: `bun test`
- **Run integration tests**: `bun run test:integration`
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

Classify tests by crossed dependencies:

- **Default**: deterministic, offline, credential-free, isolated in-process behavior.
- **Unit**: a genuinely narrower transformation or boundary; never a second name for
the default portfolio.
- **Integration**: the highest stable public seam crossing route composition,
filesystem, subprocess, or local database boundaries. Use `*.integration.test.*`.
- **External-service integration**: real services, explicitly gated by their
environment contract and run in a dedicated CI lane when such a dependency
exists.
- **Smoke**: only a narrow install, packaging, worker, native-addon, or runtime
failure that lower seams cannot expose.
- **E2E**: only a user journey that cannot be protected at a cheaper seam. Future
TUI coverage uses a virtual terminal; future browser coverage uses Playwright.

Prefer the highest stable behavioral seam. Do not duplicate an integration contract
with a narrower mocked test. Real failures must be triggered at the responsible
boundary; mocking the final error is not error coverage. Own cleanup of temporary
files, processes, database records, environment changes, and spies.

Reject static echo, passthrough, source-text, tautological, placeholder, wording-only,
and package-startup-only tests. Do not add tests for tiny low-risk changes without a
real contract or regression risk. Regression tests include the issue number and the
behavior that previously failed. Unit and integration tests do not retry or use sleeps
for readiness; wait for process exit, protocol calls, events, or state transitions.

- `bun test` is the canonical deterministic default lane and excludes integration
files.
- `bun run test:integration` discovers all `*.integration.test.*` files.
- Network access and provider credentials are opt-in; CI scrubs credential variables.

Before completion, run the narrowest affected command and the canonical lane. Do not
claim an external lane passed unless its explicit prerequisites were present.

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