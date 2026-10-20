# Shared reasoning effort defaults

When a Provider Model declares reasoning but publishes no named effort ladder, Wincode exposes the shared `off`, `minimal`, `low`, `medium`, and `high` choices; explicit model mappings can remove defaults or add `xhigh` and `max`. This intentionally relaxes ADR-0049's prior rule to use the provider default when named effort support is absent. Provider adapters may omit choices they cannot serialize and remain responsible for translating supported values to native protocol fields.
