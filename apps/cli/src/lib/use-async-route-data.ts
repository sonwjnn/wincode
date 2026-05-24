import { type DependencyList, useEffect, useState } from "react";

export type AsyncRouteDataState<TData> =
	| { message: string; status: "error" }
	| { status: "loading" }
	| { data: TData; status: "ready" };

type UseAsyncRouteDataOptions<TData> = {
	deps: DependencyList;
	errorMessage: string;
	load: () => Promise<TData>;
};

const getErrorMessage = (error: unknown, fallback: string) =>
	error instanceof Error ? error.message : fallback;

export function useAsyncRouteData<TData>({
	deps,
	errorMessage,
	load,
}: UseAsyncRouteDataOptions<TData>): AsyncRouteDataState<TData> {
	const [state, setState] = useState<AsyncRouteDataState<TData>>({
		status: "loading",
	});

	useEffect(() => {
		let isActive = true;
		setState({ status: "loading" });

		load()
			.then((data) => {
				if (isActive) {
					setState({ data, status: "ready" });
				}
			})
			.catch((error: unknown) => {
				if (isActive) {
					setState({
						message: getErrorMessage(error, errorMessage),
						status: "error",
					});
				}
			});

		return () => {
			isActive = false;
		};
		// biome-ignore lint/correctness/useExhaustiveDependencies: caller owns route-data reload deps.
	}, deps);

	return state;
}
