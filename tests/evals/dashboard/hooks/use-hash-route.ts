import { useEffect, useState } from "react";

type GlobalLocationEnv = typeof globalThis & {
	location?: { hash: string };
	window?: {
		addEventListener: (type: string, listener: () => void) => void;
		removeEventListener: (type: string, listener: () => void) => void;
	};
};

export function useHashRoute(): string {
	const g = globalThis as GlobalLocationEnv;
	const [hash, setHash] = useState(() => (g.location ? g.location.hash || "#/" : "#/"));
	useEffect(() => {
		const win = g.window;
		if (!win) return;
		const onChange = () => setHash(g.location ? g.location.hash || "#/" : "#/");
		win.addEventListener("hashchange", onChange);
		return () => win.removeEventListener("hashchange", onChange);
	}, []);
	return hash;
}
