import type { SessionId } from "../../shared/identifiers";

export type SessionBundleFile = Readonly<{
	byteLength: number;
	path: string;
	sha256: string;
}>;

export type SessionBundleAttachment = Readonly<{
	attachmentId: string;
	byteLength: number;
	filename: string;
	height?: number;
	mediaType: string;
	path: string;
	sha256: string;
	width?: number;
}>;

export type SessionBundleCut = Readonly<{
	hash: string;
	sequence: number;
}>;

export type SessionBundleExportScope = "tree" | "branch";

export type SessionBundleManifest = Readonly<{
	attachments: readonly SessionBundleAttachment[];
	cut: SessionBundleCut;
	format: "wincode-session-bundle";
	scope: SessionBundleExportScope;
	session: Readonly<{ id: string; logId: string }>;
	sessionFile: SessionBundleFile & Readonly<{ path: "session.jsonl" }>;
	source?: Readonly<{
		activeLeafId?: string | null;
		sourceSessionId?: string;
		workspacePath?: string;
	}>;
	version: 2;
}>;

export type SessionBundleExportResult = Readonly<{
	destination: string;
	manifest: SessionBundleManifest;
	sessionId: SessionId;
	status: "exported";
}>;

export type SessionBundleImportResult = Readonly<{
	activationPending: boolean;
	sessionId: SessionId;
	status: "imported" | "unchanged";
}>;

export type SessionBundleExportOptions = Readonly<{
	scope?: SessionBundleExportScope;
	signal?: AbortSignal;
}>;

export type SessionBundleImportOptions = Readonly<{
	signal?: AbortSignal;
}>;
