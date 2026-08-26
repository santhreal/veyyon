import { type RefObject, useEffect, useRef, useState } from "react";

interface ResizeObserverEntryLike {
	contentRect: { width: number };
}

type GlobalResizeObserverEnv = typeof globalThis & {
	ResizeObserver?: new (
		callback: (entries: ResizeObserverEntryLike[]) => void,
	) => {
		observe: (target: unknown) => void;
		disconnect: () => void;
	};
};

/** Width of a container tracked through resizes; charts render in pixel space. */
export function useMeasuredWidth(): [RefObject<HTMLDivElement | null>, number] {
	const ref = useRef<HTMLDivElement | null>(null);
	const [width, setWidth] = useState(0);
	useEffect(() => {
		const el = ref.current;
		const Observer = (globalThis as GlobalResizeObserverEnv).ResizeObserver;
		if (!el || !Observer) return;
		const observer = new Observer(entries => setWidth(entries[0].contentRect.width));
		observer.observe(el);
		return () => observer.disconnect();
	}, []);
	return [ref, width];
}
