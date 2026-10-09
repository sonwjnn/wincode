# Interactive Resource Reload

Status: accepted

Interactive `/reload` is the application-level owner of refreshing configuration-backed resources. It resolves Project trust before protected resources, then composes fresh ConfigStore and Plugin runtimes; domain loaders continue to parse and resolve their own resources. Reload is allowed only when all Session Hosts are idle. Open Session Hosts and their UI views stay alive; Plugin Session scopes are closed before replacing process Plugin resources, then opened on the active Plugin runtime. Process resources start through a repeatable Plugin `onStart` hook and are released through `onShutdown`; file-loaded Plugin modules are invalidated and loaded again.

When Plugin replacement fails and Project trust is unchanged, Wincode keeps or restores the last good Plugin runtime while still applying refreshed configuration and other resources. A trust change takes precedence: Plugins from resources that are no longer trusted are shut down and are never restored. Resource source classes share package, user-discovered, user-explicit, project-discovered, and project-explicit precedence, while each domain owns collision resolution within a class. `/reload` rereads the saved theme preference; keybindings remain compiled in and do not reload.

## Consequences

- Session Hosts must be idle before reload; active turns, executions, queued Submissions, Steering Messages, and Plugin background work prevent it.
- Skills and Custom Commands are rediscovered from the refreshed ConfigRuntime. Project Instructions are read when the next Agent Turn is composed.
- Plugin factories register behavior without opening process-wide resources. `onStart` and `onShutdown` must support repeated activation and cleanup within one process.
- Theme choice is read again from its saved preference. File-backed keybinding and theme definitions are not introduced by this decision.
- The configured source-class precedence is shared; domain modules retain their own ordering and collision behavior inside each class.
