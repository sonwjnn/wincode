# Separate Runtime Object Utilities by Accepted Values

Status: accepted

Wincode introduces `@wincode/runtime-utils` as a leaf package with no runtime or Wincode-package dependencies. Its object predicates are separated by accepted-value semantics: `isPlainObject` is for plain parsed/config data, while `isObjectLike` is for non-null objects where arrays and special objects are valid; string, numeric, and JSON-value predicates remain provider- and domain-neutral. JSON predicates validate tree-shaped JSON compatibility, while callers own semantic limits such as MCP's depth, byte, and tool-count policies. Callers use only the predicate matching their invariant, and domain validators, key-presence checks, allowlists, parsers, and schema policies remain local. `isRecord`, `isNonArrayObject`, and `isDictionary` are not introduced, and `es-toolkit` is intentionally outside this extraction.

## Considered Options

- **One shared `isRecord` guard** — rejected because its meaning is ambiguous and would incorrectly collapse plain-object, array-accepting, and domain-specific checks.
- **`isNonArrayObject` for the existing middle category** — rejected because the negative name describes an implementation exclusion, while no caller has demonstrated a deliberate need to accept special non-array objects.
- **A runtime dependency on `es-toolkit`** — rejected because the package's contracts are small native predicates, `es-toolkit` predicates have different object semantics, and the leaf should remain runtime-dependency-free.

## Consequences

- Parsed JSON/config boundaries may reject arrays, `Date`, `Map`, `Set`, and class instances through `isPlainObject`; array-accepting extraction uses `isObjectLike` instead.
- Existing domain validators keep their own shape, presence, schema, and error policies; migration is semantic, not a name-based replacement.
- JSON-compatible value checks reject unsupported runtime values, custom prototypes, repeated references, and cycles; bounded callers pass their own depth limit.
- `UnknownRecord` remains a type-only dependency detail and is not re-exported by the package.
- The clean cutover removes obsolete exact local predicates without compatibility aliases or umbrella re-exports.
