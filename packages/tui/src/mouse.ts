export interface SgrMouseEvent {
	button: number;
	col: number;
	row: number;
	release: boolean;
	wheel: -1 | 1 | null;
	motion: boolean;
	leftClick: boolean;
}

export function parseSgrMouse(data: string): SgrMouseEvent | null {
	const match = /^\x1b\[<(\d+);(\d+);(\d+)([Mm])$/.exec(data);
	if (!match) return null;
	const button = Number(match[1]);
	const col = Number(match[2]) - 1;
	const row = Number(match[3]) - 1;
	const release = match[4] === "m";
	const wheel = button & 64 ? ((button & 1 ? 1 : -1) as 1 | -1) : null;
	const motion = (button & 32) !== 0 && wheel === null;
	const leftClick = !release && wheel === null && !motion && (button & 3) === 0;
	return { button, col, row, release, wheel, motion, leftClick };
}

export type SgrMouseHandler = (event: SgrMouseEvent) => boolean | undefined;

export function routeSgrMouseInput(data: string, handler: SgrMouseHandler): boolean {
	if (!data.startsWith("\x1b[<")) return false;
	const event = parseSgrMouse(data);
	if (!event) return false;
	return handler(event) !== false;
}

export interface SelectListMouseTarget {
	handleWheel(delta: -1 | 1): void;
	hitTest(line: number): number | undefined;
	setHoverIndex(index: number | null): void;
	clickItem(index: number): void;
}

export function routeSelectListMouse(target: SelectListMouseTarget, event: SgrMouseEvent, line: number): boolean {
	if (event.wheel !== null) {
		target.handleWheel(event.wheel);
		return true;
	}
	const index = target.hitTest(line);
	if (event.motion) {
		target.setHoverIndex(index ?? null);
		return true;
	}
	if (event.leftClick && index !== undefined) {
		target.clickItem(index);
		return true;
	}
	return false;
}

export interface MouseRoutable {
	routeMouse(event: SgrMouseEvent, line: number, col: number): void;
	wantsPointer?(): boolean;
}
