/**
 * `runtime`: one tool over two subsystems — kernel cells (`op: "exec"`) and
 * process supervision (`start`, `list`, `logs`, `wait`, `send`, `stop`,
 * `restart`, `describe`).
 *
 * Its details are the eval details or the launch details, never a shape of its
 * own, so this renderer routes to the renderer that owns the payload instead of
 * re-describing either. A dispatcher with its own layout would drift from both.
 *
 * `args` arrives as plain JSON and may be partial while the call streams: `op`
 * can be absent before the argument object closes, so the code/language fields
 * decide the arm in that window.
 */

import type { ToolRenderer, ToolRenderProps } from "../types";
import { str } from "../util";
import { evalRenderer } from "./eval";
import { launchRenderer } from "./launch";

function delegate(args: Record<string, unknown>): ToolRenderer {
	const op = str(args.op);
	if (op === "exec") return evalRenderer;
	if (op !== null) return launchRenderer;
	return typeof args.code === "string" || typeof args.language === "string" ? evalRenderer : launchRenderer;
}

function Summary(props: ToolRenderProps) {
	const { Summary: Delegate } = delegate(props.args);
	return <Delegate {...props} />;
}

function Body(props: ToolRenderProps) {
	const { Body: Delegate } = delegate(props.args);
	return Delegate === undefined ? null : <Delegate {...props} />;
}

export const runtimeRenderer: ToolRenderer = { Summary, Body };
