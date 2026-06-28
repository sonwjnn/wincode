# Frontend Coding and Placement Standards

These conventions support the architecture but do not redefine module ownership.

## 1. Naming

- Business modules, use-case folders, and files use `kebab-case`.
- React components and TypeScript types use `PascalCase` exports.
- Hooks use a `use-` filename prefix and `useX` export name.
- Use one configured test suffix: `.test.*` or `.spec.*`.
- Prefer business-intent names. Avoid `common`, `misc`, `helpers`, and `base` unless the
  abstraction has a precise documented meaning.

## 2. Types and schemas

- Keep validation next to the feature/use case that owns the input.
- Infer the TypeScript type when a runtime schema is the source of truth.
- Use explicit domain types for concepts not represented by a runtime schema.
- Treat API DTOs and domain models as separate concepts; map them at the feature API boundary.
- Co-locate boundary-specific schemas, for example `api/order-dto.schema.ts` or
  `ui/order-form.schema.ts`.
- Use module-level `schemas/` only when the same schema serves multiple internal boundaries.
- Do not promote `email`, `phone`, `money`, or identity validation merely because the name
  looks generic; semantics may differ by business context and locale.

## 3. Error handling

1. Catch only to recover, add actionable context, translate an error, or perform cleanup.
2. Treat caught values as `unknown` and narrow before reading properties.
3. Never use an empty catch or silently return `undefined` after failure.
4. Preserve the original cause when translating errors.
5. Let unexpected failures reach framework error boundaries and monitoring.
6. Use typed results for expected business outcomes only when adopted by the profile.

## 4. Tests

- Feature tests and fixtures stay in the owning module.
- `shared/testing` contains only generic renderers, factories, and matchers.
- Tests may access internals when necessary but should prefer public behavior.
- Include failure-path coverage for validation, data integration, and business rules.

## 5. Assets, styles, and localization

- Feature images, icons, styles, and translations stay in their module.
- Global fonts, theme bootstrap, and route-shell styling belong in `app/` or the configured
  UI-system location.
- Shared localization code owns loading/formatting infrastructure; modules own business messages.

## 6. Generated code and UI systems

- Generated code lives at a destination recorded in the Architecture Profile.
- Do not move generated source manually after each generation.
- Do not edit generated code unless the generator treats it as user-owned source.
- UI-tool-specific commands, aliases, styling rules, and registries belong in tool-specific
  instructions or the Architecture Profile.
