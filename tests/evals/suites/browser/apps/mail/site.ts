/**
 * Parcel Mail's pages and endpoints over one {@link MailWorld}.
 *
 * What makes it hard to operate is ordinary webmail design: a message list that renders only the
 * rows in view and fetches the rest as it scrolls, a selection kept by the page rather than by the
 * checkboxes on screen, search operators, conversations whose older messages are collapsed, a
 * recipient field whose contact suggestions cover the Send button while open, an Attach button that
 * opens a hidden file input, and a filter form built from rows added in place.
 */

import { createHash } from "node:crypto";
import { Seeded } from "../../../../engine/kit/seeded";
import {
	escapeHtml,
	formFields,
	type HostedSite,
	hostSite,
	html,
	json,
	jsonBody,
	redirect,
	type SiteRequest,
	type SiteResponse,
	text,
} from "../../../../engine/kit/web-host";
import { page } from "../../ui";
import {
	applyFilterActions,
	COMPOSE_MODES,
	type ComposeMode,
	composePrefill,
	describeFilter,
	describePerson,
	FILTER_FIELD_NAMES,
	FILTER_FIELDS,
	type Filter,
	type FilterField,
	FOLDER_NAMES,
	FOLDERS,
	type Folder,
	filterMatches,
	filterReaches,
	findMessage,
	isEmail,
	listMessages,
	longDate,
	type MailWorld,
	type Message,
	type Person,
	type SentAttachment,
	type SentMail,
	shortDate,
	snippet,
	TODAY,
	threadOf,
} from "./data";
import { COMPOSE_SCRIPT, FILTER_SCRIPT, LIST_SCRIPT } from "./scripts";

export interface MessageState {
	readonly folder: Folder;
	readonly labels: readonly string[];
	readonly starred: boolean;
}

export interface MailSnapshot {
	/** Every message seeded into the mailbox, as it was when the trial started and as it is now. */
	readonly messages: Readonly<Record<string, { readonly before: MessageState; readonly now: MessageState }>>;
	readonly sent: readonly SentMail[];
	readonly filters: readonly Filter[];
	readonly labels: readonly string[];
	readonly failedSignins: number;
}

export interface MailSite extends HostedSite {
	finish(): Promise<MailSnapshot>;
}

const SESSION_COOKIE = "parcel_sid";
/** Rows the list page embeds and each list fetch returns. */
const PAGE_SIZE = 50;
const MAX_CONDITIONS = 5;

const STYLE = `
main{max-width:1320px}
header.app form.search{margin:0 0 0 12px;display:flex;gap:6px;flex:1;max-width:520px}
header.app form.search input{flex:1}
header.app .who{margin-left:auto;color:#cbd5e1}
.mail{display:grid;grid-template-columns:190px 1fr;gap:18px;align-items:start}
.sidebar a{display:block;padding:5px 10px;border-radius:14px;color:#1f2937;text-decoration:none}
.sidebar a.active{background:#dbeafe;font-weight:600}
.sidebar h2{font-size:12px;text-transform:uppercase;color:#6b7280;margin:14px 10px 4px}
.sidebar a.compose-link{display:inline-block;margin:0 0 10px;background:#2563eb;color:#fff;padding:8px 18px;border-radius:16px}
.new-label{display:flex;gap:4px;margin:8px 4px}
.new-label input{width:112px}
.toolbar{display:flex;gap:6px;align-items:center;flex-wrap:wrap;background:#fff;border:1px solid #e5e7eb;border-radius:6px;padding:6px 8px;margin-bottom:6px}
.toolbar label{margin:0 6px 0 0;display:flex;gap:4px;align-items:center}
.toolbar .menu{position:relative}
#label-menu{position:absolute;top:32px;left:0;background:#fff;border:1px solid #cbd5e1;border-radius:6px;box-shadow:0 8px 24px rgba(15,23,42,.18);z-index:20;min-width:170px;padding:4px 0}
#label-menu button{display:block;width:100%;text-align:left;background:none;color:#111827;border-radius:0}
#label-menu button:hover{background:#eff6ff}
button.danger{background:#dc2626}
.vlist{position:relative;height:calc(100vh - 250px);min-height:320px;overflow-y:auto;background:#fff;border:1px solid #e5e7eb;border-radius:6px}
#spacer{width:1px}
#list-notice:empty{display:none}
#count{margin:4px 0}
.mailbox h1{margin:0 0 6px;font-size:22px}
.row-item{position:absolute;left:0;right:0;height:40px;display:flex;align-items:center;gap:8px;padding:0 10px;border-bottom:1px solid #f1f5f9;cursor:pointer;white-space:nowrap;overflow:hidden;background:#fff}
.row-item:hover{background:#f8fafc}
.row-item.unread{font-weight:600}
.row-item .from{width:180px;flex:none;overflow:hidden;text-overflow:ellipsis}
.row-item .subject{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;color:inherit;text-decoration:none}
.row-item .snippet{color:#6b7280;font-weight:400}
.row-item time{flex:none;width:100px;text-align:right;color:#6b7280;font-weight:400;font-size:13px}
.chips{display:inline-flex;gap:4px;flex:none;flex-wrap:wrap}
.chip{display:inline-block;background:#e0e7ff;color:#1e3a8a;border-radius:10px;padding:1px 8px;font-size:12px;font-weight:400}
.chip.folder{background:#f1f5f9;color:#334155}
.star{background:none;color:#9ca3af;padding:0 4px;font-size:17px;line-height:1}
.star[aria-pressed=true]{color:#f59e0b}
details.search-help{margin:0 0 8px;font-size:13px}
details.search-help code{background:#eef2ff;padding:0 4px;border-radius:3px}
.message{padding:0}
.message.current{border-color:#93c5fd}
.message summary{padding:10px 14px;cursor:pointer}
.message details[open] summary .snippet{display:none}
.message .meta{padding:0 14px;color:#4b5563;font-size:13px}
.message .body{padding:10px 14px;white-space:pre-wrap}
.message .attachments{margin:0 14px 10px}
.message .actions{padding:0 14px 12px}
.thread-actions form{margin:0}
.compose{max-width:820px}
.compose .field{position:relative;display:flex;align-items:center;gap:8px;border-bottom:1px solid #e5e7eb;padding:6px 0;min-height:42px}
.compose .field[hidden]{display:none}
.compose .cc-toggle{background:none;color:#2563eb;padding:2px 6px}
.compose .field > label{width:36px;margin:0;color:#6b7280}
.compose .recipients{display:flex;flex-wrap:wrap;gap:4px;flex:1;align-items:center;cursor:text}
.compose .recipients input{border:0;flex:1;min-width:200px;outline:none;padding:4px}
.compose .recipients input[aria-invalid=true]{color:#b91c1c;text-decoration:underline wavy #b91c1c}
.compose .chip{font-size:13px;padding:2px 4px 2px 10px}
.compose .chip button{background:none;color:#1e3a8a;padding:0 4px;margin-left:2px}
.compose .chip.error{background:#fee2e2;color:#991b1b}
.suggest{position:absolute;top:100%;left:0;width:520px;background:#fff;border:1px solid #cbd5e1;border-radius:6px;box-shadow:0 10px 28px rgba(15,23,42,.22);z-index:40}
.suggest .option{padding:12px 14px;cursor:pointer;border-bottom:1px solid #f1f5f9}
.suggest .option[aria-selected=true]{background:#eff6ff}
.compose-actions{display:flex;gap:8px;align-items:center;padding:10px 0;flex-wrap:wrap}
.compose-actions .discard{margin-left:auto;color:#6b7280}
.compose input[name=subject]{width:100%}
.compose textarea{width:100%;min-height:320px;font:13px/1.5 ui-monospace,monospace}
.tabs{display:flex;gap:14px;margin-bottom:12px}
.tabs a.active{font-weight:700}
.condition{display:flex;gap:8px;align-items:center;margin:6px 0}
.condition input{flex:1;max-width:360px}
fieldset{border:1px solid #e5e7eb;border-radius:6px;margin:0 0 12px;background:#fff}
`;

