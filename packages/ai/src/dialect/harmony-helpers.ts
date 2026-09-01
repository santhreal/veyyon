export const START = "<|start|>";
export const END = "<|end|>";
export const MESSAGE = "<|message|>";
export const CHANNEL = "<|channel|>";
export const CONSTRAIN = "<|constrain|>";
export const RETURN = "<|return|>";
export const CALL = "<|call|>";

export const ALL_TOKENS = [START, END, MESSAGE, CHANNEL, CONSTRAIN, RETURN, CALL] as const;
export const BODY_TOKENS = [END, CALL, RETURN, START, CHANNEL, MESSAGE, CONSTRAIN] as const;

export type State = "outside" | "header" | "body";
export type BodyMode = "text" | "thinking" | "tool" | "skip";

export interface HeaderFields {
	role: string;
	channel: string;
	recipient: string;
}

export interface TokenMatch {
	index: number;
	token: string;
}
