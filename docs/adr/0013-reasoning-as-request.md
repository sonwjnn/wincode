# Reasoning effort is a Provider Model request choice

A Provider Model's exact identity is `{ providerId, modelId }`; reasoning effort is a request choice supported by that Provider Model, not part of its identity. The selected scalar effort may be retained with Session selection and message metadata, while the SDK Provider translates supported values into provider-native request options.

Status: accepted

## Context

The historical `ModelVariant` was a closed global enum of eight values (`none`, `thinking`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max`) that conflated an effort ladder, an on/off switch, Anthropic's thinking mode, and Google's thinking level. Adding a provider or level meant editing the enum, schema, and several resolver branches. The Catalog-backed policy and Model Target mechanics described in earlier revisions of this ADR were superseded by the Provider SDK cutover in ADR-0049; the request-level reasoning decision remains in force.

The upstream projects helped expose the useful distinction: Pi models reasoning as a model capability plus a request-level `ModelThinkingLevel`; OMP declares model-specific thinking configuration and maps effort at request time; OpenCode treats variants as named per-model request overrides. These informed the original decision, but they are not Wincode's current runtime abstraction.

## Decision

- Each Provider Model declares its own supported `reasoningEfforts`. This capability is not inferred from another model or a Catalog-wide policy.
- A Chat request carries an optional reasoning effort separately from its `{ providerId, modelId }` identity and Plugin ownership provenance.
- The SDK Provider maps an effort to its wire representation only when the selected Provider Model declares that effort. An absent or unsupported effort is omitted so the provider default applies; Wincode does not guess a mapping or substitute another model.
- Session selection and message metadata may retain the scalar effort identifier. They do not persist an expanded provider request, so restoring a Session resolves the choice against the current Provider Model implementation and metadata.

## Consequences

- Reasoning support changes with the exact Provider Model declaration; changing a model does not carry over an inferred effort policy.
- A restored scalar effort can map differently if provider metadata or protocol behavior changes. This is accepted; the historical wire request is not replayed.
- The former `variant`/`variantRef` Catalog lookup scheme is not a current persistence or execution contract. Session records retain Provider Model identity and the scalar selection separately.

## Historical defect

The former `anthropicManualModels` table hard-coded `selectedBudget = 16_000` regardless of the selected variant, so `high` and `max` produced byte-identical requests while the picker offered them as two options. That table and adapter path were retired during the Provider SDK cutover; the current contract avoids representing such model-specific wire details as global variant policy.
