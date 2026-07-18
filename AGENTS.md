# Ultracite Code Standards

This project uses **Ultracite**, a zero-config preset that enforces strict code quality standards through automated formatting and linting.

## Quick Reference

- **Format code**: `bun x ultracite fix`
- **Check for issues**: `bun x ultracite check`
- **Diagnose setup**: `bun x ultracite doctor`

## Provider Changes

Before adding an AI/model provider, read `docs/adding-a-provider.md`. Provider onboarding is registry-driven; do not add provider branches to generic facade, vault, UI, transport, or model-dispatch code unless the behavior is an explicitly documented protocol exception.

Biome (the underlying engine) provides robust linting and formatting. Most issues are automatically fixable.

---

## Core Principles

Write code that is **accessible, performant, type-safe, and maintainable**. Focus on clarity and explicit intent over brevity.

### Type Safety & Explicitness

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

### Async & Promises

- Always `await` promises in async functions - don't forget to use the return value
- Use `async/await` syntax instead of promise chains for better readability
- Handle errors appropriately in async code with try-catch blocks
- Don't use async functions as Promise executors

### React & JSX

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

### Error Handling & Debugging

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

- Add `rel="noopener"` when using `target="_blank"` on links
- Avoid `dangerouslySetInnerHTML` unless absolutely necessary
- Don't use `eval()` or assign directly to `document.cookie`
- Validate and sanitize user input

### Performance

- Avoid spread syntax in accumulators within loops
- Use top-level regex literals instead of creating them in loops
- Prefer specific imports over namespace imports
- Avoid barrel files (index files that re-export everything)
- Use proper image components (e.g., Next.js `<Image>`) over `<img>` tags

### Framework-Specific Guidance

**Next.js:**

- Use Next.js `<Image>` component for images
- Use `next/head` or App Router metadata API for head elements
- Use Server Components for async data fetching instead of async Client Components

**React 19+:**

- Use ref as a prop instead of `React.forwardRef`

**Solid/Svelte/Vue/Qwik:**

- Use `class` and `for` attributes (not `className` or `htmlFor`)

---

## Testing

- Write assertions inside `it()` or `test()` blocks
- Avoid done callbacks in async tests - use async/await instead
- Don't use `.only` or `.skip` in committed code
- Keep test suites reasonably flat - avoid excessive `describe` nesting

## When Biome Can't Help

Biome's linter will catch most issues automatically. Focus your attention on:

1. **Business logic correctness** - Biome can't validate your algorithms
2. **Meaningful naming** - Use descriptive names for functions, variables, and types
3. **Architecture decisions** - Component structure, data flow, and API design
4. **Edge cases** - Handle boundary conditions and error states
5. **User experience** - Accessibility, performance, and usability considerations
6. **Documentation** - Add comments for complex logic, but prefer self-documenting code

---

Most formatting and common issues are automatically fixed by Biome. Run `bun x ultracite fix` before committing to ensure compliance. For `AGENTS.md` commits, write the commit message normally; do not use the `caveman-commit` plugin.

---

## API Requests — Use Hono RPC

**Always use Hono for API requests between server and CLI/web apps.** Never use raw `fetch()` with `env.SERVER_URL`.

The Hono client derives the URL automatically from the configured `httpBatchLink` — no manual URL construction needed.

### Request Validation — Use `@hono/zod-validator`

Prefer Hono's zod validator (`@hono/zod-validator`). Read validated typed input via `c.req.valid('json')`. Never use raw `await c.req.json()` with type assertions.

### Client-Side Validation — Use Zod Schemas

Use Zod schemas for all client-side parsing (router state, search params, localStorage, etc.). Never use `as` type assertions. Validate with `.parse()` or use TanStack Router's `validateSearch` with a Zod schema.

### Agent Tools — CLI Execution Only

Tool execution lives on the CLI. Tool schemas are shared through `packages/tools` so the server and CLI use the same Zod definitions. The server must never execute file-system tools; it only exposes schema-only tool definitions for the model, while the CLI runs the tool runtime in the user's current working directory.

---

## OpenTUI-Specific Notes

### TextArea is Uncontrolled

OpenTUI's `<textarea>` is **uncontrolled** — it's a buffer, not a controlled React input. Attempting to use `useState` value/`setValue` pattern gives you an always-empty string on submit.

**Correct pattern — use `ref.current.plainText` on submit:**

```tsx
const textAreaRef = useRef(null);

useKeyboard((key) => {
  if (key.name === "enter" && textAreaRef.current) {
    const value = textAreaRef.current.plainText; // NOT useState value
    onSubmit(value);
  }
});

return <textarea ref={textAreaRef} focused />;
```

### Imperative Handler State

OpenTUI input callbacks are imperative. If a keyboard handler reads state that can change through keyboard navigation, mirror that state into a ref and read the ref inside the handler. This avoids stale closures where the UI highlights one item while Enter executes another.

### Floating Overlays

OpenTUI popovers and overlays should not consume layout space unless intentionally inline. Put the wrapper at `position="relative"` with `overflow="visible"`, then render the overlay with `position="absolute"`, a concrete `bottom`, and a higher `zIndex` so it floats above the input without pushing chat content.

### CLI Route Loading

For OpenTUI CLI routes, avoid using TanStack Router loaders for screen-critical data when the route must visually switch immediately. Router loaders block route rendering until data resolves, which can make the current `<Outlet />` appear unchanged in the terminal. Prefer component-level async loading with local loading and error states for CLI screens that need immediate route feedback.

### Skill Invocation

Invoke the OpenTUI skill more frequently for optimized context learnings. When the answer isn't found in skill docs, reading through `node_modules` is fine.
