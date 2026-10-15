---
Status: superseded by ADR-0044 and ADR-0049
---

# Separate Effort and Reasoning Mode

Wincode's former `variant` selection mixed named, model-supported reasoning levels with the `none` and `thinking` toggle states. Wincode exposed named levels as **Effort** and kept the two toggle states as a separate **Reasoning Mode**; ADR-0044 later adopted the unified ThinkingLevel contract, and ADR-0049 superseded the Catalog policy with Provider Model metadata. This historical decision amended ADR-0013's persisted naming decision while retaining its request-time translation rationale.

## Consequences

- Rename Wincode-owned reasoning selection contracts and persisted fields to `effort` and `reasoningMode`; do not retain `variant` compatibility aliases.
- `min` is not added to the current Effort vocabulary. Add it only when an official model source publishes it as a distinct level; a documented alias does not add another Effort ID.
- Do not convert old Session selection values. If the local Session schema lacks current Effort/Reasoning Mode columns, clear Session records, compactions, and attachments at Session Host startup; preserve prompt history.
- Existing provider-specific request serialization remains model- and protocol-specific. The literal Reasoning Mode names are not a shared provider wire enum.
