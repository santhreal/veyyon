import * as fs from "node:fs";

export function startupMarker(text: string): void {
	if (!process.env.VEYYON_DEBUG_STARTUP) return;
	try {
		fs.writeSync(2, `[startup] ${text}\n`);
	} catch {}
}
