import { omitUndefined } from "@wincode/utils";
import { compareText } from "@/shared/utils/compare-text";
import type {
	PluginUI,
	PluginUIContributionResult,
	PluginUIFooterComponent,
	PluginUIHeaderComponent,
	PluginUIStatusContribution,
	PluginUIUpdate,
	PluginUIWidgetComponent,
	PluginUIWidgetContribution,
	PluginUIWidgetOptions,
	PluginUIWidgetPlacement,
	PluginUIWorkingIndicator,
} from "../public";

export type PluginUIViewContributions = Readonly<{
	hiddenThinkingLabel?: string;
	statuses: readonly PluginUIStatusContribution[];
	toolsExpanded?: boolean;
	widgets: readonly PluginUIWidgetContribution[];
	workingIndicator?: PluginUIWorkingIndicator;
	workingMessage?: string;
	workingVisible?: boolean;
}>;

export type PluginUITitleSnapshot = Readonly<{
	pluginId: string;
	value: string;
}> | null;

type PluginUIOwnedValue<Value> = Readonly<{
	pluginId: string;
	value: Value;
}>;

export type PluginUIChromeSnapshot = Readonly<{
	header: Readonly<{
		component: PluginUIHeaderComponent;
		pluginId: string;
		revision: number;
	}> | null;
	footer: Readonly<{
		component: PluginUIFooterComponent;
		pluginId: string;
		revision: number;
	}> | null;
}>;

export const EMPTY_PLUGIN_UI_VIEW: PluginUIViewContributions = Object.freeze({
	statuses: Object.freeze([]),
	widgets: Object.freeze([]),
});

export const EMPTY_PLUGIN_UI_CHROME: PluginUIChromeSnapshot = Object.freeze({
	header: null,
	footer: null,
});

const CONTRIBUTION_SUCCESS: PluginUIContributionResult = Object.freeze({
	success: true,
});

const contributionConflict = (
	surface: "header" | "footer"
): PluginUIContributionResult =>
	Object.freeze({
		code: "plugin_ui_contribution_conflict",
		success: false,
		surface,
	});

export type PluginUIContributionStore = Readonly<{
	clearPlugin: (pluginId: string) => readonly PluginUIUpdate[];
	clearView: (sessionId: string, pluginId: string) => readonly PluginUIUpdate[];
	close: () => void;
	getChromeSnapshot: () => PluginUIChromeSnapshot;
	getSnapshot: (sessionId: string) => PluginUIViewContributions;
	getTitle: () => PluginUITitleSnapshot;
	setFooter: (
		pluginId: string,
		component: PluginUIFooterComponent | undefined
	) => PluginUIContributionResult;
	setHeader: (
		pluginId: string,
		component: PluginUIHeaderComponent | undefined
	) => PluginUIContributionResult;
	setHiddenThinkingLabel: (
		sessionId: string,
		pluginId: string,
		label: string | undefined
	) => void;
	setTitle: (pluginId: string, title: string | undefined) => boolean;
	setToolsExpanded: (
		sessionId: string,
		pluginId: string,
		expanded: boolean
	) => void;
	setWorkingIndicator: (
		sessionId: string,
		pluginId: string,
		indicator: PluginUIWorkingIndicator | undefined
	) => void;
	setWorkingMessage: (
		sessionId: string,
		pluginId: string,
		message: string | undefined
	) => void;
	setWorkingVisible: (
		sessionId: string,
		pluginId: string,
		visible: boolean
	) => void;
	subscribeChrome: (listener: () => void) => () => void;
	subscribeTitle: (listener: () => void) => () => void;
	setStatus: (
		sessionId: string,
		pluginId: string,
		key: string,
		value: string | undefined
	) => void;
	setWidget: (
		sessionId: string,
		pluginId: string,
		key: string,
		content: readonly string[] | PluginUIWidgetComponent | undefined,
		placement: PluginUIWidgetPlacement
	) => void;
	subscribe: (sessionId: string, listener: () => void) => () => void;
}>;

type MutablePluginUIWidget =
	| Readonly<{
			component: PluginUIWidgetComponent;
			placement: PluginUIWidgetPlacement;
	  }>
	| Readonly<{
			lines: readonly string[];
			placement: PluginUIWidgetPlacement;
	  }>;

