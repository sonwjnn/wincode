# Architecture Decision Records

Create an ADR when a decision:

- reverses or makes an exception to a core dependency rule;
- introduces a new top-level/shared category;
- changes module ownership or public-entrypoint strategy;
- adds a long-lived cross-module dependency;
- selects infrastructure that materially constrains module boundaries.

Use the next sequential filename: `NNNN-short-decision-name.md`.

Do not create an ADR for an ordinary implementation choice that already follows the rules.

## Required fields

```markdown
# NNNN — Decision title

- Status: Proposed | Accepted | Superseded | Retired
- Date: YYYY-MM-DD
- Owners: team/person
- Scope: affected paths/modules

## Context

What pressure or constraint requires a decision?

## Decision

What will be done?

## Rules affected

Which architecture rules are specialized or temporarily violated?

## Consequences

Positive and negative tradeoffs.

## Enforcement

How will code review or CI enforce the decision?

## Removal or review condition

When should this exception be removed or revisited?
```
