import { Component, type ErrorInfo, type ReactNode } from "react";
import { logUnhandledUiError } from "@/shared/utils/ui-error-log";

type ErrorBoundaryState = {
	error: unknown;
	hasError: boolean;
};

type ErrorBoundaryProps = {
	children: ReactNode;
	renderFallback: (args: { error: unknown; reset: () => void }) => ReactNode;
};

/**
 * Root render boundary: catches errors that no route-level boundary owns
 * (providers and chrome outside the router). Debug mode rethrows through the
 * fallback so the raw stack surfaces instead of a polished screen.
 */
export class ErrorBoundary extends Component<
	ErrorBoundaryProps,
	ErrorBoundaryState
> {
	override state: ErrorBoundaryState = { error: null, hasError: false };

	static getDerivedStateFromError(error: unknown): ErrorBoundaryState {
		return { error, hasError: true };
	}

	override componentDidCatch(error: unknown, info: ErrorInfo): void {
		logUnhandledUiError(error, "root", info.componentStack);
	}

	reset = (): void => {
		this.setState({ error: null, hasError: false });
	};

	override render(): ReactNode {
		if (this.state.hasError) {
			return this.props.renderFallback({
				error: this.state.error,
				reset: this.reset,
			});
		}
		return this.props.children;
	}
}
