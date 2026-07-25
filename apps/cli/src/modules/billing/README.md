# Billing

Owns CLI billing usage retrieval, runtime validation, refresh state, and compact
prompt-status presentation data.

## Public API

- `BillingProvider` composes billing state around CLI screens.
- `useBilling` exposes current usage and a non-throwing hosted-usage refresh.
- `formatBillingUsage` formats the compact Go status text.

## Dependencies

- Uses the connections module public API for WinCode authorization.
- Uses shared Hono transport infrastructure.
- Prompt settings consumes this module to render funded/BYOK status.
- App routes inject billing refresh into hosted conversation completion.