type MutablePluginUIView = {
	hiddenThinkingLabel: PluginUIOwnedValue<string> | undefined;
	statuses: Map<string, Map<string, string>>;
	toolsExpanded: PluginUIOwnedValue<boolean> | undefined;
	widgets: Map<string, Map<string, MutablePluginUIWidget>>;
	workingIndicator: PluginUIOwnedValue<PluginUIWorkingIndicator> | undefined;
	workingMessage: PluginUIOwnedValue<string> | undefined;
	workingVisible: PluginUIOwnedValue<boolean> | undefined;
};

const isWidgetComponent = (
	content: readonly string[] | PluginUIWidgetComponent
): content is PluginUIWidgetComponent => typeof content === "function";

const sameLines = (
	left: readonly string[],
	right: readonly string[]
): boolean =>
	left.length === right.length &&
	left.every((line, index) => line === right[index]);

const setWidgetValue = (
	ownerWidgets: Map<string, MutablePluginUIWidget>,
	key: string,
	content: readonly string[] | PluginUIWidgetComponent,
	placement: PluginUIWidgetPlacement
): boolean => {
	const current = ownerWidgets.get(key);
	if (isWidgetComponent(content)) {
		if (
			current !== undefined &&
			"component" in current &&
			current.component === content &&
			current.placement === placement
		) {
			return false;
		}
		ownerWidgets.set(key, Object.freeze({ component: content, placement }));
		return true;
	}
	const copiedLines = Object.freeze([...content]);
	if (
		current !== undefined &&
		"lines" in current &&
		current.placement === placement &&
		sameLines(current.lines, copiedLines)
	) {
		return false;
	}
	ownerWidgets.set(key, Object.freeze({ lines: copiedLines, placement }));
	return true;
};

const createSnapshot = (
	view: MutablePluginUIView | undefined
): PluginUIViewContributions => {
	if (view === undefined) {
		return EMPTY_PLUGIN_UI_VIEW;
	}
	const statuses = [...view.statuses.entries()]
		.flatMap(([pluginId, values]) =>
			[...values.entries()].map(([key, value]) =>
				Object.freeze({ key, pluginId, value })
			)
		)
		.sort(
			(left, right) =>
				compareText(left.pluginId, right.pluginId) ||
				compareText(left.key, right.key)
		);
	const widgets = [...view.widgets.entries()]
		.flatMap(([pluginId, values]) =>
			[...values.entries()].map(([key, value]) =>
				Object.freeze({
					key,
					placement: value.placement,
					pluginId,
					...("lines" in value
						? { lines: value.lines }
						: { component: value.component }),
				})
			)
		)
		.sort(
			(left, right) =>
				compareText(left.pluginId, right.pluginId) ||
				compareText(left.key, right.key)
		);
	if (
		statuses.length === 0 &&
		widgets.length === 0 &&
		view.hiddenThinkingLabel === undefined &&
		view.toolsExpanded === undefined &&
		view.workingIndicator === undefined &&
		view.workingMessage === undefined &&
		view.workingVisible === undefined
	) {
		return EMPTY_PLUGIN_UI_VIEW;
	}
	return Object.freeze({
		statuses: Object.freeze(statuses),
		widgets: Object.freeze(widgets),
		...omitUndefined({
			hiddenThinkingLabel: view.hiddenThinkingLabel?.value,
			toolsExpanded: view.toolsExpanded?.value,
			workingIndicator: view.workingIndicator?.value,
			workingMessage: view.workingMessage?.value,
			workingVisible: view.workingVisible?.value,
		}),
	});
};

const resetUpdatesForPluginView = (
	pluginId: string,
	view: MutablePluginUIView
): PluginUIUpdate[] => {
	const updates: PluginUIUpdate[] = [];
	for (const key of view.statuses.get(pluginId)?.keys() ?? []) {
		updates.push(Object.freeze({ type: "status", pluginId, key, value: null }));
	}
	for (const [key, widget] of view.widgets.get(pluginId) ?? []) {
		if (!("lines" in widget)) {
			continue;
		}
		updates.push(
			Object.freeze({
				type: "widget",
				pluginId,
				key,
				value: null,
				placement: widget.placement,
			})
		);
	}
	return updates;
};

