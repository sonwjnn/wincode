# Billing

Owns authenticated web billing presentation, checkout and portal redirects, and
server-confirmed Go entitlement status.

Public API: `BillingView`, `BillingSuccessView`, and
`billingSuccessSearchSchema`.

Uses the typed Hono client and existing web auth client. Checkout return values
are never treated as entitlement proof.
