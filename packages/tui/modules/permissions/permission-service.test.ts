import { describe, expect, test } from "bun:test";
import { createPermissionService } from "./permission-service";

describe("createPermissionService", () => {
	test("auto approval is off by default and toggles", () => {
		const service = createPermissionService();
		expect(service.isAutoApproval()).toBe(false);
		service.setAutoApproval(true);
		expect(service.isAutoApproval()).toBe(true);
		service.setAutoApproval(false);
		expect(service.isAutoApproval()).toBe(false);
	});

	test("may be initialized with auto approval enabled", () => {
		expect(
			createPermissionService({ autoApproval: true }).isAutoApproval()
		).toBe(true);
	});

	test("grants only the exact evaluated action and resource", () => {
		const service = createPermissionService();
		service.grant("edit", "src/app.ts");

		expect(service.isGranted("edit", "src/app.ts")).toBe(true);
		// A sibling resource under the same action is not covered.
		expect(service.isGranted("edit", "src/other.ts")).toBe(false);
		// The same resource under a different action is not covered.
		expect(service.isGranted("read", "src/app.ts")).toBe(false);
	});

	test("a wildcard grant covers every resource for its action only", () => {
		const service = createPermissionService();
		service.grant("shell", "*");

		expect(service.isGranted("shell", "bun test")).toBe(true);
		expect(service.isGranted("shell", "rm dist")).toBe(true);
		// The wildcard never crosses actions.
		expect(service.isGranted("read", "package.json")).toBe(false);
		// The exact grant is stored verbatim.
		expect(service.listGrants()).toEqual([{ action: "shell", resource: "*" }]);
	});

	test("an exact grant outranks nothing but the same key and the wildcard", () => {
		const service = createPermissionService();
		service.grant("edit", "*");

		expect(service.isGranted("edit", "anything")).toBe(true);
		service.grant("edit", "src/app.ts");
		expect(service.isGranted("edit", "src/app.ts")).toBe(true);
	});

	test("lists grants by action then resource and revoking removes one", () => {
		const service = createPermissionService();
		service.grant("edit", "src/b.ts");
		service.grant("edit", "src/a.ts");
		service.grant("read", ".env");

		expect(service.listGrants()).toEqual([
			{ action: "edit", resource: "src/a.ts" },
			{ action: "edit", resource: "src/b.ts" },
			{ action: "read", resource: ".env" },
		]);

		service.revoke("edit", "src/a.ts");
		expect(service.listGrants()).toEqual([
			{ action: "edit", resource: "src/b.ts" },
			{ action: "read", resource: ".env" },
		]);
		expect(service.isGranted("edit", "src/a.ts")).toBe(false);
	});

	test("granting the same pair twice does not duplicate", () => {
		const service = createPermissionService();
		service.grant("edit", "src/app.ts");
		service.grant("edit", "src/app.ts");
		expect(service.listGrants()).toHaveLength(1);
	});

	test("notifies subscribers on grant, revoke, and auto changes only", () => {
		const service = createPermissionService();
		let notifications = 0;
		const unsubscribe = service.subscribe(() => {
			notifications += 1;
		});

		service.grant("edit", "a.ts");
		service.grant("edit", "a.ts"); // duplicate: no notification
		service.setAutoApproval(true);
		service.setAutoApproval(true); // unchanged: no notification
		service.revoke("edit", "a.ts");
		service.revoke("edit", "a.ts"); // absent: no notification

		expect(notifications).toBe(3);

		unsubscribe();
		service.grant("read", "b.ts");
		expect(notifications).toBe(3);
	});

	test("two services are isolated across workspaces and processes", () => {
		const workspaceA = createPermissionService();
		const workspaceB = createPermissionService();

		workspaceA.grant("edit", "src/app.ts");
		workspaceA.setAutoApproval(true);

		expect(workspaceB.isGranted("edit", "src/app.ts")).toBe(false);
		expect(workspaceB.listGrants()).toEqual([]);
		expect(workspaceB.isAutoApproval()).toBe(false);
	});
});
