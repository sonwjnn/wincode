# Separate Effort and Reasoning Mode

Wincode's current `variant` selection mixes named, model-supported reasoning levels with the `none` and `thinking` toggle states. Wincode will expose named levels as **Effort** and keep the two toggle states as a separate **Reasoning Mode**; model-specific catalog policy continues to determine which choices are available, and provider requests remain derived at the provider boundary. This amends ADR-0013's persisted naming decision while retaining its catalog-policy and request-time translation decisions.

Status: accepted

## Consequences

- Rename Wincode-owned reasoning selection contracts and persisted fields to `effort` and `reasoningMode`; do not retain `variant` compatibility aliases.
- `min` is not added to the current Effort vocabulary. Add it only when an official model source publishes it as a distinct level; a documented alias does not add another Effort ID.
- Preserve existing session data when the schema can be reconciled safely. If it cannot, use the project's clean-reset policy for the local database and attachment data before restart.
- Existing provider-specific request serialization remains model- and protocol-specific. The literal Reasoning Mode names are not a shared provider wire enum.
