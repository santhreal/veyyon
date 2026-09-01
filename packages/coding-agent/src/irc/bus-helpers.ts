import type { AgentKind, AgentRegistry } from "../registry/agent-registry";

export interface IrcMessage {
	id: string;
	from: string;
	to: string;
	body: string;
	ts: number;
	replyTo?: string;
}

export interface IrcDeliveryReceipt {
	to: string;
	outcome: "injected" | "woken" | "revived" | "failed";
	error?: string;
}

export type IrcDeliveryRoute = "refused" | "waiter" | "injected" | "wake" | "revival" | "buffered" | "unavailable";

export type IrcRecipientClass = AgentKind | "unknown";

export interface IrcDeliveryTelemetry {
	level: "rich" | "ultra";
	outcome: IrcDeliveryReceipt["outcome"];
	payloadBytes: number;
	sender?: string;
	recipientClass?: IrcRecipientClass;
	route?: IrcDeliveryRoute;
	revived?: boolean;
	deliveryLatencyMs?: number;
	messageKind?: "message" | "reply";
}

export interface IrcDeliveryFacts {
	outcome: IrcDeliveryReceipt["outcome"];
	payloadBytes: number;
	sender: string;
	recipientClass: IrcRecipientClass;
	route: IrcDeliveryRoute;
	revived: boolean;
	deliveryLatencyMs: number;
	messageKind: "message" | "reply";
}

export interface IrcPersistedDeliveryFacts extends IrcDeliveryFacts {
	messageId: string;
	direction: "sent" | "received";
}

export interface IrcPersistedDeliveryTelemetry extends IrcDeliveryTelemetry {
	messageId: string;
	direction: "sent" | "received";
}

export interface IrcDeliveryAttempt extends IrcDeliveryReceipt {
	recipientClass: IrcRecipientClass;
	route: IrcDeliveryRoute;
	revived: boolean;
}

export function projectIrcDeliveryTelemetry(level: "rich" | "ultra", facts: IrcDeliveryFacts): IrcDeliveryTelemetry {
	const telemetry: IrcDeliveryTelemetry = {
		level,
		outcome: facts.outcome,
		payloadBytes: facts.payloadBytes,
	};
	if (level === "ultra") {
		telemetry.sender = facts.sender;
		telemetry.recipientClass = facts.recipientClass;
		telemetry.route = facts.route;
		telemetry.revived = facts.revived;
		telemetry.deliveryLatencyMs = facts.deliveryLatencyMs;
		telemetry.messageKind = facts.messageKind;
	}
	return telemetry;
}

export interface IrcLogEntry {
	message: IrcMessage;
	outcome: IrcDeliveryReceipt["outcome"];
	error?: string;
	telemetry?: IrcDeliveryTelemetry;
	scope?: string;
}

export interface IrcWaiter {
	from?: string;
	resolve: (msg: IrcMessage) => void;
	cancel: () => void;
}

export const MAILBOX_CAP = 100;

export const LOG_CAP = 500;

export const PING_PONG_CAP = 16;

export interface IrcLivenessOptions {
	registry: AgentRegistry;
	senderId: string;
	mode?: "running" | "revivable";
}
