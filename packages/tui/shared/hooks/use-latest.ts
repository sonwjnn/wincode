import type { MutableRefObject } from "react";
import { useRef } from "react";

type UseLatest = <T>(value: T) => MutableRefObject<T>;

export const useLatest: UseLatest = <T>(value: T): MutableRefObject<T> => {
	const ref = useRef(value);
	ref.current = value;
	return ref;
};
