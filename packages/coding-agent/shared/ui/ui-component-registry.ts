import type { CliRenderer, MouseEvent, Renderable } from "@opentui/core";
import { useFocus, useRenderer } from "@opentui/react";
import { useCallback, useMemo } from "react";
import { useKeyboardLayer } from "@/shared/providers/keyboard-layer/keyboard-layer-provider";

const EMPTY_BACKGROUND_COMPONENT_IDS: readonly string[] = [];

type UiComponentFocusOptions = {
	backgroundComponentIds?: readonly string[];
	componentId: string;
	enabled?: boolean;
	scopeId: string;
};
type UiComponentAncestorMatch = "background" | "focusable-control" | "scope";

export class UiComponentRegistry {
	readonly #backgroundComponentIds: readonly string[];
	readonly #renderer: CliRenderer;
	readonly #scopeId: string;

	constructor(
		renderer: CliRenderer,
		scopeId: string,
		backgroundComponentIds: readonly string[] = EMPTY_BACKGROUND_COMPONENT_IDS
	) {
		this.#backgroundComponentIds = backgroundComponentIds;
		this.#renderer = renderer;
		this.#scopeId = scopeId;
	}

	find(componentId: string): Renderable | undefined {
		return this.#getScope()?.findDescendantById(componentId);
	}
	contains(renderable: Renderable | null): boolean {
		const scope = this.#getScope();
		return (
			scope !== undefined &&
			renderable !== null &&
			this.#hasScopedAncestor(renderable, scope, "scope")
		);
	}

	isBackground(renderable: Renderable | null): boolean {
		const scope = this.#getScope();
		if (!(scope && renderable)) {
			return false;
		}
		if (
			renderable.focusable &&
			!this.#backgroundComponentIds.includes(renderable.id)
		) {
			return false;
		}

		return this.#hasScopedAncestor(renderable, scope, "background");
	}

	hasFocusableControl(renderable: Renderable | null): boolean {
		const scope = this.#getScope();
		return (
			scope !== undefined &&
			renderable !== null &&
			this.#hasScopedAncestor(renderable, scope, "focusable-control")
		);
	}

	#getScope(): Renderable | undefined {
		return this.#renderer.root.findDescendantById(this.#scopeId);
	}

	#hasScopedAncestor(
		renderable: Renderable,
		scope: Renderable,
		match: UiComponentAncestorMatch
	): boolean {
		let matched = false;
		for (
			let current: Renderable | null = renderable;
			current;
			current = current.parent
		) {
			if (current === scope) {
				return match === "scope" || matched;
			}
			if (
				(match === "background" &&
					this.#backgroundComponentIds.includes(current.id)) ||
				(match === "focusable-control" &&
					current.focusable &&
					!this.#backgroundComponentIds.includes(current.id))
			) {
				matched = true;
			}
		}
		return false;
	}
}

type UiComponentFocusHandlers = {
	onMouseDown: (event: MouseEvent) => void;
	onMouseMove: () => void;
};

export function useUiComponentFocus({
	backgroundComponentIds = EMPTY_BACKGROUND_COMPONENT_IDS,
	componentId,
	enabled = true,
	scopeId,
}: UiComponentFocusOptions): UiComponentFocusHandlers {
	const renderer = useRenderer();
	const { isTopLayer } = useKeyboardLayer();
	const registry = useMemo(
		() => new UiComponentRegistry(renderer, scopeId, backgroundComponentIds),
		[backgroundComponentIds, renderer, scopeId]
	);
	const isComposerLayerActive =
		enabled && (isTopLayer("base") || isTopLayer("command"));
	const focusComponent = useCallback(() => {
		if (!isComposerLayerActive) {
			return;
		}

		const component = registry.find(componentId);
		const focusedRenderable = renderer.currentFocusedRenderable;
		if (
			component &&
			focusedRenderable !== component &&
			(focusedRenderable === null || registry.isBackground(focusedRenderable))
		) {
			component.focus();
		}
	}, [componentId, isComposerLayerActive, registry, renderer]);
	const handleMouseDown = useCallback(
		(event: MouseEvent) => {
			if (
				!registry.contains(event.target) ||
				registry.hasFocusableControl(event.target)
			) {
				return;
			}

			if (!(enabled && isTopLayer("base"))) {
				event.preventDefault();
				return;
			}

			const component = registry.find(componentId);
			event.preventDefault();
			if (component && renderer.currentFocusedRenderable !== component) {
				component.focus();
			}
		},
		[componentId, enabled, isTopLayer, registry, renderer]
	);

	useFocus(focusComponent);
	return {
		onMouseDown: handleMouseDown,
		onMouseMove: focusComponent,
	};
}
