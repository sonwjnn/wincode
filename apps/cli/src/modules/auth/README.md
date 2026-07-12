# Auth

CLI browser sign-in uses OAuth Authorization Code with PKCE as a public client. It owns the loopback callback, token exchange, and local token persistence.

## Configuration

- `WINCODE_OAUTH_CLIENT_ID` defaults to the pre-registered `wincode-cli` public client.
- `WINCODE_OAUTH_ISSUER` defaults to `SERVER_URL`; the OAuth issuer is `${serverUrl}/api/auth`.
- `WINCODE_OAUTH_REDIRECT_URI` defaults to `http://127.0.0.1:8765/callback`.

The OAuth client must be pre-registered as public (`token_endpoint_auth_method: "none"`), require S256 PKCE, and include the exact redirect URI. No client secret is used or stored.

## Storage

Sessions persist at `~/.wincode/auth.json`. The directory is `0700`; file is atomically replaced as `0600` on POSIX systems.