const NOTICES: Readonly<Record<string, string>> = {
	sent: "Your message was sent.",
	archived: "The message was archived.",
	inbox: "The message was moved to the Inbox.",
	trashed: "The message was moved to the Trash.",
	starred: "The message was starred.",
	unstarred: "The star was removed.",
	labelled: "The label was applied.",
	unlabelled: "The label was removed.",
};

interface BulkAction {
	readonly verb: string;
	readonly apply: (message: Message, label: string) => void;
}

const BULK_ACTIONS: Readonly<Record<string, BulkAction>> = {
	archive: {
		verb: "Archived",
		apply: message => {
			if (message.folder !== "sent") message.folder = "archive";
		},
	},
	inbox: {
		verb: "Moved to the Inbox",
		apply: message => {
			if (message.folder !== "sent") message.folder = "inbox";
		},
	},
	trash: {
		verb: "Moved to the Trash",
		apply: message => {
			message.folder = "trash";
		},
	},
	star: {
		verb: "Starred",
		apply: message => {
			message.starred = true;
		},
	},
	unstar: {
		verb: "Removed the star from",
		apply: message => {
			message.starred = false;
		},
	},
	read: {
		verb: "Marked as read",
		apply: message => {
			message.read = true;
		},
	},
	unread: {
		verb: "Marked as unread",
		apply: message => {
			message.read = false;
		},
	},
	label: {
		verb: "Labelled",
		apply: (message, label) => {
			if (!message.labels.includes(label)) message.labels.push(label);
		},
	},
};

function stateOf(message: Message): MessageState {
	return { folder: message.folder, labels: [...message.labels], starred: message.starred };
}

function sizeLabel(bytes: number): string {
	return bytes < 1024 ? `${bytes} bytes` : `${(bytes / 1024).toFixed(1)} KB`;
}

/** The compose mode a request names; `new` when it names none the form has. */
function composeMode(value: string | null | undefined): ComposeMode {
	return COMPOSE_MODES.find(mode => mode === value) ?? "new";
}

/** JSON inside a `<script type="application/json">`: `<` escaped so no text closes the element. */
function scriptJson(value: unknown): string {
	return JSON.stringify(value).replaceAll("<", "\\u003c");
}

/** A JSON request body's top-level fields; empty when the body is not a JSON object. */
function jsonFields(request: SiteRequest): Record<string, unknown> {
	const payload = jsonBody(request);
	return payload !== null && typeof payload === "object" ? Object.fromEntries(Object.entries(payload)) : {};
}

interface ComposeState {
	readonly mode: ComposeMode;
	readonly source: Message | undefined;
	readonly to: readonly Person[];
	readonly cc: readonly Person[];
	readonly subject: string;
	readonly body: string;
	readonly attachments: readonly string[];
	readonly error?: string;
}

interface FilterFormValues {
	readonly match: string;
	readonly conditions: readonly { readonly field: string; readonly value: string }[];
	readonly label: string;
	readonly newLabel: string;
	readonly checked: ReadonlySet<string>;
}

