# RPC Plugin UI protocol

RPC Plugin UI is an opt-in extension to protocol version 4. It carries only JSON data; it does not load, serialize, or execute Plugin React components.

## Capability negotiation

A client offers version 1 in `initialize.params.capabilities`:

```json
{"pluginUi":{"version":1}}
```

The server replies with the capability only for that offered version:

```json
{"pluginUi":{"version":1,"methods":["plugin/ui/request","plugin/ui/notify","plugin/ui/update"]}}
```

An absent or unsupported version receives no `pluginUi` response capability and no Plugin UI frames. Ordinary RPC operation remains available. A client must not assume support before reading the `initialize` response.

Every Plugin-originated UI payload includes `pluginId` as display/source identity. It is not an authorization signal. The server continues to enforce its existing permission and Session Writer rules.

## Blocking interactions

The server sends each interaction as a JSON-RPC request named `plugin/ui/request`. The request ID is its correlation key and has the `plugin-ui:` prefix. `params.sequence` orders it with other server output; response order does not determine interaction identity.

| `kind` | Other parameters | Valid direct `result` | Plugin API result |
| --- | --- | --- | --- |
| `select` | `title`, `choices: string[]` | A string in `choices`, or `null` | Selected string, or `undefined` |
| `confirm` | `title`, optional `message` | Boolean | `true` or `false` |
| `input` | `title`, optional `placeholder` | String, or `null` | String, or `undefined` |
| `editor` | `title`, optional `initialValue` | String, or `null` | String, or `undefined` |

For example, the server may send:

```json
{"jsonrpc":"2.0","id":"plugin-ui:550e8400-e29b-41d4-a716-446655440000","method":"plugin/ui/request","params":{"sequence":8,"pluginId":"reply","kind":"input","title":"Recipient","placeholder":"name@example.com"}}
```

The client replies with a normal JSON-RPC response using the same ID and the direct result value:

```json
{"jsonrpc":"2.0","id":"plugin-ui:550e8400-e29b-41d4-a716-446655440000","result":"user@example.com"}
```

`null` dismisses selection, input, or editor and maps to `undefined`. `confirm` accepts only a boolean; `false` is a valid decline. An RPC error or malformed/kind-invalid result settles to the method default (`undefined` for select/input/editor, `false` for confirm). A select result must be one of its offered choices.

`PluginUIDialogOptions.timeout` is transmitted as `timeoutMs` in milliseconds and enforced by the server. A missing timeout has no hidden deadline. A zero timeout resolves immediately to the default without sending a request. Invalid negative or non-finite timeouts reject with `RangeError`.

Caller abort and timeout send the standard `$/cancelRequest` notification with `{ "id": "plugin-ui:<request-id>" }`, then settle that interaction to its method default. A client may also send `$/cancelRequest` for a pending UI request; the server settles only that matching interaction. An unrelated RPC request, a response with another ID, or a stale response cannot answer a pending interaction. Unknown and stale response IDs are ignored and logged.

Pending interactions settle on input disconnect, server shutdown, or Session/view unbinding. A late response after cancellation or teardown has no effect. Every request settles at most once.

## Nonblocking notifications and data updates

`plugin/ui/notify` is a JSON-RPC notification with no response:

```json
{"jsonrpc":"2.0","method":"plugin/ui/notify","params":{"sequence":9,"pluginId":"reply","message":"Draft ready","level":"info"}}
```

`level` is `info`, `warning`, or `error` and defaults to `info` at the Plugin API.

`plugin/ui/update` is one ordered JSON-RPC notification per data update. Its validated `params` union is:

```ts
type PluginUIUpdate =
  | { type: "status"; pluginId: string; key: string; value: string | null }
  | {
      type: "widget";
      pluginId: string;
      key: string;
      value: readonly string[] | null;
      placement: "aboveEditor" | "belowEditor";
    }
  | { type: "title"; pluginId: string; value: string | null };
```

`null` clears/restores the corresponding default. Producers default widget placement to `aboveEditor`. These data contracts do not require a React component contribution; the host maps each update to the client protocol without changing Session or Agent state. Title is host-wide: the last non-null update owns it, and an old owner's clear cannot reset a later owner's title. Disabling/unloading a Plugin or closing its Session UI host sends reset updates for that Plugin's active status, widgets, and current title; cleanup does not clear another Plugin's contributions.

The `sequence` value is monotonically increasing across server notifications and UI requests. Frames are written in sequence order. UI responses are correlated by request ID, not by sequence.

## Per-mode results

| Operation | RPC with version 1 | RPC without version 1 | JSON / Print |
| --- | --- | --- | --- |
| `select` | `plugin/ui/request`; unsupported/dismissal result is `undefined` | `undefined` | `undefined` |
| `confirm` | `plugin/ui/request`; unsupported/dismissal result is `false` | `false` | `false` |
| `input` | `plugin/ui/request`; unsupported/dismissal result is `undefined` | `undefined` | `undefined` |
| `editor` | `plugin/ui/request`; unsupported/dismissal result is `undefined` | `undefined` | `undefined` |
| `notify` | `plugin/ui/notify` | no-op | no-op |
| `setStatus` | `plugin/ui/update` (`status`; `undefined` clears) | no-op | no-op |
| `setWidget` | `plugin/ui/update` (`widget`; `undefined` clears) | no-op | no-op |
| `setTitle` | `plugin/ui/update` (`title`; `undefined` clears) | no-op | no-op |
| `custom` | `undefined`; factory ignored | `undefined`; factory ignored | `undefined`; factory ignored |
| `getAllThemes` | `[]` | `[]` | `[]` |
| `getTheme` | `undefined` | `undefined` | `undefined` |
| `setTheme` | failure result | failure result | failure result |

Theme changes outside Interactive Mode return `{ success: false, error: "Theme changes are available only in Interactive Mode." }`.

Prompt lifecycle hooks report interaction status only. Waiting for a Plugin UI response does not pause or resume an Agent Turn, alter permissions, or transfer Session ownership.

## Protocol client example

[`examples/rpc-plugin-ui-client.ts`](../../../examples/rpc-plugin-ui-client.ts) constructs the versioned `initialize` frame and responds only to matching `plugin/ui/request` server requests. It is transport-neutral: call its handler from the JSONL receive loop and write returned response objects on the same RPC input stream. The example also forwards `plugin/ui/notify` and `plugin/ui/update` data to a client-owned display callback without replying to notifications.
