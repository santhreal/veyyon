/**
 * Compile-time wire contracts for shared response input/output item shapes.
 * The explicit expected shapes reject changed fields, optionality and nullability.
 * Namespace augmentation and nested-type linkage require a separate isolated
 * compiler program; equal unaugmented shapes cannot prove that isolation.
 */
import type { ResponseInputItem, ResponseOutputItem } from "../src/providers/openai-responses-wire";

type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
type Assert<T extends true> = T;
type Fields<T> = { [K in keyof T]: T[K] };

interface ExpectedImageGenerationCall {
	id: string;
	result: string | null;
	status: "in_progress" | "completed" | "generating" | "failed";
	type: "image_generation_call";
}

interface ExpectedLocalShellAction {
	command: Array<string>;
	env: {
		[key: string]: string;
	};
	type: "exec";
	timeout_ms?: number | null;
	user?: string | null;
	working_directory?: string | null;
}

interface ExpectedLocalShellCall {
	id: string;
	action: ExpectedLocalShellAction;
	call_id: string;
	status: "in_progress" | "completed" | "incomplete";
	type: "local_shell_call";
}

interface ExpectedLocalShellCallOutput {
	id: string;
	output: string;
	type: "local_shell_call_output";
	status?: "in_progress" | "completed" | "incomplete" | null;
}

interface ExpectedMcpCall {
	id: string;
	arguments: string;
	name: string;
	server_label: string;
	type: "mcp_call";
	approval_request_id?: string | null;
	error?: string | null;
	output?: string | null;
	status?: "in_progress" | "completed" | "incomplete" | "calling" | "failed";
}

interface ExpectedMcpTool {
	input_schema: unknown;
	name: string;
	annotations?: unknown | null;
	description?: string | null;
}

interface ExpectedMcpListTools {
	id: string;
	server_label: string;
	tools: Array<ExpectedMcpTool>;
	type: "mcp_list_tools";
	error?: string | null;
}

interface ExpectedMcpApprovalRequest {
	id: string;
	arguments: string;
	name: string;
	server_label: string;
	type: "mcp_approval_request";
}

// Input item shape assertions
export type InputImageGenerationCallShape = Assert<
	Equal<Fields<ResponseInputItem.ImageGenerationCall>, ExpectedImageGenerationCall>
>;
export type InputLocalShellCallShape = Assert<Equal<Fields<ResponseInputItem.LocalShellCall>, ExpectedLocalShellCall>>;
export type InputLocalShellActionShape = Assert<
	Equal<Fields<ResponseInputItem.LocalShellCall.Action>, ExpectedLocalShellAction>
>;
export type InputLocalShellCallOutputShape = Assert<
	Equal<Fields<ResponseInputItem.LocalShellCallOutput>, ExpectedLocalShellCallOutput>
>;
export type InputMcpCallShape = Assert<Equal<Fields<ResponseInputItem.McpCall>, ExpectedMcpCall>>;
export type InputMcpListToolsShape = Assert<Equal<Fields<ResponseInputItem.McpListTools>, ExpectedMcpListTools>>;
export type InputMcpToolShape = Assert<Equal<Fields<ResponseInputItem.McpListTools.Tool>, ExpectedMcpTool>>;
export type InputMcpApprovalRequestShape = Assert<
	Equal<Fields<ResponseInputItem.McpApprovalRequest>, ExpectedMcpApprovalRequest>
>;

// Output item shape assertions
export type OutputImageGenerationCallShape = Assert<
	Equal<Fields<ResponseOutputItem.ImageGenerationCall>, ExpectedImageGenerationCall>
>;
export type OutputLocalShellCallShape = Assert<
	Equal<Fields<ResponseOutputItem.LocalShellCall>, ExpectedLocalShellCall>
>;
export type OutputLocalShellActionShape = Assert<
	Equal<Fields<ResponseOutputItem.LocalShellCall.Action>, ExpectedLocalShellAction>
>;
export type OutputLocalShellCallOutputShape = Assert<
	Equal<Fields<ResponseOutputItem.LocalShellCallOutput>, ExpectedLocalShellCallOutput>
>;
export type OutputMcpCallShape = Assert<Equal<Fields<ResponseOutputItem.McpCall>, ExpectedMcpCall>>;
export type OutputMcpListToolsShape = Assert<Equal<Fields<ResponseOutputItem.McpListTools>, ExpectedMcpListTools>>;
export type OutputMcpToolShape = Assert<Equal<Fields<ResponseOutputItem.McpListTools.Tool>, ExpectedMcpTool>>;
export type OutputMcpApprovalRequestShape = Assert<
	Equal<Fields<ResponseOutputItem.McpApprovalRequest>, ExpectedMcpApprovalRequest>
>;