export const createPluginUIContributionStore =
	(): PluginUIContributionStore => {
		const views = new Map<string, MutablePluginUIView>();
		const snapshots = new Map<string, PluginUIViewContributions>();
		const listeners = new Map<string, Set<() => void>>();
		const chromeListeners = new Set<() => void>();
		const titleListeners = new Set<() => void>();
		let titleSnapshot: PluginUITitleSnapshot = null;
		let header: PluginUIChromeSnapshot["header"] = null;
		let footer: PluginUIChromeSnapshot["footer"] = null;
		let chromeRevision = 0;
		let chromeSnapshot = EMPTY_PLUGIN_UI_CHROME;
		const publishChrome = (): void => {
			chromeSnapshot =
				header === null && footer === null
					? EMPTY_PLUGIN_UI_CHROME
					: Object.freeze({ header, footer });
			for (const listener of [...chromeListeners]) {
				listener();
			}
		};
		const publishTitle = (): void => {
			for (const listener of [...titleListeners]) {
				listener();
			}
		};
		const publish = (sessionId: string): void => {
			const snapshot = createSnapshot(views.get(sessionId));
			if (snapshot === EMPTY_PLUGIN_UI_VIEW) {
				snapshots.delete(sessionId);
			} else {
				snapshots.set(sessionId, snapshot);
			}
			for (const listener of [...(listeners.get(sessionId) ?? [])]) {
				listener();
			}
		};
		const viewFor = (sessionId: string): MutablePluginUIView => {
			let view = views.get(sessionId);
			if (view === undefined) {
				view = {
					hiddenThinkingLabel: undefined,
					statuses: new Map(),
					toolsExpanded: undefined,
					widgets: new Map(),
					workingIndicator: undefined,
					workingMessage: undefined,
					workingVisible: undefined,
				};
				views.set(sessionId, view);
			}
			return view;
		};
		const removeEmptyOwner = <Value>(
			values: Map<string, Map<string, Value>>,
			pluginId: string
		): void => {
			const ownerValues = values.get(pluginId);
			if (ownerValues?.size === 0) {
				values.delete(pluginId);
			}
		};
		const removeEmptyView = (
			sessionId: string,
			view: MutablePluginUIView
		): void => {
			if (
				view.statuses.size === 0 &&
				view.widgets.size === 0 &&
				view.hiddenThinkingLabel === undefined &&
				view.toolsExpanded === undefined &&
				view.workingIndicator === undefined &&
				view.workingMessage === undefined &&
				view.workingVisible === undefined
			) {
				views.delete(sessionId);
			}
		};
		const clearOwnedControls = (
			view: MutablePluginUIView,
			pluginId: string
		): boolean => {
			let changed = false;
			if (view.hiddenThinkingLabel?.pluginId === pluginId) {
				view.hiddenThinkingLabel = undefined;
				changed = true;
			}
			if (view.toolsExpanded?.pluginId === pluginId) {
				view.toolsExpanded = undefined;
				changed = true;
			}
			if (view.workingIndicator?.pluginId === pluginId) {
				view.workingIndicator = undefined;
				changed = true;
			}
			if (view.workingMessage?.pluginId === pluginId) {
				view.workingMessage = undefined;
				changed = true;
			}
			if (view.workingVisible?.pluginId === pluginId) {
				view.workingVisible = undefined;
				changed = true;
			}
			return changed;
		};
		const setOwnedControl = <Value>(
			sessionId: string,
			pluginId: string,
			value: Value | undefined,
			getCurrent: (
				view: MutablePluginUIView
			) => PluginUIOwnedValue<Value> | undefined,
			setCurrent: (
				view: MutablePluginUIView,
				current: PluginUIOwnedValue<Value> | undefined
			) => void
		): void => {
			const view = viewFor(sessionId);
			const current = getCurrent(view);
			if (value === undefined && current?.pluginId !== pluginId) {
				return;
			}
			if (
				value !== undefined &&
				current?.pluginId === pluginId &&
				Object.is(current.value, value)
			) {
				return;
			}
			setCurrent(
				view,
				value === undefined ? undefined : Object.freeze({ pluginId, value })
			);
			removeEmptyView(sessionId, view);
			publish(sessionId);
		};
		const setHeader = (
			pluginId: string,
			component: PluginUIHeaderComponent | undefined
		): PluginUIContributionResult => {
			if (component === undefined) {
				if (header === null) {
					return CONTRIBUTION_SUCCESS;
				}
				if (header.pluginId !== pluginId) {
					return contributionConflict("header");
				}
				header = null;
				publishChrome();
				return CONTRIBUTION_SUCCESS;
			}
			if (header !== null && header.pluginId !== pluginId) {
				return contributionConflict("header");
			}
			if (header?.component === component) {
				return CONTRIBUTION_SUCCESS;
			}
			header = Object.freeze({
				component,
				pluginId,
				revision: ++chromeRevision,
			});
			publishChrome();
			return CONTRIBUTION_SUCCESS;
		};
		const setTitle = (pluginId: string, value: string | undefined): boolean => {
			if (value === undefined) {
				if (titleSnapshot?.pluginId !== pluginId) {
					return false;
				}
				titleSnapshot = null;
				publishTitle();
				return true;
			}
			if (
				titleSnapshot?.pluginId === pluginId &&
				titleSnapshot.value === value
			) {
				return true;
			}
			titleSnapshot = Object.freeze({ pluginId, value });
			publishTitle();
			return true;
		};
		const setFooter = (
			pluginId: string,
			component: PluginUIFooterComponent | undefined
		): PluginUIContributionResult => {
			if (component === undefined) {
				if (footer === null) {
					return CONTRIBUTION_SUCCESS;
				}
				if (footer.pluginId !== pluginId) {
					return contributionConflict("footer");
				}
				footer = null;
				publishChrome();
				return CONTRIBUTION_SUCCESS;
			}
			if (footer !== null && footer.pluginId !== pluginId) {
				return contributionConflict("footer");
			}
			if (footer?.component === component) {
				return CONTRIBUTION_SUCCESS;
			}
			footer = Object.freeze({
				component,
				pluginId,
				revision: ++chromeRevision,
			});
			publishChrome();
			return CONTRIBUTION_SUCCESS;
		};

		return Object.freeze({
			clearPlugin(pluginId) {
				const updates: PluginUIUpdate[] = [];
				for (const [sessionId, view] of views) {
					updates.push(...resetUpdatesForPluginView(pluginId, view));
					const statusesChanged = view.statuses.delete(pluginId);
					const widgetsChanged = view.widgets.delete(pluginId);
					const controlsChanged = clearOwnedControls(view, pluginId);
					if (statusesChanged || widgetsChanged || controlsChanged) {
						removeEmptyView(sessionId, view);
						publish(sessionId);
					}
				}
				let chromeChanged = false;
				if (header?.pluginId === pluginId) {
					header = null;
					chromeChanged = true;
				}
				if (footer?.pluginId === pluginId) {
					footer = null;
					chromeChanged = true;
				}
				if (chromeChanged) {
					publishChrome();
				}
				if (titleSnapshot?.pluginId === pluginId) {
					titleSnapshot = null;
					updates.push(Object.freeze({ type: "title", pluginId, value: null }));
					publishTitle();
				}
				return Object.freeze(updates);
			},
			clearView(sessionId, pluginId) {
				const view = views.get(sessionId);
				if (view === undefined) {
					return Object.freeze([]);
				}
				const updates = resetUpdatesForPluginView(pluginId, view);
				const statusesChanged = view.statuses.delete(pluginId);
				const widgetsChanged = view.widgets.delete(pluginId);
				const controlsChanged = clearOwnedControls(view, pluginId);
				if (!(statusesChanged || widgetsChanged || controlsChanged)) {
					return Object.freeze(updates);
				}
				removeEmptyView(sessionId, view);
				publish(sessionId);
				return Object.freeze(updates);
			},
			close() {
				const sessionIds = new Set([...views.keys(), ...snapshots.keys()]);
				views.clear();
				snapshots.clear();
				for (const sessionId of sessionIds) {
					publish(sessionId);
				}
				if (titleSnapshot !== null) {
					titleSnapshot = null;
					publishTitle();
				}
				if (header !== null || footer !== null) {
					header = null;
					footer = null;
					publishChrome();
				}
			},
			getChromeSnapshot: () => chromeSnapshot,
			getSnapshot: (sessionId) =>
				snapshots.get(sessionId) ?? EMPTY_PLUGIN_UI_VIEW,
			getTitle: () => titleSnapshot,
			setFooter,
			setHeader,
			setHiddenThinkingLabel(sessionId, pluginId, label) {
				setOwnedControl(
					sessionId,
					pluginId,
					label,
					(view) => view.hiddenThinkingLabel,
					(view, current) => {
						view.hiddenThinkingLabel = current;
					}
				);
			},
			setTitle,
			setToolsExpanded(sessionId, pluginId, expanded) {
				setOwnedControl(
					sessionId,
					pluginId,
					expanded,
					(view) => view.toolsExpanded,
					(view, current) => {
						view.toolsExpanded = current;
					}
				);
			},
			setWorkingIndicator(sessionId, pluginId, indicator) {
				const copiedIndicator =
					indicator === undefined
						? undefined
						: Object.freeze({
								...indicator,
								frames: Object.freeze([...indicator.frames]),
							});
				setOwnedControl(
					sessionId,
					pluginId,
					copiedIndicator,
					(view) => view.workingIndicator,
					(view, current) => {
						view.workingIndicator = current;
					}
				);
			},
			setWorkingMessage(sessionId, pluginId, message) {
				setOwnedControl(
					sessionId,
					pluginId,
					message,
					(view) => view.workingMessage,
					(view, current) => {
						view.workingMessage = current;
					}
				);
			},
			setWorkingVisible(sessionId, pluginId, visible) {
				setOwnedControl(
					sessionId,
					pluginId,
					visible,
					(view) => view.workingVisible,
					(view, current) => {
						view.workingVisible = current;
					}
				);
			},
			subscribeChrome(listener) {
				chromeListeners.add(listener);
				return () => chromeListeners.delete(listener);
			},
			setStatus(sessionId, pluginId, key, value) {
				const view = viewFor(sessionId);
				let ownerStatuses = view.statuses.get(pluginId);
				if (value === undefined) {
					if (ownerStatuses?.delete(key) !== true) {
						return;
					}
					removeEmptyOwner(view.statuses, pluginId);
				} else {
					if (ownerStatuses === undefined) {
						ownerStatuses = new Map();
						view.statuses.set(pluginId, ownerStatuses);
					}
					if (ownerStatuses.get(key) === value) {
						return;
					}
					ownerStatuses.set(key, value);
				}
				removeEmptyView(sessionId, view);
				publish(sessionId);
			},
			setWidget(sessionId, pluginId, key, content, placement) {
				const view = viewFor(sessionId);
				let ownerWidgets = view.widgets.get(pluginId);
				if (content === undefined) {
					if (ownerWidgets?.delete(key) !== true) {
						return;
					}
					removeEmptyOwner(view.widgets, pluginId);
				} else {
					if (ownerWidgets === undefined) {
						ownerWidgets = new Map();
						view.widgets.set(pluginId, ownerWidgets);
					}
					if (!setWidgetValue(ownerWidgets, key, content, placement)) {
						return;
					}
				}
				removeEmptyView(sessionId, view);
				publish(sessionId);
			},
			subscribeTitle(listener) {
				titleListeners.add(listener);
				return () => titleListeners.delete(listener);
			},
			subscribe(sessionId, listener) {
				let viewListeners = listeners.get(sessionId);
				if (viewListeners === undefined) {
					viewListeners = new Set();
					listeners.set(sessionId, viewListeners);
				}
				viewListeners.add(listener);
				return () => {
					viewListeners?.delete(listener);
					if (viewListeners?.size === 0) {
						listeners.delete(sessionId);
					}
				};
			},
		});
	};

export type PluginUIUpdateSink = (update: PluginUIUpdate) => void;

export const createPluginUIUpdateControls = (
	pluginId: string,
	publish: PluginUIUpdateSink,
	textWidgetKeys: Set<string> = new Set()
): Pick<PluginUI, "setStatus" | "setWidget" | "setTitle"> =>
	Object.freeze({
		setStatus(key, value) {
			publish(
				Object.freeze({
					type: "status",
					pluginId,
					key,
					value: value ?? null,
				})
			);
		},
		setWidget(key, content, options?: PluginUIWidgetOptions) {
			if (Array.isArray(content)) {
				textWidgetKeys.add(key);
			} else if (content !== undefined && !textWidgetKeys.delete(key)) {
				return;
			} else if (content === undefined) {
				textWidgetKeys.delete(key);
			}
			publish(
				Object.freeze({
					type: "widget",
					pluginId,
					key,
					value: Array.isArray(content) ? Object.freeze([...content]) : null,
					placement: options?.placement ?? "aboveEditor",
				})
			);
		},
		setTitle(value) {
			publish(Object.freeze({ type: "title", pluginId, value: value ?? null }));
		},
	});
