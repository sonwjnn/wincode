type SelectionCopyRequestHandler = () => boolean;

const handlers = new Set<SelectionCopyRequestHandler>();

/**
 * Asks the active selection owner to copy the current selection. Returns true
 * when a handler consumed the request, so the root mouse handler can stop the
 * event from continuing through the render tree.
 */
export const requestSelectionCopy = (): boolean => {
	for (const handler of handlers) {
		if (handler()) {
			return true;
		}
	}
	return false;
};

export const subscribeSelectionCopyRequest = (
	handler: SelectionCopyRequestHandler
): (() => void) => {
	handlers.add(handler);
	return () => {
		handlers.delete(handler);
	};
};
