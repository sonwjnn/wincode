import { isNull } from "@wincode/runtime-utils";
import {
	createContext,
	createElement,
	type ReactNode,
	useContext,
} from "react";
import type { CommandControllerFactory } from "./command-controller";

const CommandControllerFactoryContext =
	createContext<CommandControllerFactory | null>(null);

export function CommandControllerFactoryProvider({
	children,
	factory,
}: {
	children: ReactNode;
	factory: CommandControllerFactory;
}) {
	return createElement(CommandControllerFactoryContext.Provider, {
		children,
		value: factory,
	});
}

export function useCommandControllerFactory(): CommandControllerFactory {
	const factory = useContext(CommandControllerFactoryContext);
	if (isNull(factory)) {
		throw new Error(
			"useCommandControllerFactory must be used within a CommandControllerFactoryProvider"
		);
	}
	return factory;
}
