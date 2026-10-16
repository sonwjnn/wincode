# Dormant legacy credential cleanup

This module contains only the temporary legacy cleanup gate. It is not wired into startup, Provider connections, model selection, or execution. `@wincode/ai/connections/legacy-cleanup` is the only Connections subpath retained for this gate.

The gate can remove and verify credentials from the old `connections-v2` file and platform-secret locations for the fixed legacy provider IDs. It does not read or delete Provider SDK credentials, Session data, or attachments. Tests use temporary directories and fake secret stores; do not invoke the gate against a real user home.

Provider credentials and exact Provider Model selection belong to the Provider SDK. Contributor instructions are in [`docs/adding-a-provider.md`](../../../../docs/adding-a-provider.md).
