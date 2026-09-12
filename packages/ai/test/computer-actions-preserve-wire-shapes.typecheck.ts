/**
 * Compile-time wire contracts for both computer-action surfaces.
 * The explicit shape map rejects changed fields, optionality, and new variants.
 * Declaration-merging isolation is verified separately in an isolated compiler program.
 */
import type { ComputerAction, ResponseComputerToolCall } from "../src/providers/openai-responses-wire";

type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
type Assert<T extends true> = T;
type Fields<T> = { [K in keyof T]: T[K] };

interface Point {
	x: number;
	y: number;
}

interface ExpectedActions {
	click: {
		button: "left" | "right" | "wheel" | "back" | "forward";
		type: "click";
		x: number;
		y: number;
		keys?: string[] | null;
	};
	double_click: {
		keys: string[] | null;
		type: "double_click";
		x: number;
		y: number;
	};
	drag: {
		path: Point[];
		type: "drag";
		keys?: string[] | null;
	};
	keypress: {
		keys: string[];
		type: "keypress";
	};
	move: {
		type: "move";
		x: number;
		y: number;
		keys?: string[] | null;
	};
	screenshot: { type: "screenshot" };
	scroll: {
		scroll_x: number;
		scroll_y: number;
		type: "scroll";
		x: number;
		y: number;
		keys?: string[] | null;
	};
	type: {
		text: string;
		type: "type";
	};
	wait: { type: "wait" };
}

type MatchesShapes<Action> = {
	[Kind in keyof ExpectedActions]: Equal<Fields<Extract<Action, { type: Kind }>>, ExpectedActions[Kind]>;
}[keyof ExpectedActions];
type SingleAction = NonNullable<ResponseComputerToolCall["action"]>;

export type BatchedKinds = Assert<Equal<ComputerAction["type"], keyof ExpectedActions>>;
export type SingleKinds = Assert<Equal<SingleAction["type"], keyof ExpectedActions>>;
export type BatchedShapes = Assert<MatchesShapes<ComputerAction>>;
export type SingleShapes = Assert<MatchesShapes<SingleAction>>;
export type BatchedDragPath = Assert<Equal<Fields<ComputerAction.Drag.Path>, Point>>;
export type SingleDragPath = Assert<Equal<Fields<ResponseComputerToolCall.Drag.Path>, Point>>;
