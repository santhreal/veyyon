export type Easing = (t: number) => number;

export const linear: Easing = t => t;
export const easeOutCubic: Easing = t => 1 - (1 - t) ** 3;
export const easeOutQuint: Easing = t => 1 - (1 - t) ** 5;
export const easeInOutCubic: Easing = t => (t < 0.5 ? 4 * t ** 3 : 1 - (-2 * t + 2) ** 3 / 2);
export const easeInCubic: Easing = t => t ** 3;

export interface SpringSpec {
	stiffness: number;
	damping: number;
	mass?: number;
	restDelta?: number;
}

export const MOTION = {
	enter: { duration: 260, easing: easeOutQuint },
	hover: { duration: 90, easing: easeOutCubic },
	expand: { duration: 180, easing: easeOutQuint },
	reflow: { duration: 320, easing: easeInOutCubic },
	move: { spring: { stiffness: 260, damping: 30, mass: 1 } },
	settle: { spring: { stiffness: 170, damping: 26, mass: 1 } },
} as const satisfies Record<string, AnimationCurve>;

export type AnimationCurve = { duration: number; easing: Easing } | { spring: SpringSpec };

export interface AnimationSpec {
	from?: number;
	to: number;
	onFrame?: (value: number) => void;
	onDone?: () => void;
}

export const DEFAULT_REST_DELTA = 0.005;
export const FRAME_MS = 1000 / 60;
export const MAX_FRAME_MS = 100;
export const MAX_MOTION_MS = 4000;

export function isPositiveFinite(value: number): boolean {
	return Number.isFinite(value) && value > 0;
}

export function curveSettles(curve: AnimationCurve): boolean {
	if (!("spring" in curve)) return Number.isFinite(curve.duration);
	const { stiffness, damping, mass = 1, restDelta = DEFAULT_REST_DELTA } = curve.spring;
	if (
		!isPositiveFinite(stiffness) ||
		!isPositiveFinite(damping) ||
		!isPositiveFinite(mass) ||
		!isPositiveFinite(restDelta)
	) {
		return false;
	}
	return (FRAME_MS / 1000) * Math.sqrt(stiffness / mass) < 2;
}
