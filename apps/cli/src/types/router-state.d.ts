import "@tanstack/history";

declare module "@tanstack/history" {
	// biome-ignore lint/style/useConsistentTypeDefinitions: Module augmentation must merge interface.
	interface HistoryState {
		input?: string;
	}
}
