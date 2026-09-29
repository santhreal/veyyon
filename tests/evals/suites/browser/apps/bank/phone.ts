/**
 * The customer's phone: a Messages app on an origin of its own, where the bank's one-time codes
 * arrive a moment after the bank sends them. Pages poll for new messages, as a messaging web app
 * does, and a JSON API serves the same threads.
 */

import { escapeHtml, type HostedSite, hostSite, html, json, text } from "../../../../engine/kit/web-host";
import { page } from "../../ui";
import type { SeededSms } from "./data";

export interface PhoneMessage {
	/** Increases with every message the phone holds. */
	readonly id: number;
	readonly sender: string;
	readonly body: string;
	/** When it reaches the phone, epoch milliseconds. */
	readonly deliverAt: number;
}

export interface PhoneThreadMessage {
	readonly id: number;
	readonly body: string;
	readonly age: string;
}

export interface PhoneThread {
	readonly sender: string;
	readonly messages: readonly PhoneThreadMessage[];
}

export class PhoneInbox {
	readonly #messages: PhoneMessage[] = [];

	constructor(history: readonly SeededSms[], now: number) {
		for (const sms of [...history].sort((a, b) => b.ageMinutes - a.ageMinutes)) {
			this.#push(sms.sender, sms.body, now - sms.ageMinutes * 60_000);
		}
	}

	/** Queue a message that reaches the phone `delayMs` from now. */
	send(sender: string, body: string, delayMs: number): void {
		this.#push(sender, body, Date.now() + delayMs);
	}

	/** Messages that have reached the phone by `now`, oldest first. */
	delivered(now: number): PhoneMessage[] {
		return this.#messages.filter(message => message.deliverAt <= now);
	}

	#push(sender: string, body: string, deliverAt: number): void {
		this.#messages.push({ id: this.#messages.length + 1, sender, body, deliverAt });
	}
}

export function threadSlug(sender: string): string {
	return sender
		.toLowerCase()
		.replaceAll(/[^a-z0-9]+/g, "-")
		.replaceAll(/^-|-$/g, "");
}

function age(deliverAt: number, now: number): string {
	const seconds = Math.max(0, Math.round((now - deliverAt) / 1000));
	if (seconds < 45) return "Just now";
	const minutes = Math.round(seconds / 60);
	if (minutes < 60) return `${minutes} min ago`;
	const hours = Math.round(minutes / 60);
	if (hours < 24) return `${hours} hr ago`;
	const days = Math.round(hours / 24);
	return days === 1 ? "Yesterday" : `${days} days ago`;
}

const STYLE = `
main{max-width:440px}
.feed{list-style:none;margin:0;padding:0}
.conversation a{display:grid;grid-template-columns:1fr auto;gap:2px 10px;padding:10px 12px;background:#fff;border-bottom:1px solid #e5e7eb;color:inherit;text-decoration:none}
.conversation .preview{grid-column:1/3;color:#6b7280;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.bubble{background:#e5e7eb;border-radius:14px;padding:8px 12px;margin:8px 40px 0 0}
.bubble time{display:block;font-size:11px;color:#6b7280;margin-top:3px}
`;

/** Swap in the server's newest rendering of the feed every second and a half. */
const POLL_SCRIPT = `
setInterval(async () => {
	try {
		const response = await fetch(location.href, { cache: "no-store" });
		const next = new DOMParser().parseFromString(await response.text(), "text/html").getElementById("feed");
		const current = document.getElementById("feed");
		if (next && current && next.innerHTML !== current.innerHTML) current.innerHTML = next.innerHTML;
	} catch {}
}, 1500);
`;

function render(title: string, body: string) {
	return html(page(title, body, { brand: "Phone · Messages", style: STYLE, script: POLL_SCRIPT }));
}

/** Threads by sender, the most recently active first. */
function threads(inbox: PhoneInbox, now: number): Map<string, PhoneMessage[]> {
	const bySender = new Map<string, PhoneMessage[]>();
	for (const message of inbox.delivered(now)) {
		const slug = threadSlug(message.sender);
		const list = bySender.get(slug) ?? [];
		list.push(message);
		bySender.set(slug, list);
	}
	const latest = (list: readonly PhoneMessage[]) => list[list.length - 1]?.deliverAt ?? 0;
	return new Map([...bySender].sort(([, a], [, b]) => latest(b) - latest(a)));
}

export async function startPhoneSite(inbox: PhoneInbox): Promise<HostedSite> {
	return hostSite(request => {
		const now = Date.now();
		const pathname = request.url.pathname;
		const all = threads(inbox, now);
		if (pathname === "/api/conversations") {
			return json(
				[...all].map(([slug, list]) => ({ slug, sender: list[0]?.sender, count: list.length })),
			);
		}
		const apiMatch = /^\/api\/conversations\/([a-z0-9-]+)$/.exec(pathname);
		if (apiMatch) {
			const list = all.get(apiMatch[1] as string);
			if (!list) return json({ error: "No such conversation" }, { status: 404 });
			const thread: PhoneThread = {
				sender: list[0]?.sender ?? "",
				messages: list.map(message => ({ id: message.id, body: message.body, age: age(message.deliverAt, now) })),
			};
			return json(thread);
		}
		if (pathname === "/") {
			const rows = [...all]
				.map(([slug, list]) => {
					const last = list[list.length - 1] as PhoneMessage;
					return `<li class="conversation"><a href="/c/${slug}"><strong>${escapeHtml(last.sender)}</strong><time>${age(last.deliverAt, now)}</time><span class="preview">${escapeHtml(last.body)}</span></a></li>`;
				})
				.join("");
			return render("Messages", `<h1>Messages</h1><ul class="feed" id="feed">${rows}</ul>`);
		}
		const threadMatch = /^\/c\/([a-z0-9-]+)$/.exec(pathname);
		if (threadMatch) {
			const list = all.get(threadMatch[1] as string);
			if (!list) return text("No such conversation", { status: 404 });
			const bubbles = list
				.map(
					message =>
						`<li class="bubble" data-id="${message.id}"><span class="body">${escapeHtml(message.body)}</span><time>${age(message.deliverAt, now)}</time></li>`,
				)
				.join("");
			return render(
				list[0]?.sender ?? "Messages",
				`<p><a href="/">← Messages</a></p><h1>${escapeHtml(list[0]?.sender ?? "")}</h1><ol class="feed" id="feed">${bubbles}</ol>`,
			);
		}
		return text("Not found", { status: 404 });
	});
}