const EMPTY_FILTER_FORM: FilterFormValues = {
	match: "all",
	conditions: [{ field: "from", value: "" }],
	label: "",
	newLabel: "",
	checked: new Set(),
};

const FILTER_CHECKBOXES = ["archive", "star", "markRead", "trash", "applyExisting"] as const;

export async function startMailSite(world: MailWorld, seed: number): Promise<MailSite> {
	const rng = new Seeded(seed ^ 0x3a11);
	const signedIn = new Set<string>();
	const uploads = new Map<string, SentAttachment>();
	const sent: SentMail[] = [];
	let failedSignins = 0;
	const before = new Map(world.messages.map(message => [message.id, stateOf(message)]));
	const me: Person = { name: world.account.name, email: world.account.email };

	const sessionOf = (request: SiteRequest): { id: string; fresh: boolean } => {
		const existing = request.cookies[SESSION_COOKIE];
		return existing ? { id: existing, fresh: false } : { id: `s${rng.code(12)}`, fresh: true };
	};

	const personFor = (email: string): Person =>
		world.contacts.find(contact => contact.email === email) ??
		(email === me.email ? me : undefined) ?? { name: email, email };

	const labelNamed = (name: string): string | undefined =>
		world.labels.find(label => label.toLowerCase() === name.trim().toLowerCase());

	const nav = (q = "") =>
		`<form action="/mail/search" role="search" class="search"><input name="q" value="${escapeHtml(q)}" placeholder="Search mail" aria-label="Search mail"><button>Search</button></form><a href="/compose">Compose</a><a href="/settings/filters">Settings</a><span class="who">${escapeHtml(world.account.email)}</span><a href="/signout">Sign out</a>`;

	const render = (title: string, body: string, options: { q?: string; script?: string } = {}): SiteResponse =>
		html(page(title, body, { brand: "Parcel Mail", nav: nav(options.q), style: STYLE, script: options.script }));

	const sidebar = (active: string) => {
		const unread = world.messages.filter(message => message.folder === "inbox" && !message.read).length;
		const link = (key: string, href: string, label: string) =>
			`<a href="${href}"${key === active ? ' class="active" aria-current="page"' : ""}>${label}</a>`;
		return `<nav class="sidebar" aria-label="Folders">
<a class="compose-link" href="/compose">Compose</a>
${link("inbox", "/mail/inbox", `Inbox${unread > 0 ? ` (${unread})` : ""}`)}
${link("starred", "/mail/starred", "Starred")}
${link("archive", "/mail/archive", "Archive")}
${link("sent", "/mail/sent", "Sent")}
${link("trash", "/mail/trash", "Trash")}
<h2>Labels</h2>
${world.labels.map(label => link(`label:${label}`, `/mail/label/${encodeURIComponent(label)}`, escapeHtml(label))).join("\n")}
<form method="post" action="/labels" class="new-label"><input type="hidden" name="back" value="/mail/${active.startsWith("label:") || !active ? "inbox" : escapeHtml(active)}"><input name="name" placeholder="New label" aria-label="New label name"><button class="secondary">Add</button></form>
</nav>`;
	};

	const rowJson = (message: Message) => ({
		id: message.id,
		who: message.folder === "sent" ? `To: ${message.to.map(person => person.name).join(", ")}` : message.from.name,
		whoTitle: message.folder === "sent" ? message.to.map(describePerson).join(", ") : describePerson(message.from),
		subject: message.subject,
		snippet: snippet(message.body),
		date: message.date,
		dateLabel: shortDate(message.date),
		labels: message.labels,
		starred: message.starred,
		read: message.read,
		attachments: message.attachments.length,
		folderName: FOLDER_NAMES[message.folder],
	});

	const listPage = (view: string, q: string, notice: string) => {
		const messages = listMessages(world, view, q);
		const config = { view, q, total: messages.length, rows: messages.slice(0, PAGE_SIZE).map(rowJson) };
		const heading = q
			? `Search results for “${q}”`
			: view === "starred"
				? "Starred"
				: view.startsWith("label:")
					? view.slice("label:".length)
					: FOLDER_NAMES[view as Folder];
		const moveBack =
			q || view !== "inbox"
				? '<button type="button" class="secondary" data-bulk="inbox" disabled>Move to Inbox</button>'
				: "";
		return render(
			heading,
			`<div class="mail">${sidebar(q ? "" : view)}<section class="mailbox" aria-label="${escapeHtml(heading)}">
<h1>${escapeHtml(heading)}</h1>
${notice ? `<p class="notice">${escapeHtml(notice)}</p>` : ""}
<details class="search-help"><summary>Search operators</summary><p><code>from:</code> sender name or address · <code>to:</code> recipient · <code>subject:</code> words in the subject · <code>has:attachment</code> · <code>label:</code> · <code>is:starred</code> · <code>is:unread</code> · <code>in:inbox</code>, <code>in:archive</code>, <code>in:sent</code>, <code>in:trash</code>, <code>in:anywhere</code>. Quote a value with spaces: <code>subject:"weekly report"</code>. A search covers every folder but the Trash unless it names one.</p></details>
<div class="toolbar" role="toolbar" aria-label="Selected conversations">
<label><input type="checkbox" id="select-all" aria-label="Select every conversation in this view"> All</label>
<button type="button" data-bulk="archive" disabled>Archive</button>
${moveBack}
<button type="button" class="secondary" data-bulk="star" disabled>Star</button>
<button type="button" class="secondary" data-bulk="unstar" disabled>Remove star</button>
<span class="menu"><button type="button" class="secondary" id="label-button" aria-haspopup="menu" aria-expanded="false" disabled>Label ▾</button><div id="label-menu" role="menu" hidden>${world.labels
				.map(label => `<button type="button" role="menuitem" data-label="${escapeHtml(label)}">${escapeHtml(label)}</button>`)
				.join("")}</div></span>
<button type="button" class="secondary" data-bulk="read" disabled>Mark read</button>
<button type="button" class="secondary" data-bulk="unread" disabled>Mark unread</button>
<button type="button" class="danger" data-bulk="trash" disabled>Delete</button>
<span id="selection" class="muted" aria-live="polite"></span>
</div>
<p id="list-notice" role="status"></p>
<p class="muted" id="count"></p>
<div id="list" class="vlist" role="grid" aria-label="Conversations" tabindex="0"><div id="spacer"></div></div>
<p id="empty" class="muted" hidden>No conversations here.</p>
<script type="application/json" id="list-config">${scriptJson(config)}</script>
</section></div>`,
			{ q, script: LIST_SCRIPT },
		);
	};

	const messageArticle = (message: Message, open: boolean, current: boolean) => `<article class="card message${current ? " current" : ""}" id="message-${message.id}" data-id="${message.id}">
<details${open ? " open" : ""}>
<summary><strong>${escapeHtml(message.from.name)}</strong> <span class="muted">&lt;${escapeHtml(message.from.email)}&gt;</span> · <time datetime="${message.date}">${escapeHtml(longDate(message.date))}</time>${message.folder === "sent" ? ' <span class="chip folder">Sent</span>' : ""}${message.starred ? ' <span aria-label="Starred">★</span>' : ""}<div class="muted snippet">${escapeHtml(snippet(message.body))}</div></summary>
<div class="meta">To: ${escapeHtml(message.to.map(describePerson).join(", "))}${message.cc.length > 0 ? `<br>Cc: ${escapeHtml(message.cc.map(describePerson).join(", "))}` : ""}</div>
<div class="body">${escapeHtml(message.body)}</div>
${message.attachments.length > 0 ? `<ul class="attachments">${message.attachments.map(item => `<li>${escapeHtml(item.name)} <span class="muted">(${sizeLabel(item.size)})</span></li>`).join("")}</ul>` : ""}
<div class="row actions"><a class="button" href="/compose?mode=reply&amp;id=${message.id}">Reply</a><a class="button secondary" href="/compose?mode=replyall&amp;id=${message.id}">Reply all</a><a class="button secondary" href="/compose?mode=forward&amp;id=${message.id}">Forward</a></div>
</details>
</article>`;

	const messagePage = (message: Message, notice: string) => {
		message.read = true;
		const thread = threadOf(world, message.threadId, message.folder === "trash");
		if (!thread.includes(message)) thread.push(message);
		const latest = thread[thread.length - 1];
		const back = message.folder;
		const move = (folder: Folder, label: string, style = "secondary") =>
			`<form method="post" action="/message/${message.id}/move"><input type="hidden" name="folder" value="${folder}"><button class="${style}">${label}</button></form>`;
		const labelOptions = world.labels
			.filter(label => !message.labels.includes(label))
			.map(label => `<option>${escapeHtml(label)}</option>`)
			.join("");
		return render(
			message.subject || "(no subject)",
			`<p><a href="/mail/${back}">← Back to ${FOLDER_NAMES[back]}</a></p>
${notice ? `<p class="notice">${escapeHtml(notice)}</p>` : ""}
<h1>${escapeHtml(message.subject || "(no subject)")}</h1>
<div class="row thread-actions">
${message.folder === "inbox" || message.folder === "trash" ? move("archive", "Archive", "") : ""}
${message.folder === "archive" || message.folder === "trash" ? move("inbox", "Move to Inbox") : ""}
${message.folder !== "trash" ? move("trash", "Delete", "danger") : ""}
<form method="post" action="/message/${message.id}/star"><button class="secondary">${message.starred ? "Remove star" : "Star"}</button></form>
<form method="post" action="/message/${message.id}/label" class="row"><select name="label" aria-label="Label to apply">${labelOptions}</select><button class="secondary">Apply label</button></form>
</div>
<p>${message.labels
				.map(
					label =>
						`<form method="post" action="/message/${message.id}/unlabel" style="display:inline"><input type="hidden" name="label" value="${escapeHtml(label)}"><span class="chip">${escapeHtml(label)} <button class="secondary" aria-label="Remove label ${escapeHtml(label)}" style="padding:0 4px">×</button></span></form>`,
				)
				.join(" ")}</p>
<p class="muted">${thread.length === 1 ? "1 message" : `${thread.length} messages`} in this conversation · ${FOLDER_NAMES[message.folder]}</p>
${thread.map(item => messageArticle(item, item === message || item === latest, item === message)).join("\n")}`,
		);
	};

	const recipientField = (
		kind: "to" | "cc",
		label: string,
		people: readonly Person[],
		options: { readonly hidden?: boolean; readonly ccToggle?: boolean } = {},
	) => `<div class="field" id="${kind}-field"${options.hidden ? " hidden" : ""}>
<label for="${kind}-input">${label}</label>
<div class="recipients" id="${kind}-box">${people
		.map(
			person =>
				`<span class="chip" data-email="${escapeHtml(person.email)}">${escapeHtml(person.name === person.email ? person.email : describePerson(person))}<button type="button" aria-label="Remove ${escapeHtml(person.email)}">×</button></span>`,
		)
		.join(
			"",
		)}<input id="${kind}-input" role="combobox" aria-autocomplete="list" aria-expanded="false" aria-controls="${kind}-suggest" aria-label="${label} recipients" autocomplete="off"></div>
${options.ccToggle ? '<button type="button" class="cc-toggle" id="cc-toggle" aria-label="Add Cc recipients">Cc</button>' : ""}
<input type="hidden" name="${kind}" id="${kind}-value" value="${escapeHtml(people.map(person => person.email).join(","))}">
<div id="${kind}-suggest" class="suggest" role="listbox" aria-label="Suggested contacts" hidden></div>
</div>`;

	const composePage = (state: ComposeState) => {
		const title = { new: "New message", reply: "Reply", replyall: "Reply all", forward: "Forward" }[state.mode];
		const attachments = state.attachments
			.map(id => {
				const item = uploads.get(id);
				return item
					? `<span class="chip attachment" data-attachment="${id}">${escapeHtml(item.name)} (${sizeLabel(item.size)})<button type="button" aria-label="Remove ${escapeHtml(item.name)}">×</button></span>`
					: "";
			})
			.join("");
		return render(
			title,
			`<h1>${title}</h1>
<form id="compose-form" class="card compose" method="post" action="/compose/send" autocomplete="off">
<input type="hidden" name="mode" value="${state.mode}">
<input type="hidden" name="source" value="${state.source?.id ?? ""}">
<p id="compose-error" class="error" role="alert">${escapeHtml(state.error ?? "")}</p>
${recipientField("to", "To", state.to, { ccToggle: state.cc.length === 0 })}
${recipientField("cc", "Cc", state.cc, { hidden: state.cc.length === 0 })}
<div class="compose-actions">
<button id="send-button">Send</button>
<button type="button" class="secondary" id="attach-button">Attach</button>
<input type="file" id="attach-input" multiple hidden>
<span id="attachment-list">${attachments}</span>
<input type="hidden" name="attachments" id="attachments-value" value="${escapeHtml(state.attachments.join(","))}">
<a href="/mail/inbox" class="discard">Discard</a>
</div>
<label for="subject">Subject</label>
<input id="subject" name="subject" value="${escapeHtml(state.subject)}">
<label for="body">Message</label>
<textarea id="body" name="body">\n${escapeHtml(state.body)}</textarea>
</form>`,
			{ script: COMPOSE_SCRIPT },
		);
	};

	const addresses = (value: string | undefined): string[] => [
		...new Set(
			(value ?? "")
				.split(/[,;]/)
				.map(entry => entry.trim())
				.filter(Boolean)
				.map(entry => (/<([^>]+)>/.exec(entry)?.[1] ?? entry).trim().toLowerCase()),
		),
	];

	const send = (fields: Record<string, string>): SiteResponse => {
		const mode = composeMode(fields.mode);
		const source = fields.source ? findMessage(world, fields.source) : undefined;
		if (mode !== "new" && !source) return text("The message being answered no longer exists.", { status: 400 });
		const to = addresses(fields.to);
		const cc = addresses(fields.cc).filter(address => !to.includes(address));
		const attachmentIds = (fields.attachments ?? "").split(",").filter(Boolean);
		const subject = (fields.subject ?? "").trim();
		const body = (fields.body ?? "").replaceAll("\r\n", "\n");
		const invalid = [...to, ...cc].filter(address => !isEmail(address));
		let error = "";
		if (to.length + cc.length === 0) error = "Add at least one recipient.";
		else if (invalid.length > 0) error = `${invalid.map(address => `“${address}”`).join(", ")} is not a valid address.`;
		else if (attachmentIds.some(id => !uploads.has(id))) error = "An attachment is missing; attach it again.";
		if (error) {
			return composePage({
				mode,
				source,
				to: to.map(personFor),
				cc: cc.map(personFor),
				subject,
				body,
				attachments: attachmentIds.filter(id => uploads.has(id)),
				error,
			});
		}
		const record: SentMail = {
			id: `S${rng.code(8)}`,
			mode,
			sourceId: source?.id ?? null,
			threadId: source?.threadId ?? `T${rng.code(8)}`,
			to,
			cc,
			subject,
			body,
			attachments: attachmentIds.map(id => uploads.get(id) as SentAttachment),
		};
		sent.push(record);
		const minute = sent.length;
		world.messages.push({
			id: record.id,
			threadId: record.threadId,
			from: me,
			to: to.map(personFor),
			cc: cc.map(personFor),
			subject,
			body,
			date: `${TODAY}T${String(9 + Math.floor(minute / 60)).padStart(2, "0")}:${String(minute % 60).padStart(2, "0")}:00.000Z`,
			attachments: record.attachments.map(item => ({ name: item.name, size: item.size })),
			folder: "sent",
			labels: [],
			starred: false,
			read: true,
			seeded: false,
		});
		return redirect("/mail/inbox?notice=sent");
	};

	const upload = (request: SiteRequest): SiteResponse => {
		const payload = jsonFields(request);
		const rawName = payload.name;
		const rawData = payload.data;
		const name = typeof rawName === "string" ? (rawName.split(/[\\/]/).pop() ?? "").trim() : "";
		const data = typeof rawData === "string" ? rawData : null;
		if (!name || name.length > 200) return json({ error: "The file has no usable name." }, { status: 400 });
		if (data === null || !/^[A-Za-z0-9+/]*={0,2}$/.test(data)) {
			return json({ error: "The file could not be read." }, { status: 400 });
		}
		const bytes = Buffer.from(data, "base64");
		const id = `A${rng.code(8)}`;
		uploads.set(id, { name, size: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") });
		return json({ id, name, size: bytes.length, sizeLabel: sizeLabel(bytes.length) });
	};

	const contacts = (q: string) => {
		const needle = q.trim().toLowerCase();
		const matches = needle
			? world.contacts.filter(
					contact => ` ${contact.name.toLowerCase()}`.includes(` ${needle}`) || contact.email.includes(needle),
				)
			: [];
		return json({ contacts: matches.slice(0, 8) });
	};

	const bulk = (request: SiteRequest): SiteResponse => {
		const payload = jsonFields(request);
		const actionName = payload.action;
		const rawIds = payload.ids;
		const rawLabel = payload.label;
		const action =
			typeof actionName === "string" && Object.hasOwn(BULK_ACTIONS, actionName) ? BULK_ACTIONS[actionName] : undefined;
		if (!action) return json({ error: "Unknown action." }, { status: 400 });
		const ids = Array.isArray(rawIds) ? rawIds.filter((id): id is string => typeof id === "string") : [];
		const messages = world.messages.filter(message => ids.includes(message.id));
		if (ids.length === 0 || messages.length !== new Set(ids).size) {
			return json({ error: "Select conversations first." }, { status: 400 });
		}
		const label = actionName === "label" ? labelNamed(typeof rawLabel === "string" ? rawLabel : "") : "";
		if (label === undefined) return json({ error: "No such label." }, { status: 400 });
		for (const message of messages) action.apply(message, label);
		const count = messages.length === 1 ? "1 conversation" : `${messages.length} conversations`;
		return json({ message: `${action.verb} ${count}${label ? ` with “${label}”` : ""}.` });
	};

	const filterFormValues = (fields: Record<string, string>): FilterFormValues => {
		const conditions: { field: string; value: string }[] = [];
		for (let index = 0; index < MAX_CONDITIONS; index++) {
			const value = fields[`value${index}`];
			if (value === undefined) continue;
			conditions.push({ field: fields[`field${index}`] ?? "from", value });
		}
		return {
			match: fields.match === "any" ? "any" : "all",
			conditions: conditions.length > 0 ? conditions : EMPTY_FILTER_FORM.conditions,
			label: fields.label ?? "",
			newLabel: fields.newLabel ?? "",
			checked: new Set(FILTER_CHECKBOXES.filter(name => fields[name] === "on")),
		};
	};

	const draftFilter = (values: FilterFormValues): Pick<Filter, "match" | "conditions"> => ({
		match: values.match === "any" ? "any" : "all",
		conditions: values.conditions
			.filter(condition => condition.value.trim() && (FILTER_FIELDS as readonly string[]).includes(condition.field))
			.map(condition => ({ field: condition.field as FilterField, value: condition.value.trim() })),
	});

	const settingsTabs = (active: string) =>
		`<nav class="tabs"><a href="/settings/filters"${active === "filters" ? ' class="active"' : ""}>Filters</a><a href="/settings/labels"${active === "labels" ? ' class="active"' : ""}>Labels</a></nav>`;

	const conditionRow = (field: string, value: string) => `<div class="condition"><select>${FILTER_FIELDS.map(
		option => `<option value="${option}"${option === field ? " selected" : ""}>${FILTER_FIELD_NAMES[option]}</option>`,
	).join("")}</select><span>contains</span><input value="${escapeHtml(value)}"><button type="button" class="secondary" data-remove aria-label="Remove condition">Remove</button></div>`;

	const filtersPage = (notice = "", error = "", values: FilterFormValues = EMPTY_FILTER_FORM) => {
		const rows = world.filters
			.map(filter => {
				const { when, then } = describeFilter(filter);
				return `<tr><td>${escapeHtml(when)}</td><td>${escapeHtml(then)}</td><td><form method="post" action="/settings/filters/${filter.id}/delete"><button class="secondary">Delete</button></form></td></tr>`;
			})
			.join("");
		const check = (name: (typeof FILTER_CHECKBOXES)[number], label: string) =>
			`<label><input type="checkbox" name="${name}"${values.checked.has(name) ? " checked" : ""}> ${label}</label>`;
		const labelOptions = [
			`<option value="">Don't apply a label</option>`,
			...world.labels.map(label => `<option${values.label === label ? " selected" : ""}>${escapeHtml(label)}</option>`),
			`<option value="__new"${values.label === "__new" ? " selected" : ""}>New label…</option>`,
		].join("");
		return render(
			"Filters",
			`<h1>Settings</h1>${settingsTabs("filters")}
${notice ? `<p class="notice">${escapeHtml(notice)}</p>` : ""}
<h2>Your filters</h2>
${world.filters.length === 0 ? "<p>No filters yet.</p>" : `<table><tr><th>When a message matches</th><th>Do this</th><th></th></tr>${rows}</table>`}
<h2>Create a filter</h2>
${error ? `<p class="error" role="alert">${escapeHtml(error)}</p>` : ""}
<form method="post" action="/settings/filters" id="filter-form">
<fieldset><legend>Matching mail</legend>
<label>Match <select name="match"><option value="all"${values.match === "all" ? " selected" : ""}>all of these conditions</option><option value="any"${values.match === "any" ? " selected" : ""}>any of these conditions</option></select></label>
<div id="conditions">${values.conditions.map(condition => conditionRow(condition.field, condition.value)).join("")}</div>
<template id="condition-template">${conditionRow("from", "")}</template>
<button type="button" class="secondary" id="add-condition">Add condition</button>
<p class="muted" id="match-count" aria-live="polite"></p>
</fieldset>
<fieldset><legend>Do this</legend>
${check("archive", "Skip the Inbox (archive it)")}
<label>Apply the label <select name="label" id="filter-label">${labelOptions}</select></label>
<p id="new-label-field"${values.label === "__new" ? "" : " hidden"}><label>New label name <input name="newLabel" value="${escapeHtml(values.newLabel)}"></label></p>
${check("star", "Star it")}
${check("markRead", "Mark it as read")}
${check("trash", "Delete it")}
</fieldset>
${check("applyExisting", "Also apply this filter to matching conversations already in the mailbox")}
<p><button>Create filter</button></p>
</form>`,
			{ script: FILTER_SCRIPT },
		);
	};

	const createFilter = (fields: Record<string, string>): SiteResponse => {
		const values = filterFormValues(fields);
		const draft = draftFilter(values);
		const unknownField = values.conditions.some(
			condition => condition.value.trim() && !(FILTER_FIELDS as readonly string[]).includes(condition.field),
		);
		const newLabel = values.newLabel.trim();
		let error = "";
		if (unknownField) error = "A condition names a field the filter cannot check.";
		else if (draft.conditions.length === 0) error = "Add at least one condition with something to match.";
		else if (values.label === "__new" && !newLabel) error = "Name the new label, or choose an existing one.";
		else if (values.label === "__new" && newLabel.length > 40) error = "A label name is at most 40 characters.";
		else if (values.label && values.label !== "__new" && !labelNamed(values.label)) error = "That label does not exist.";
		let label: string | null = null;
		if (values.label === "__new") label = labelNamed(newLabel) ?? newLabel;
		else if (values.label) label = labelNamed(values.label) ?? null;
		const actions = {
			label: label || null,
			archive: values.checked.has("archive"),
			star: values.checked.has("star"),
			markRead: values.checked.has("markRead"),
			trash: values.checked.has("trash"),
		};
		if (!error && !actions.label && !actions.archive && !actions.star && !actions.markRead && !actions.trash) {
			error = "Choose at least one thing for the filter to do.";
		}
		if (error) return filtersPage("", error, values);
		if (actions.label && !labelNamed(actions.label)) world.labels.push(actions.label);
		let appliedTo = 0;
		if (values.checked.has("applyExisting")) {
			for (const message of world.messages) {
				if (filterReaches(message) && filterMatches(draft, message) && applyFilterActions(actions, message)) appliedTo++;
			}
		}
		world.filters.push({ id: `F${rng.code(6)}`, match: draft.match, conditions: draft.conditions, actions, seeded: false, appliedTo });
		return redirect(`/settings/filters?created=${appliedTo}`);
	};

	const labelsPage = (notice = "", error = "") =>
		render(
			"Labels",
			`<h1>Settings</h1>${settingsTabs("labels")}
${notice ? `<p class="notice">${escapeHtml(notice)}</p>` : ""}${error ? `<p class="error" role="alert">${escapeHtml(error)}</p>` : ""}
<table><tr><th>Label</th><th>Conversations</th><th></th></tr>${world.labels
				.map(
					label =>
						`<tr><td><a href="/mail/label/${encodeURIComponent(label)}">${escapeHtml(label)}</a></td><td>${world.messages.filter(message => message.labels.includes(label) && message.folder !== "trash").length}</td><td><form method="post" action="/labels/delete"><input type="hidden" name="name" value="${escapeHtml(label)}"><button class="secondary">Delete</button></form></td></tr>`,
				)
				.join("")}</table>
<form method="post" action="/labels" class="row" style="margin-top:12px"><input type="hidden" name="back" value="/settings/labels"><label>New label <input name="name"></label><button>Create label</button></form>`,
		);

	const signinPage = (next: string, error = "") =>
		html(
			page(
				"Sign in",
				`<div class="card" style="max-width:360px"><h1>Sign in to Parcel Mail</h1>${error ? `<p class="error">${escapeHtml(error)}</p>` : ""}
<form method="post" action="/signin"><input type="hidden" name="next" value="${escapeHtml(next)}">
<label>Email <input name="email" type="email" autocomplete="username"></label>
<label>Password <input name="password" type="password" autocomplete="current-password"></label>
<p><button>Sign in</button></p></form></div>`,
				{ brand: "Parcel Mail" },
			),
		);

	const route = (request: SiteRequest, session: string): SiteResponse => {
		const { method, url } = request;
		const pathname = url.pathname;
		const fields = method === "POST" && !request.headers["content-type"]?.includes("json") ? formFields(request) : {};
		if (pathname === "/signin" && method === "GET") return signinPage(url.searchParams.get("next") ?? "/mail/inbox");
		if (pathname === "/signin" && method === "POST") {
			if (fields.email?.trim().toLowerCase() === world.account.email && fields.password === world.account.password) {
				signedIn.add(session);
				return redirect(fields.next?.startsWith("/") ? fields.next : "/mail/inbox");
			}
			failedSignins++;
			return signinPage(fields.next ?? "/mail/inbox", "That email and password do not match an account.");
		}
		if (pathname === "/signout") {
			signedIn.delete(session);
			return redirect("/signin");
		}
		if (!signedIn.has(session)) {
			if (pathname.startsWith("/api/")) return json({ error: "Sign in first." }, { status: 401 });
			return redirect(`/signin?next=${encodeURIComponent(`${pathname}${url.search}`)}`);
		}

		if (pathname === "/" || pathname === "/mail") return redirect("/mail/inbox");
		const notice = NOTICES[url.searchParams.get("notice") ?? ""] ?? "";
		if (pathname === "/mail/search") return listPage("inbox", url.searchParams.get("q") ?? "", notice);
		const folderMatch = /^\/mail\/(inbox|archive|sent|trash|starred)$/.exec(pathname);
		if (folderMatch && method === "GET") return listPage(folderMatch[1] as string, url.searchParams.get("q") ?? "", notice);
		const labelMatch = /^\/mail\/label\/(.+)$/.exec(pathname);
		if (labelMatch && method === "GET") {
			const label = labelNamed(decodeURIComponent(labelMatch[1] as string));
			if (!label) return text("No such label", { status: 404 });
			return listPage(`label:${label}`, "", notice);
		}
		if (pathname === "/api/list") {
			const messages = listMessages(world, url.searchParams.get("view") ?? "inbox", url.searchParams.get("q") ?? "");
			const offset = Math.max(0, Number(url.searchParams.get("offset")) || 0);
			const limit = Math.min(100, Math.max(1, Number(url.searchParams.get("limit")) || PAGE_SIZE));
			return json({ total: messages.length, rows: messages.slice(offset, offset + limit).map(rowJson) });
		}
		if (pathname === "/api/ids") {
			const messages = listMessages(world, url.searchParams.get("view") ?? "inbox", url.searchParams.get("q") ?? "");
			return json({ ids: messages.map(message => message.id) });
		}
		if (pathname === "/api/bulk" && method === "POST") return bulk(request);
		if (pathname === "/api/contacts") return contacts(url.searchParams.get("q") ?? "");
		if (pathname === "/api/attachments" && method === "POST") return upload(request);
		if (pathname === "/api/filters/preview" && method === "POST") {
			const draft = draftFilter(filterFormValues(fields));
			const count = world.messages.filter(message => filterReaches(message) && filterMatches(draft, message)).length;
			return json({ count });
		}

		const messageMatch = /^\/message\/([A-Z0-9]+)(?:\/(move|star|label|unlabel))?$/.exec(pathname);
		if (messageMatch) {
			const message = findMessage(world, messageMatch[1] as string);
			if (!message) return text("No such message", { status: 404 });
			const action = messageMatch[2];
			if (!action && method === "GET") return messagePage(message, notice);
			if (method !== "POST") return text("Not found", { status: 404 });
			const back = (code: string) => redirect(`/message/${message.id}?notice=${code}`);
			if (action === "move") {
				const folder = FOLDERS.find(entry => entry === fields.folder && entry !== "sent");
				if (!folder) return text("No such folder", { status: 400 });
				if (message.folder !== "sent" || folder === "trash") message.folder = folder;
				return back(folder === "archive" ? "archived" : folder === "inbox" ? "inbox" : "trashed");
			}
			if (action === "star") {
				message.starred = !message.starred;
				return back(message.starred ? "starred" : "unstarred");
			}
			const label = labelNamed(fields.label ?? "");
			if (!label) return text("No such label", { status: 400 });
			if (action === "label" && !message.labels.includes(label)) message.labels.push(label);
			if (action === "unlabel") message.labels = message.labels.filter(entry => entry !== label);
			return back(action === "label" ? "labelled" : "unlabelled");
		}

		if (pathname === "/compose" && method === "GET") {
			const mode = composeMode(url.searchParams.get("mode"));
			const source = findMessage(world, url.searchParams.get("id") ?? "");
			if (mode !== "new" && !source) return text("No such message", { status: 404 });
			const prefill = composePrefill(world, source, mode);
			return composePage({ mode, source, ...prefill, attachments: [] });
		}
		if (pathname === "/compose/send" && method === "POST") return send(fields);

		if (pathname === "/settings") return redirect("/settings/filters");
		if (pathname === "/settings/filters" && method === "GET") {
			const created = url.searchParams.get("created");
			return filtersPage(
				created === null ? "" : `The filter was created${Number(created) > 0 ? ` and changed ${created} existing conversations` : ""}.`,
			);
		}
		if (pathname === "/settings/filters" && method === "POST") return createFilter(fields);
		const deleteFilter = /^\/settings\/filters\/([A-Z0-9-]+)\/delete$/.exec(pathname);
		if (deleteFilter && method === "POST") {
			const index = world.filters.findIndex(filter => filter.id === deleteFilter[1]);
			if (index >= 0) world.filters.splice(index, 1);
			return redirect("/settings/filters");
		}
		if (pathname === "/settings/labels" && method === "GET") return labelsPage();
		if (pathname === "/labels" && method === "POST") {
			const name = (fields.name ?? "").trim();
			const back = fields.back?.startsWith("/") ? fields.back : "/settings/labels";
			if (!name || name.length > 40) return labelsPage("", "A label name is 1 to 40 characters.");
			if (!labelNamed(name)) world.labels.push(name);
			return redirect(back);
		}
		if (pathname === "/labels/delete" && method === "POST") {
			const label = labelNamed(fields.name ?? "");
			if (label) {
				world.labels.splice(world.labels.indexOf(label), 1);
				for (const message of world.messages) message.labels = message.labels.filter(entry => entry !== label);
			}
			return redirect("/settings/labels");
		}
		return text("Not found", { status: 404 });
	};

	const site = await hostSite(request => {
		const session = sessionOf(request);
		const response = route(request, session.id);
		return session.fresh
			? { ...response, cookies: [...(response.cookies ?? []), { name: SESSION_COOKIE, value: session.id }] }
			: response;
	});

	return {
		origin: site.origin,
		close: () => site.close(),
		async finish() {
			await site.close();
			const messages: Record<string, { before: MessageState; now: MessageState }> = {};
			for (const message of world.messages) {
				const initial = before.get(message.id);
				if (initial) messages[message.id] = { before: initial, now: stateOf(message) };
			}
			return { messages, sent, filters: world.filters, labels: world.labels, failedSignins };
		},
	};
}
