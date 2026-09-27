/**
 * Tasks performed against Parcel Mail. Each plans its scenario on a freshly seeded mailbox, adding
 * the messages that make the answer unique and the ones that tempt a wrong answer, then grades what
 * the mailbox recorded: what was sent, moved, starred, labelled, and which filters exist.
 */

import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { type KitTask, kitTask } from "../../../../engine/kit/catalog";
import { answerStatesOnly, type Check, normalizeText } from "../../../../engine/kit/checks";
import { FormClient, type FormResponse } from "../../../../engine/kit/form-client";
import { Seeded } from "../../../../engine/kit/seeded";
import {
	addContact,
	addDays,
	addMessage,
	type ComposeMode,
	composePrefill,
	conditionValue,
	dateBetween,
	type Filter,
	type Folder,
	filterMatches,
	filterReaches,
	findMessage,
	firstName,
	forwardBlock,
	fullDate,
	generateMail,
	hoursAfter,
	type MailWorld,
	type Message,
	monthName,
	newPerson,
	newThreadId,
	PARTNER_DOMAINS,
	type Person,
	type SentMail,
	TODAY,
	timeOn,
	weekdayDate,
} from "./data";
import { type MailSnapshot, startMailSite } from "./site";

interface Expected<T> {
	readonly expected: T;
}

type MailState<T> = MailSnapshot & Expected<T>;

async function signedInClient(origin: string, world: MailWorld): Promise<FormClient> {
	const client = new FormClient(origin);
	const { email, password } = world.account;
	const response = await client.post("/signin", { email, password, next: "/mail/inbox" });
	if (!response.url.endsWith("/mail/inbox")) throw new Error(`signing in failed; it answered ${response.url}`);
	return client;
}

function signIn(origin: string, world: MailWorld): string {
	return `Parcel Mail is a webmail service at ${origin}. Sign in with email ${world.account.email} and password ${world.account.password}.`;
}

interface FormChange {
	readonly to?: readonly string[];
	readonly note: string;
	readonly attachments?: readonly string[];
}

/** Post the compose form's endpoint, starting from what the form is prefilled with. */
function postFromForm(
	client: FormClient,
	world: MailWorld,
	source: Message,
	mode: ComposeMode,
	change: FormChange,
): Promise<FormResponse> {
	const prefill = composePrefill(world, source, mode);
	return client.post("/compose/send", {
		mode,
		source: source.id,
		to: (change.to ?? prefill.to.map(person => person.email)).join(","),
		cc: prefill.cc.map(person => person.email).join(","),
		subject: prefill.subject,
		body: `${change.note}${prefill.body}`,
		attachments: (change.attachments ?? []).join(","),
	});
}

/** Send through the compose form's endpoint, and fail unless the site confirms the message was sent. */
async function sendFromForm(
	client: FormClient,
	world: MailWorld,
	source: Message,
	mode: ComposeMode,
	change: FormChange,
): Promise<void> {
	const response = await postFromForm(client, world, source, mode, change);
	if (!response.url.includes("notice=sent")) throw new Error(`the message was not sent; it answered ${response.url}`);
}

function onlySent(state: MailSnapshot): SentMail | undefined {
	return state.sent.length === 1 ? state.sent[0] : undefined;
}

const ONE_SENT: Check<MailSnapshot> = {
	id: "one-message-sent",
	description: "sent exactly one message",
	pass: state => state.sent.length === 1,
};

function sameSet(a: readonly string[], b: readonly string[]): boolean {
	return JSON.stringify([...new Set(a)].sort()) === JSON.stringify([...b].sort());
}

function recipients(mail: SentMail | undefined): string[] {
	return mail ? [...mail.to, ...mail.cc] : [];
}

function messageById(world: MailWorld, id: string): Message {
	const message = findMessage(world, id);
	if (!message) throw new Error(`message ${id} is not in the mailbox`);
	return message;
}

/**
 * What the account itself wrote in a message: quoted lines and the `On … wrote:` line dropped, and
 * nothing from a forwarded-message header on.
 */
function ownText(body: string): string {
	const lines: string[] = [];
	for (const line of body.split(/\r?\n/)) {
		if (/^\s*-{3,}\s*forwarded message/i.test(line)) break;
		if (/^\s*>/.test(line) || /^\s*on .+ wrote:\s*$/i.test(line)) continue;
		lines.push(line);
	}
	return lines.join("\n");
}

/** Whether the text names a `YYYY-MM-DD` day: `June 24`, `24 June`, `Jun 24th`, `2025-06-24`, `6/24`. */
function mentionsDate(text: string, day: string): boolean {
	const [year, month, date] = day.split("-").map(Number) as [number, number, number];
	const name = monthName(month - 1).toLowerCase();
	const monthPattern = `(?:${name}|${name.slice(0, 3)}${name === "september" ? "|sept" : ""})\\.?`;
	const dayPattern = `0?${date}(?:st|nd|rd|th)?`;
	const patterns = [
		`\\b${monthPattern}\\s+${dayPattern}\\b`,
		`\\b${dayPattern}\\s+(?:of\\s+)?${monthPattern}(?![a-z])`,
		`\\b${year}-${String(month).padStart(2, "0")}-${String(date).padStart(2, "0")}\\b`,
		`(?<![\\d/])0?${month}/0?${date}(?:/(?:${year}|${year % 100}))?(?![\\d/])`,
	];
	const normalized = normalizeText(text);
	return patterns.some(pattern => new RegExp(pattern).test(normalized));
}

/** Whether the text names an `HH:MM` time: `14:00`, `2pm`, `2:00 p.m.`, `09:30`, `9.30am`. */
function mentionsTime(text: string, time: string): boolean {
	const [hour, minute] = time.split(":").map(Number) as [number, number];
	const hour12 = hour % 12 === 0 ? 12 : hour % 12;
	const suffix = hour < 12 ? "a\\.?\\s?m\\b\\.?" : "p\\.?\\s?m\\b\\.?";
	const mm = String(minute).padStart(2, "0");
	const patterns = [`(?<![\\d:.])0?${hour}[:.h]${mm}(?!\\d)`, `(?<![\\d:.])${hour12}[:.]${mm}\\s*${suffix}`];
	if (minute === 0) patterns.push(`(?<![\\d:.])${hour12}\\s*${suffix}`, `(?<![\\d:.])0?${hour}h(?![\\d])`);
	const normalized = normalizeText(text);
	return patterns.some(pattern => new RegExp(pattern).test(normalized));
}

/** `$4,812.50` from cents. */
function dollars(cents: number): string {
	const [whole, fraction] = (cents / 100).toFixed(2).split(".") as [string, string];
	return `$${whole.replace(/\B(?=(\d{3})+(?!\d))/g, ",")}.${fraction}`;
}

function coworkers(world: MailWorld): Person[] {
	return world.contacts.filter(contact => contact.email.endsWith(`@${world.homeDomain}`));
}

function me(world: MailWorld): Person {
	return { name: world.account.name, email: world.account.email };
}

// ---------------------------------------------------------------------------------------------
// mail-reply-with-invoice-total

const VENDORS = [
	{ company: "Brightwater Supply", domain: "brightwater-supply.test", work: "office supplies" },
	{ company: "Kestrel Print Co.", domain: "kestrelprint.test", work: "print runs" },
	{ company: "Ironleaf Logistics", domain: "ironleaf-logistics.test", work: "freight handling" },
	{ company: "Tidewater Facilities", domain: "tidewater-facilities.test", work: "cleaning services" },
	{ company: "Copperline Networks", domain: "copperline.test", work: "network support" },
];

interface InvoiceReply {
	readonly company: string;
	readonly invoice: string;
	readonly originalId: string;
	readonly threadId: string;
	/** The address the invoice came from. */
	readonly sender: string;
	readonly amountCents: number;
	readonly dueDate: string;
	/** What the original email said before the correction. */
	readonly staleAmountCents: number;
	readonly staleDueDate: string;
}

function invoiceBody(
	to: string,
	invoice: string,
	work: string,
	cents: number,
	due: string,
	signer: Person,
	company: string,
): string {
	return `Hello ${to},\n\nPlease find attached invoice ${invoice} for ${work}.\n\nAmount due: ${dollars(cents)}\nDue date: ${fullDate(due)}\n\nPayment can be made by bank transfer to the account on file. Reply to this email with any questions about the invoice.\n\n${signer.name}\n${company}`;
}

function planInvoiceReply(world: MailWorld, rng: Seeded): InvoiceReply {
	const vendor = rng.pick(VENDORS);
	const user = me(world);
	const userFirst = firstName(user);
	const billing = addContact(world, newPerson(world, rng, vendor.domain));
	const accounts: Person = { name: `${vendor.company} Accounts`, email: `accounts@${vendor.domain}` };
	let number = rng.int(10000, 99990);
	while (String(number)[3] === String(number)[4]) number = rng.int(10000, 99990);
	const digits = String(number);
	const invoice = `INV-${digits}`;
	const swapped = `INV-${digits.slice(0, 3)}${digits[4]}${digits[3]}`;
	const later = `INV-${number + rng.int(1, 6)}`;
	const day = addDays("2025-05-02", rng.int(0, 18));
	const serviceMonth = monthName(new Date(`${day}T12:00:00Z`).getUTCMonth() - 1);
	const staleDueDate = addDays(day, 30);
	const dueDate = addDays(staleDueDate, rng.pick([5, 7, 10, 14]));
	const staleAmountCents = rng.int(1200, 9800) * 100 + rng.pick([0, 25, 50, 75]);
	const amountCents = staleAmountCents + rng.pick([-1, 1]) * rng.int(4, 36) * 2500;
	const subject = `Invoice ${invoice} for ${serviceMonth} ${vendor.work}`;
	const original = addMessage(world, rng, {
		from: billing,
		to: [user],
		subject,
		body: invoiceBody(
			userFirst,
			invoice,
			`${vendor.work} in ${serviceMonth}`,
			staleAmountCents,
			staleDueDate,
			billing,
			vendor.company,
		),
		date: timeOn(rng, day, 8, 17),
		folder: rng.next() < 0.7 ? "archive" : "inbox",
		labels: rng.next() < 0.5 ? ["Finance"] : [],
		attachments: [{ name: `${invoice}.pdf`, size: rng.int(40, 180) * 1024 }],
	});
	// The vendor's accounts team corrects the invoice in the same conversation.
	addMessage(world, rng, {
		from: accounts,
		to: [user],
		subject: `Re: ${subject}`,
		threadId: original.threadId,
		body: `Hello ${userFirst},\n\nWe need to correct invoice ${invoice}: one line was billed incorrectly. The corrected amount due is ${dollars(amountCents)}, and the due date is now ${fullDate(dueDate)}. Please disregard the amount and date in the original email; the invoice number stays the same.\n\nApologies for the confusion,\n${vendor.company} Accounts`,
		date: timeOn(rng, addDays(day, rng.int(4, 9)), 8, 17),
		folder: "inbox",
		read: false,
	});
	// A coworker forwards the original, uncorrected email.
	const coworker = rng.pick(coworkers(world));
	addMessage(world, rng, {
		from: coworker,
		to: [user],
		subject: `Fwd: ${subject}`,
		body: `Hi ${userFirst},\n\nThis landed with me by mistake, can you handle it?\n\n${firstName(coworker)}\n\n${forwardBlock(original)}`,
		date: timeOn(rng, addDays(day, rng.int(1, 3)), 8, 17),
		folder: "inbox",
		read: rng.next() < 0.5,
	});
	// The same vendor's other invoices, and a reminder about one of them.
	const swappedDay = addDays(day, -rng.int(20, 30));
	const swappedDue = addDays(swappedDay, 30);
	const swappedCents = rng.int(900, 9800) * 100 + rng.pick([0, 50]);
	addMessage(world, rng, {
		from: billing,
		to: [user],
		subject: `Invoice ${swapped} for ${monthName(new Date(`${swappedDay}T12:00:00Z`).getUTCMonth() - 1)} ${vendor.work}`,
		body: invoiceBody(userFirst, swapped, vendor.work, swappedCents, swappedDue, billing, vendor.company),
		date: timeOn(rng, swappedDay, 8, 17),
		folder: "archive",
		attachments: [{ name: `${swapped}.pdf`, size: rng.int(40, 180) * 1024 }],
	});
	addMessage(world, rng, {
		from: accounts,
		to: [user],
		subject: `Reminder: invoice ${swapped} is due ${fullDate(swappedDue)}`,
		body: `Hello ${userFirst},\n\nA friendly reminder that invoice ${swapped} for ${dollars(swappedCents)} is due on ${fullDate(swappedDue)}.\n\n${vendor.company} Accounts`,
		date: timeOn(rng, addDays(swappedDue, -3), 8, 17),
		folder: "inbox",
	});
	const laterDay = addDays(day, rng.int(2, 8));
	addMessage(world, rng, {
		from: billing,
		to: [user],
		subject: `Invoice ${later} for additional ${vendor.work}`,
		body: invoiceBody(
			userFirst,
			later,
			`additional ${vendor.work}`,
			rng.int(300, 2400) * 100,
			addDays(laterDay, 30),
			billing,
			vendor.company,
		),
		date: timeOn(rng, laterDay, 8, 17),
		folder: "inbox",
		attachments: [{ name: `${later}.pdf`, size: rng.int(40, 180) * 1024 }],
	});
	return {
		company: vendor.company,
		invoice,
		originalId: original.id,
		threadId: original.threadId,
		sender: billing.email,
		amountCents,
		dueDate,
		staleAmountCents,
		staleDueDate,
	};
}

const replyWithInvoiceTotal = kitTask<MailState<InvoiceReply>>({
	id: "mail-reply-with-invoice-total",
	title: "Reply to an invoice with the amount a later correction set",
	capabilities: ["search-filter", "reading", "reasoning", "forms", "auth"],
	difficulty: "medium",
	timeBudgetSec: 540,
	async start({ seed }) {
		const rng = new Seeded(seed);
		const world = generateMail(rng);
		const plan = planInvoiceReply(world, rng);
		const site = await startMailSite(world, seed);
		return {
			instruction: [
				signIn(site.origin, world),
				`${plan.company} emailed you invoice ${plan.invoice}. Reply to the email in which they sent that invoice: to its sender, in that email's conversation.`,
				"In the reply, state the amount currently due on that invoice and its current due date, and no other amount or due date.",
				"Send nothing else.",
			].join("\n"),
			solve: async () => {
				const client = await signedInClient(site.origin, world);
				const original = messageById(world, plan.originalId);
				await sendFromForm(client, world, original, "reply", {
					note: `Hello,\n\nThanks. To confirm, the amount due on ${plan.invoice} is ${dollars(plan.amountCents)}, due ${fullDate(plan.dueDate)}.`,
				});
				return `Replied: ${dollars(plan.amountCents)} due ${fullDate(plan.dueDate)}.`;
			},
			finish: async () => ({ ...(await site.finish()), expected: plan }),
		};
	},
	checks: [
		ONE_SENT,
		{
			id: "to-invoice-sender",
			description: "the reply goes to the invoice's sender and nobody else",
			pass: state => onlySent(state) !== undefined && sameSet(recipients(onlySent(state)), [state.expected.sender]),
		},
		{
			id: "in-invoice-conversation",
			description: "is a reply within the invoice email's conversation",
			pass: state => {
				const mail = onlySent(state);
				return mail?.threadId === state.expected.threadId && (mail.mode === "reply" || mail.mode === "replyall");
			},
		},
		{
			id: "corrected-amount",
			description: "states the corrected amount due, not the amount it replaced",
			pass: state => {
				const { amountCents, staleAmountCents, dueDate } = state.expected;
				// A reply names the due date's year, which reads as that many whole dollars.
				const replaced = staleAmountCents === Number(dueDate.slice(0, 4)) * 100 ? [] : [staleAmountCents / 100];
				return answerStatesOnly(ownText(onlySent(state)?.body ?? ""), amountCents / 100, replaced);
			},
		},
		{
			id: "corrected-due-date",
			description: "states the corrected due date, not the date it replaced",
			pass: state => {
				const own = ownText(onlySent(state)?.body ?? "");
				return mentionsDate(own, state.expected.dueDate) && !mentionsDate(own, state.expected.staleDueDate);
			},
		},
	],
});

// ---------------------------------------------------------------------------------------------
// mail-forward-with-attachment

const FORWARD_TOPICS = [
	{
		subject: "Offsite venue shortlist",
		noun: "venue",
		options: ["Harbor Loft", "The Glasshouse", "Millrace Hall", "Cedar Barn"],
		file: "venue-budget",
	},
	{
		subject: "Q3 supplier shortlist",
		noun: "supplier",
		options: ["Norland Parts", "Vesta Components", "Kiln and Co", "Brightforge"],
		file: "supplier-costs",
	},
	{
		subject: "Brand refresh proposals",
		noun: "agency",
		options: ["Studio Fathom", "Northpaw Design", "Inkwell Partners", "Quarry Creative"],
		file: "agency-quotes",
	},
	{
		subject: "Warehouse lease options",
		noun: "site",
		options: ["Dockside Unit 4", "Ridgeway Park", "Canal Street Depot", "Eastfield Yard"],
		file: "lease-comparison",
	},
];

/** A first name two contacts share, and surnames that start alike; no background contact has either. */
const TWIN_FIRST = ["Dana", "Sam", "Alex", "Jamie", "Kai", "Robin"];
const TWIN_SURNAMES: readonly (readonly [string, string])[] = [
	["Whitfield", "Whitman"],
	["Castillo", "Castellano"],
	["Novak", "Novotny"],
	["Lindqvist", "Lindgren"],
	["Hartley", "Hartman"],
	["Ashford", "Ashby"],
];

interface ForwardPlan {
	readonly subject: string;
	readonly latestId: string;
	readonly latestBody: string;
	readonly recipients: readonly string[];
	readonly names: readonly string[];
	readonly note: string;
	readonly file: { readonly name: string; readonly size: number; readonly sha256: string };
}

function planForward(world: MailWorld, rng: Seeded): ForwardPlan & { readonly content: string } {
	const topic = rng.pick(FORWARD_TOPICS);
	const user = me(world);
	const [lead, colleague] = rng.sample(coworkers(world), 2) as [Person, Person];
	const [o1, o2, o3, o4] = rng.shuffle(topic.options) as [string, string, string, string];
	const start = addDays("2025-05-20", rng.int(0, 14));
	const code = rng.code(4);
	const threadId = newThreadId(world, rng);
	const first = addMessage(world, rng, {
		from: lead,
		to: [user, colleague],
		subject: topic.subject,
		threadId,
		body: `Hi both,\n\nStarting a shortlist of ${topic.noun}s for us: ${o1}, ${o2} and ${o3}. First impressions welcome before I ask for quotes.\n\n${firstName(lead)}`,
		date: timeOn(rng, start, 8, 12),
		folder: "archive",
	});
	const reply = addMessage(world, rng, {
		from: user,
		to: [lead, colleague],
		subject: `Re: ${topic.subject}`,
		threadId,
		body: `I've heard good things about ${o2}. ${o4} might be worth a look too.\n\n${firstName(user)}`,
		date: hoursAfter(first.date, rng.int(3, 20)),
		folder: "sent",
	});
	const visit = addMessage(world, rng, {
		from: colleague,
		to: [lead, user],
		subject: `Re: ${topic.subject}`,
		threadId,
		body: `I visited ${o1} and ${o4} on Tuesday. ${o4} is too small for us, so I'd drop it.\n\n${firstName(colleague)}`,
		date: hoursAfter(reply.date, rng.int(20, 60)),
		folder: rng.next() < 0.5 ? "archive" : "inbox",
	});
	const prices = [o1, o2, o3].map(option => ({ option, cents: rng.int(18, 95) * 10000 }));
	const favourite = rng.pick(prices);
	const latest = addMessage(world, rng, {
		from: lead,
		to: [user, colleague],
		subject: `Re: ${topic.subject}`,
		threadId,
		body: `Final quotes for the ${topic.noun}s we kept:\n\n${prices.map(entry => `- ${entry.option}: ${dollars(entry.cents)}`).join("\n")}\n\nI lean towards ${favourite.option}. Quote reference ${code}-${rng.int(100, 999)}.\n\n${firstName(lead)}`,
		date: hoursAfter(visit.date, rng.int(20, 70)),
		folder: "inbox",
		read: false,
	});
	// A conversation whose subject starts the same, newer than the one asked about.
	const sideThread = newThreadId(world, rng);
	const side = addMessage(world, rng, {
		from: colleague,
		to: [user, lead],
		subject: `${topic.subject}: catering`,
		threadId: sideThread,
		body: `Separate thread for catering so the ${topic.noun} one stays readable. ${o2} has an in-house kitchen; the others would need an outside caterer.\n\n${firstName(colleague)}`,
		date: hoursAfter(latest.date, rng.int(4, 30)),
		folder: "inbox",
	});
	addMessage(world, rng, {
		from: lead,
		to: [user, colleague],
		subject: `Re: ${topic.subject}: catering`,
		threadId: sideThread,
		body: `Good point. Let's decide on catering once the ${topic.noun} is booked.\n\n${firstName(lead)}`,
		date: hoursAfter(side.date, rng.int(2, 20)),
		folder: "inbox",
	});
	// Two contacts share a first name, and their surnames start alike.
	const twinFirst = rng.pick(TWIN_FIRST);
	const [surnameA, surnameB] = rng.shuffle(rng.pick(TWIN_SURNAMES)) as [string, string];
	const [domainA, domainB] = rng.sample(PARTNER_DOMAINS, 2) as [string, string];
	const target = addContact(world, newPerson(world, rng, domainA, { first: twinFirst, last: surnameA }));
	const twin = addContact(world, newPerson(world, rng, domainB, { first: twinFirst, last: surnameB }));
	addMessage(world, rng, {
		from: twin,
		to: [user],
		subject: "Catching up next month?",
		body: `Hi ${firstName(user)},\n\nI'll be in town the second week of July. Coffee?\n\n${twinFirst}`,
		date: dateBetween(rng, "2025-04-01", "2025-06-10"),
		folder: "inbox",
	});
	const other = rng.pick(
		world.contacts.filter(
			contact => !contact.email.endsWith(`@${world.homeDomain}`) && contact !== target && contact !== twin,
		),
	);
	const note = `Budget sheet attached; please check the ${topic.noun} figures before Friday (ref ${code}).`;
	const rows = ["option,capacity,day_rate_usd,catering_usd,av_usd"];
	for (const option of topic.options) {
		rows.push(`${option},${rng.int(40, 260)},${rng.int(900, 9800)},${rng.int(0, 4000)},${rng.int(0, 1500)}`);
	}
	for (let month = 1; month <= 12; month++) {
		rows.push(`budget-2025-${String(month).padStart(2, "0")},,${rng.int(2000, 12000)},,`);
	}
	const content = `${rows.join("\n")}\n`;
	const bytes = Buffer.from(content, "utf8");
	return {
		subject: topic.subject,
		latestId: latest.id,
		latestBody: latest.body,
		recipients: [target.email, other.email],
		names: [target.name, other.name],
		note,
		file: {
			name: `${topic.file}-${code.toLowerCase()}.csv`,
			size: bytes.length,
			sha256: createHash("sha256").update(bytes).digest("hex"),
		},
		content,
	};
}

const forwardWithAttachment = kitTask<MailState<ForwardPlan>>({
	id: "mail-forward-with-attachment",
	title: "Forward the latest message of a conversation to two contacts, with a file",
	capabilities: ["overlays", "uploads", "forms", "search-filter", "auth"],
	difficulty: "hard",
	timeBudgetSec: 720,
	async start({ seed, workspace }) {
		const rng = new Seeded(seed);
		const world = generateMail(rng);
		const { content, ...plan } = planForward(world, rng);
		await fs.writeFile(path.join(workspace, plan.file.name), content);
		const site = await startMailSite(world, seed);
		return {
			instruction: [
				signIn(site.origin, world),
				`Forward the latest message in the conversation titled "${plan.subject}" to ${plan.names[0]} and ${plan.names[1]}; both are in your contacts. Send it to those two people only.`,
				`Above the forwarded message, add this one-line note: ${plan.note}`,
				`Attach the file ${plan.file.name} from your working directory.`,
			].join("\n"),
			solve: async () => {
				const client = await signedInClient(site.origin, world);
				const data = Buffer.from(content, "utf8").toString("base64");
				const uploaded = await client.postJson("/api/attachments", { name: plan.file.name, data });
				const parsed: unknown = JSON.parse(uploaded.body);
				const id =
					parsed !== null && typeof parsed === "object" && "id" in parsed && typeof parsed.id === "string"
						? parsed.id
						: "";
				if (!id) throw new Error(`the attachment was not uploaded: ${uploaded.body}`);
				const latest = messageById(world, plan.latestId);
				await sendFromForm(client, world, latest, "forward", { to: plan.recipients, note: plan.note, attachments: [id] });
				return `Forwarded it to ${plan.names.join(" and ")}.`;
			},
			finish: async () => ({ ...(await site.finish()), expected: plan }),
		};
	},
	checks: [
		ONE_SENT,
		{
			id: "forwards-latest",
			description: "forwards the conversation's latest message",
			pass: state => onlySent(state)?.mode === "forward" && onlySent(state)?.sourceId === state.expected.latestId,
		},
		{
			id: "recipients-exact",
			description: "goes to the two named contacts and nobody else",
			pass: state => onlySent(state) !== undefined && sameSet(recipients(onlySent(state)), state.expected.recipients),
		},
		{
			id: "note-present",
			description: "carries the note",
			pass: state => normalizeText(onlySent(state)?.body ?? "").includes(normalizeText(state.expected.note)),
		},
		{
			id: "original-included",
			description: "includes the forwarded message's text",
			pass: state => normalizeText(onlySent(state)?.body ?? "").includes(normalizeText(state.expected.latestBody)),
		},
		{
			id: "file-attached",
			description: "attaches the workspace file, byte for byte",
			pass: state => {
				const attachments = onlySent(state)?.attachments ?? [];
				const file = state.expected.file;
				const [attachment] = attachments;
				return (
					attachments.length === 1 &&
					attachment?.name === file.name &&
					attachment.size === file.size &&
					attachment.sha256 === file.sha256
				);
			},
		},
	],
});

// ---------------------------------------------------------------------------------------------
// mail-bulk-archive-newsletters

const NEWSLETTER_BRANDS = [
	{ brand: "Lumen Weekly", domain: "lumenweekly.test", hyphenated: "lumen-weekly.test" },
	{ brand: "Harbor Digest", domain: "harbordigest.test", hyphenated: "harbor-digest.test" },
	{ brand: "Quillpost", domain: "quillpost.test", hyphenated: "quill-post.test" },
	{ brand: "Tallgrass Review", domain: "tallgrassreview.test", hyphenated: "tallgrass-review.test" },
];

const NEWSLETTER_TOPICS = [
	"the best reads of the month",
	"five questions for our editors",
	"a walking tour of old harbors",
	"what we got wrong this year",
	"letters from readers",
	"the long history of maps",
	"an interview with a luthier",
	"notes from the archive",
];

interface BulkArchive {
	readonly domain: string;
	readonly cutoff: string;
	readonly archive: readonly string[];
	readonly star: readonly string[];
}

function planBulkArchive(world: MailWorld, rng: Seeded): BulkArchive {
	const { brand, domain, hyphenated } = rng.pick(NEWSLETTER_BRANDS);
	const user = me(world);
	const senders: Person[] = [
		{ name: brand, email: `newsletter@${domain}` },
		{ name: `${brand} Editors`, email: `editors@${domain}` },
		{ name: `${brand} Members`, email: `members@${domain}` },
	];
	let issue = rng.int(120, 180);
	const plain = () =>
		rng.pick([
			`${brand} #${issue++}: ${rng.pick(NEWSLETTER_TOPICS)}`,
			`This week at ${brand}: ${rng.pick(NEWSLETTER_TOPICS)}`,
			`${brand} members: ${rng.pick(NEWSLETTER_TOPICS)}`,
			`Your ${brand} reading list`,
			`Events this month from ${brand}`,
		]);
	const renewals = rng.shuffle([
		`Your ${brand} renewal is coming up`,
		`Renewal notice for your ${brand} membership`,
		`${brand}: auto-renewal reminder`,
		"Early renewal pricing ends Friday",
		"Action needed: membership RENEWAL",
		`Thank you for your renewal, ${brand} member`,
	]);
	const mention = " Members whose renewal is due this quarter get early access to the spring events.";
	const body = (mentionRenewal: boolean) =>
		`In this issue: ${rng.pick(NEWSLETTER_TOPICS)}, ${rng.pick(NEWSLETTER_TOPICS)}, and more.${mentionRenewal ? mention : ""}` +
		`\n\nYou receive this because you subscribed to ${brand}.`;
	const add = (
		from: Person,
		subject: string,
		date: string,
		folder: Folder,
		extra: { readonly starred?: boolean; readonly mention?: boolean } = {},
	) =>
		addMessage(world, rng, {
			from,
			to: [user],
			subject,
			body: body(extra.mention === true),
			date,
			folder,
			labels: rng.next() < 0.5 ? ["Newsletters"] : [],
			starred: extra.starred === true,
			read: rng.next() < 0.7,
		});
	const cutoff = addDays("2025-02-10", rng.int(0, 60));
	const beforeCutoff = addDays(cutoff, -1);
	const oldDate = () => dateBetween(rng, "2024-10-01", beforeCutoff);
	const oldDates = Array.from({ length: rng.int(18, 23) }, oldDate).sort();
	const newDate = () => dateBetween(rng, addDays(cutoff, 1), addDays(TODAY, -1));
	const newDates = Array.from({ length: rng.int(10, 14) }, newDate).sort();
	const renewalAt = new Set(rng.sample(oldDates.map((_, index) => index), rng.int(3, 5)));
	const others = oldDates.map((_, index) => index).filter(index => !renewalAt.has(index));
	const [mentionAt, starredAt] = rng.sample(others, 2) as [number, number];
	let renewal = 0;
	const nextRenewal = () => renewals[renewal++ % renewals.length] as string;
	const archive: string[] = [];
	const star: string[] = [];
	oldDates.forEach((date, index) => {
		const from = rng.pick(senders);
		if (renewalAt.has(index)) star.push(add(from, nextRenewal(), date, "inbox").id);
		else archive.push(add(from, plain(), date, "inbox", { mention: index === mentionAt, starred: index === starredAt }).id);
	});
	add(rng.pick(senders), plain(), timeOn(rng, cutoff, 7, 10), "inbox");
	const newRenewals = new Set(rng.sample(newDates.map((_, index) => index), 2));
	newDates.forEach((date, index) => {
		const subject = newRenewals.has(index) ? nextRenewal() : plain();
		add(rng.pick(senders), subject, date, "inbox", { starred: index === 0 && !newRenewals.has(index) });
	});
	// Old newsletters already outside the Inbox.
	add(rng.pick(senders), plain(), oldDate(), "archive");
	add(rng.pick(senders), plain(), oldDate(), "archive");
	add(rng.pick(senders), nextRenewal(), oldDate(), "archive");
	add(rng.pick(senders), nextRenewal(), oldDate(), "trash");
	// Old newsletters in the Inbox from other domains that look like it.
	const lookalike: Person = { name: `${brand} Deals`, email: `offers@get${domain}` };
	add(lookalike, `Early renewal pricing from ${brand} Deals`, oldDate(), "inbox");
	add(lookalike, `Deals for ${brand} readers`, oldDate(), "inbox");
	add({ name: brand, email: `news@${hyphenated}` }, plain(), oldDate(), "inbox");
	add({ name: `${brand} Digest`, email: "digest@partner-mailer.test" }, plain(), oldDate(), "inbox");
	return { domain, cutoff, archive: archive.sort(), star: star.sort() };
}

const bulkArchiveNewsletters = kitTask<MailState<BulkArchive>>({
	id: "mail-bulk-archive-newsletters",
	title: "Archive a sender's old newsletters, starring the renewal notices instead",
	capabilities: ["virtualized", "search-filter", "reasoning", "auth"],
	difficulty: "hard",
	timeBudgetSec: 780,
	async start({ seed }) {
		const rng = new Seeded(seed);
		const world = generateMail(rng);
		const plan = planBulkArchive(world, rng);
		const site = await startMailSite(world, seed);
		return {
			instruction: [
				signIn(site.origin, world),
				`Your Inbox holds many newsletters sent from addresses at the domain ${plan.domain}. Clean them up:`,
				`- archive every one of them in the Inbox dated before ${fullDate(plan.cutoff)};`,
				"- except those whose subject mentions renewal: star those instead and leave them in the Inbox.",
				"Change nothing else: not newsletters from any other domain, not newer ones, and not mail outside the Inbox.",
			].join("\n"),
			solve: async () => {
				const client = await signedInClient(site.origin, world);
				for (const [action, ids] of [
					["archive", plan.archive],
					["star", plan.star],
				] as const) {
					const response = await client.postJson("/api/bulk", { action, ids });
					if (response.status !== 200) throw new Error(`${action} failed: ${response.body}`);
				}
				return `Archived ${plan.archive.length} newsletters and starred ${plan.star.length} renewal notices.`;
			},
			finish: async () => ({ ...(await site.finish()), expected: plan }),
		};
	},
	checks: [
		{
			id: "archived-exact",
			description: "archived exactly the older newsletters from the domain that are not about renewal",
			pass: state =>
				sameSet(
					Object.entries(state.messages)
						.filter(([, entry]) => entry.before.folder === "inbox" && entry.now.folder === "archive")
						.map(([id]) => id),
					state.expected.archive,
				),
		},
		{
			id: "renewals-starred",
			description: "starred every older renewal notice from the domain and left it in the Inbox",
			pass: state =>
				state.expected.star.every(id => {
					const now = state.messages[id]?.now;
					return now?.starred === true && now.folder === "inbox";
				}),
		},
		{
			id: "stars-exact",
			description: "starred nothing else and removed no star",
			pass: state =>
				sameSet(
					Object.entries(state.messages)
						.filter(([, entry]) => entry.before.starred !== entry.now.starred)
						.map(([id]) => id),
					state.expected.star,
				) && state.expected.star.every(id => state.messages[id]?.now.starred === true),
		},
		{
			id: "nothing-deleted",
			description: "moved nothing to the Trash",
			pass: state =>
				Object.values(state.messages).every(entry => entry.now.folder !== "trash" || entry.before.folder === "trash"),
		},
		{
			id: "nothing-else-changed",
			description: "changed no label and moved no other message",
			pass: state => {
				const archived = new Set(state.expected.archive);
				return Object.entries(state.messages).every(
					([id, entry]) =>
						JSON.stringify(entry.now.labels) === JSON.stringify(entry.before.labels) &&
						(archived.has(id) || entry.now.folder === entry.before.folder),
				);
			},
		},
	],
});

// ---------------------------------------------------------------------------------------------
// mail-create-filter-and-apply

const CLOUD_VENDORS = [
	{ brand: "Corvid Cloud", domain: "corvid-cloud.test" },
	{ brand: "Stratus Hosting", domain: "stratus-hosting.test" },
	{ brand: "Nimbus Works", domain: "nimbusworks.test" },
	{ brand: "Cirrus Stack", domain: "cirrus-stack.test" },
];
const REPORTS = [
	{ phrase: "usage summary", alert: "Usage alert" },
	{ phrase: "cost report", alert: "Cost alert" },
	{ phrase: "capacity digest", alert: "Capacity alert" },
];
const FILTER_LABELS = ["Cloud reports", "Infra costs", "Hosting mail"];
const PROJECTS = ["atlas", "beacon", "cinder", "delta", "ember", "fjord"];

interface FilterPlan {
	readonly from: string;
	readonly subject: string;
	readonly label: string;
	/** Existing mail the filter reaches when applied. */
	readonly matches: readonly string[];
}

function capitalized(text: string): string {
	return `${text[0]?.toUpperCase() ?? ""}${text.slice(1)}`;
}

function planFilter(world: MailWorld, rng: Seeded): FilterPlan {
	const vendor = rng.pick(CLOUD_VENDORS);
	const report = rng.pick(REPORTS);
	const label = rng.pick(FILTER_LABELS);
	const user = me(world);
	const reports: Person = { name: `${vendor.brand} Reports`, email: `reports@${vendor.domain}` };
	const phrase = report.phrase;
	const month = () => monthName(rng.int(0, 5));
	const subjects = rng.shuffle([
		`Weekly ${phrase} — week ${rng.int(2, 24)}`,
		`${capitalized(phrase)} for ${month()}`,
		`[${vendor.brand}] ${phrase}: project ${rng.pick(PROJECTS)}`,
		`Your ${phrase} is ready`,
		`${phrase.toUpperCase()} (${month()} 2025)`,
		`Weekly ${phrase} — week ${rng.int(25, 30)}`,
		`Monthly ${phrase}: all projects`,
	]);
	const count = rng.int(5, 7);
	const reportBody = () =>
		`Here is your ${phrase} for the projects on your account. Compute and storage are listed per project; nothing needs your action.\n\n${vendor.brand}`;
	const recent = () => dateBetween(rng, "2025-01-06", addDays(TODAY, -1));
	const inboxCount = Math.ceil(count / 2);
	const folders = rng.shuffle(Array.from({ length: count }, (_, index): Folder => (index < inboxCount ? "inbox" : "archive")));
	const matches = subjects.slice(0, count).map(
		(subject, index) =>
			addMessage(world, rng, {
				from: reports,
				to: [user],
				subject,
				body: reportBody(),
				date: recent(),
				folder: folders[index] as Folder,
				labels: rng.next() < 0.3 ? ["Work"] : [],
				read: rng.next() < 0.7,
			}).id,
	);
	const lookalike = (from: Person, subject: string, folder: Folder, body = reportBody()) =>
		addMessage(world, rng, { from, to: [user], subject, body, date: recent(), folder });
	lookalike(reports, `${report.alert}: threshold reached on project ${rng.pick(PROJECTS)}`, "inbox");
	lookalike(reports, `Billing notice for ${month()}`, "inbox", `Your invoice is ready in the console. Your ${phrase} follows separately.\n\n${vendor.brand}`);
	lookalike(
		{ name: `${vendor.brand} EU Reports`, email: `reports@${vendor.domain.replace(".test", "-eu.test")}` },
		`Weekly ${phrase} — week ${rng.int(2, 24)}`,
		"inbox",
	);
	lookalike({ name: `${vendor.brand} Alerts`, email: `alerts@${vendor.domain}` }, `Your ${phrase} is delayed`, "inbox");
	lookalike(reports, `${capitalized(phrase)} for ${month()}`, "trash");
	// A coworker forwards a report that went to them; only the forward is in this mailbox.
	const coworker = rng.pick(coworkers(world));
	const theirs: Message = {
		id: "",
		threadId: "",
		from: reports,
		to: [coworker],
		cc: [],
		subject: `Weekly ${phrase} — week ${rng.int(2, 24)}`,
		body: reportBody(),
		date: dateBetween(rng, "2025-01-06", "2025-03-01"),
		attachments: [],
		folder: "archive",
		labels: [],
		starred: false,
		read: true,
		seeded: true,
	};
	lookalike(coworker, `Fwd: ${theirs.subject}`, "inbox", `FYI, in case you want these too.\n\n${forwardBlock(theirs)}`);
	const filter: Pick<Filter, "match" | "conditions"> = {
		match: "all",
		conditions: [
			{ field: "from", value: reports.email },
			{ field: "subject", value: phrase },
		],
	};
	const reached = world.messages.filter(message => filterReaches(message) && filterMatches(filter, message));
	if (!sameSet(reached.map(message => message.id), matches)) throw new Error("the filter plan reaches mail it did not add");
	if (world.labels.some(existing => existing.toLowerCase() === label.toLowerCase())) {
		throw new Error(`${label} already exists`);
	}
	return { from: reports.email, subject: phrase, label, matches: [...matches].sort() };
}

function conditionKey(field: string, value: string): string {
	return `${field}|${conditionValue(value)}`;
}

function newFilters(state: MailSnapshot): readonly Filter[] {
	return state.filters.filter(filter => !filter.seeded);
}

const createFilterAndApply = kitTask<MailState<FilterPlan>>({
	id: "mail-create-filter-and-apply",
	title: "Create a two-condition filter and apply it to existing mail",
	capabilities: ["forms", "multi-page", "reasoning", "auth"],
	difficulty: "medium",
	timeBudgetSec: 480,
	async start({ seed }) {
		const rng = new Seeded(seed);
		const world = generateMail(rng);
		const plan = planFilter(world, rng);
		const site = await startMailSite(world, seed);
		return {
			instruction: [
				signIn(site.origin, world),
				`Create a filter for mail whose sender contains ${plan.from} and whose subject contains "${plan.subject}".`,
				`It should apply the label "${plan.label}" (a label that does not exist yet) and skip the Inbox, and do nothing else.`,
				"Apply it to the matching mail already in the mailbox as well. Change no other mail.",
			].join("\n"),
			solve: async () => {
				const client = await signedInClient(site.origin, world);
				const response = await client.post("/settings/filters", {
					match: "all",
					field0: "from",
					value0: plan.from,
					field1: "subject",
					value1: plan.subject,
					label: "__new",
					newLabel: plan.label,
					archive: "on",
					applyExisting: "on",
				});
				if (!response.url.includes("created=")) throw new Error(`the filter was not created; it answered ${response.url}`);
				return "Created the filter and applied it to existing mail.";
			},
			finish: async () => ({ ...(await site.finish()), expected: plan }),
		};
	},
	checks: [
		{ id: "one-new-filter", description: "created exactly one filter", pass: state => newFilters(state).length === 1 },
		{
			id: "filter-conditions",
			description: "the filter matches on both conditions together",
			pass: state => {
				const filter = newFilters(state)[0];
				if (!filter || filter.conditions.length !== 2 || filter.match !== "all") return false;
				return sameSet(
					filter.conditions.map(condition => conditionKey(condition.field, condition.value)),
					[conditionKey("from", state.expected.from), conditionKey("subject", state.expected.subject)],
				);
			},
		},
		{
			id: "filter-actions",
			description: "the filter applies the label and skips the Inbox, and does nothing else",
			pass: state => {
				const actions = newFilters(state)[0]?.actions;
				return (
					actions !== undefined &&
					actions.label?.trim().toLowerCase() === state.expected.label.toLowerCase() &&
					actions.archive &&
					!actions.star &&
					!actions.markRead &&
					!actions.trash
				);
			},
		},
		{
			id: "existing-mail-filed",
			description: "every matching message already in the mailbox carries the label and is out of the Inbox",
			pass: state =>
				state.expected.matches.every(id => {
					const now = state.messages[id]?.now;
					return now?.folder === "archive" && now.labels.some(label => label.trim().toLowerCase() === state.expected.label.toLowerCase());
				}),
		},
		{
			id: "lookalikes-untouched",
			description: "no other message changed",
			pass: state => {
				const matched = new Set(state.expected.matches);
				return Object.entries(state.messages).every(
					([id, entry]) => matched.has(id) || JSON.stringify(entry.before) === JSON.stringify(entry.now),
				);
			},
		},
	],
});

// ---------------------------------------------------------------------------------------------
// mail-reschedule-meeting

const MEETING_TOPICS = [
	"Atlas launch review",
	"Q3 planning review",
	"Harbor app design critique",
	"vendor contract review",
	"onboarding revamp kickoff",
];
const SLOT_TIMES = ["09:00", "09:30", "10:00", "11:00", "13:30", "14:00", "15:00", "16:30"];

interface Slot {
	readonly day: string;
	readonly time: string;
}

type SlotStyle = "long" | "short" | "numeric";

function twelveHour(time: string): string {
	const [hour, minute] = time.split(":").map(Number) as [number, number];
	const hour12 = hour % 12 === 0 ? 12 : hour % 12;
	return `${hour12}${minute === 0 ? "" : `:${String(minute).padStart(2, "0")}`}${hour < 12 ? "am" : "pm"}`;
}

/** A slot as one person writes it: `Tuesday, June 24 at 10:00`, `Tue Jun 24, 10am`, or `6/24 at 10:00`. */
function slotText(style: SlotStyle, slot: Slot): string {
	const [weekday, monthDay] = weekdayDate(slot.day).split(", ") as [string, string];
	const [month, date] = monthDay.split(" ") as [string, string];
	if (style === "long") return `${weekday}, ${monthDay} at ${slot.time}`;
	if (style === "short") return `${weekday.slice(0, 3)} ${month.slice(0, 3)} ${date}, ${twelveHour(slot.time)}`;
	return `${Number(slot.day.slice(5, 7))}/${Number(slot.day.slice(8, 10))} at ${slot.time}`;
}

interface Meeting {
	readonly subject: string;
	readonly threadId: string;
	readonly recipients: readonly string[];
	readonly slot: Slot;
	readonly otherSlots: readonly Slot[];
}

function planMeeting(world: MailWorld, rng: Seeded): Meeting & { readonly groupMessageId: string } {
	const topic = rng.pick(MEETING_TOPICS);
	const user = me(world);
	const [organizer, second, third, copied] = rng.sample(coworkers(world), 4) as [Person, Person, Person, Person];
	const weekdays: string[] = [];
	for (let day = "2025-06-23"; day <= "2025-07-11"; day = addDays(day, 1)) {
		const weekday = new Date(`${day}T12:00:00Z`).getUTCDay();
		if (weekday !== 0 && weekday !== 6) weekdays.push(day);
	}
	const slots = rng.sample(weekdays, 5).map((day): Slot => ({ day, time: rng.pick(SLOT_TIMES) }));
	const [withdrawn, dayOff, onlyTwo, answer, onlyOne] = slots as [Slot, Slot, Slot, Slot, Slot];
	const styles = rng.shuffle<SlotStyle>(["long", "short", "numeric"]);
	const [styleA, styleB, styleC] = styles as [SlotStyle, SlotStyle, SlotStyle];
	const a = (slot: Slot) => slotText(styleA, slot);
	const b = (slot: Slot) => slotText(styleB, slot);
	const c = (slot: Slot) => slotText(styleC, slot);
	const subject = `Moving the ${topic}`;
	const threadId = newThreadId(world, rng);
	const group = (from: Person) => ({
		from,
		to: [organizer, second, third, user].filter(person => person !== from),
		cc: [copied],
		threadId,
		folder: "inbox" as const,
	});
	const [firstAsk, secondAsk] = rng.shuffle([withdrawn, dayOff]) as [Slot, Slot];
	const opening = addMessage(world, rng, {
		...group(organizer),
		subject,
		body: `Hi all,\n\nThe ${topic} can't happen on its original date, so let's find a new slot. I can do any of these:\n\n${rng
			.shuffle([withdrawn, dayOff, onlyTwo])
			.map(slot => `- ${a(slot)}`)
			.join("\n")}\n\nWhich of them work for you?\n\n${firstName(organizer)}`,
		date: timeOn(rng, addDays("2025-06-09", rng.int(0, 3)), 8, 11),
	});
	const fromSecond = addMessage(world, rng, {
		...group(second),
		subject: `Re: ${subject}`,
		body: `${b(firstAsk)} and ${b(secondAsk)} both work for me. ${b(onlyTwo)} doesn't, I have a clash. If none of those land, ${b(answer)} would also work for me.\n\n${firstName(second)}`,
		date: hoursAfter(opening.date, rng.int(2, 18)),
	});
	const fromThird = addMessage(world, rng, {
		...group(third),
		subject: `Re: ${subject}`,
		body: `From my side ${c(onlyTwo)}, ${c(secondAsk)} and ${c(firstAsk)} are all fine, and ${c(answer)} works too. ${c(onlyOne)} would also be possible for me.\n\n${firstName(third)}`,
		date: hoursAfter(fromSecond.date, rng.int(2, 18)),
	});
	// The withdrawal goes to everyone; the day off is told to the account alone, in either order.
	const [updateHours, privateHours] = rng.shuffle([rng.int(3, 20), rng.int(24, 40)]) as [number, number];
	const update = addMessage(world, rng, {
		...group(organizer),
		subject: `Re: ${subject}`,
		body: `Update from me: I have to take ${a(withdrawn)} off the list, something came up. ${a(answer)} works for me as well.\n\n${firstName(organizer)}`,
		date: hoursAfter(fromThird.date, updateHours),
	});
	const confidant = rng.pick([second, third]);
	addMessage(world, rng, {
		from: confidant,
		to: [user],
		subject: `Re: ${subject}`,
		threadId,
		body: `Sending this just to you rather than the whole group: I'll be out all day on ${weekdayDate(dayOff.day)}, so nothing that day works for me after all.\n\n${firstName(confidant)}`,
		date: hoursAfter(fromThird.date, privateHours),
		folder: "inbox",
		read: false,
	});
	return {
		subject,
		threadId,
		recipients: [organizer.email, second.email, third.email, copied.email],
		slot: answer,
		otherSlots: [withdrawn, dayOff, onlyTwo, onlyOne],
		groupMessageId: update.id,
	};
}

const rescheduleMeeting = kitTask<MailState<Meeting>>({
	id: "mail-reschedule-meeting",
	title: "Reply all with the one meeting slot everyone can still attend",
	capabilities: ["reading", "reasoning", "forms", "search-filter", "auth"],
	difficulty: "expert",
	timeBudgetSec: 900,
	async start({ seed }) {
		const rng = new Seeded(seed);
		const world = generateMail(rng);
		const { groupMessageId, ...plan } = planMeeting(world, rng);
		const site = await startMailSite(world, seed);
		const nameOf = (email: string) => world.contacts.find(contact => contact.email === email)?.name ?? email;
		const people = plan.recipients.slice(0, 3).map(nameOf);
		return {
			instruction: [
				signIn(site.origin, world),
				`The conversation "${plan.subject}" is about finding a new time for a meeting of ${people[0]}, ${people[1]} and ${people[2]}.`,
				"Work out the one proposed slot all three of them can still attend; your own calendar is free at every proposed time.",
				"Then reply all on that conversation, so that everyone on it receives your reply, proposing that slot: state its date and time, and mention no other slot.",
			].join("\n"),
			solve: async () => {
				const client = await signedInClient(site.origin, world);
				const source = messageById(world, groupMessageId);
				await sendFromForm(client, world, source, "replyall", {
					note: `Hi all,\n\nLet's meet on ${weekdayDate(plan.slot.day)} at ${plan.slot.time}; it is the one slot all three of you can make.`,
				});
				return `Proposed ${weekdayDate(plan.slot.day)} at ${plan.slot.time}.`;
			},
			finish: async () => ({ ...(await site.finish()), expected: plan }),
		};
	},
	checks: [
		ONE_SENT,
		{
			id: "in-conversation",
			description: "is a reply within the meeting conversation",
			pass: state => {
				const mail = onlySent(state);
				return mail?.threadId === state.expected.threadId && (mail.mode === "reply" || mail.mode === "replyall");
			},
		},
		{
			id: "everyone-on-it",
			description: "goes to everyone on the conversation and nobody else",
			pass: state => onlySent(state) !== undefined && sameSet(recipients(onlySent(state)), state.expected.recipients),
		},
		{
			id: "states-the-slot",
			description: "states the date and time of the one slot everyone can attend",
			pass: state => {
				const own = ownText(onlySent(state)?.body ?? "");
				return mentionsDate(own, state.expected.slot.day) && mentionsTime(own, state.expected.slot.time);
			},
		},
		{
			id: "no-other-slot",
			description: "mentions no other proposed slot",
			pass: state => {
				const mail = onlySent(state);
				if (!mail) return false;
				const own = ownText(mail.body);
				return state.expected.otherSlots.every(slot => !(mentionsDate(own, slot.day) && mentionsTime(own, slot.time)));
			},
		},
	],
});

// ---------------------------------------------------------------------------------------------
// mail-send-after-session-expiry

interface QuotedItem {
	readonly item: string;
	/** The two options every quote for the item prices. */
	readonly options: readonly [string, string];
}

const QUOTED_ITEMS: readonly QuotedItem[] = [
	{ item: "standing desks", options: ["delivery only", "delivery and assembly"] },
	{ item: "meeting-room displays", options: ["wall-mounted", "rolling-stand"] },
	{ item: "ergonomic chairs", options: ["mesh-back", "upholstered"] },
	{ item: "team laptops", options: ["standard-warranty", "extended-warranty"] },
	{ item: "office printers", options: ["purchase", "three-year lease"] },
];

interface Supplier {
	readonly company: string;
	readonly domain: string;
}

const SUPPLIERS: readonly Supplier[] = [
	{ company: "Northbeam Office", domain: "northbeam-office.test" },
	{ company: "Pinecrest Supply", domain: "pinecrest-supply.test" },
	{ company: "Harborview Workplace", domain: "harborview-workplace.test" },
	{ company: "Summit Furnishings", domain: "summit-furnishings.test" },
];

interface ExpiryReply {
	/** The purchase-order conversation. */
	readonly subject: string;
	readonly threadId: string;
	/** The conversation's latest message, and the address of its sender, the reply's one recipient. */
	readonly latestId: string;
	readonly latestSender: string;
	readonly supplier: string;
	readonly option: string;
	readonly totalCents: number;
	/** Every other total the two quotes show: the other option's, and both of the other supplier's. */
	readonly otherTotalsCents: readonly number[];
}

function planSessionExpiry(world: MailWorld, rng: Seeded): ExpiryReply & { readonly quoteId: string } {
	const request = rng.pick(QUOTED_ITEMS);
	const [chosen, rival] = rng.sample(SUPPLIERS, 2) as [Supplier, Supplier];
	const user = me(world);
	const userFirst = firstName(user);
	const [lead, buyer] = rng.sample(coworkers(world), 2) as [Person, Person];
	const quantity = rng.int(6, 24);
	// Four totals at least $10 apart, each quote's cheaper option first.
	const totals: number[] = [];
	while (totals.length < 4) {
		const cents = rng.int(2400, 18000) * 100 + rng.pick([0, 25, 40, 50, 75, 90]);
		if (totals.every(total => Math.abs(total - cents) >= 1000)) totals.push(cents);
	}
	const [chosenTotals, rivalTotals] = [totals.slice(0, 2), totals.slice(2)].map(pair =>
		pair.sort((a, b) => a - b),
	) as [[number, number], [number, number]];
	const quote = (supplier: Supplier, prices: readonly [number, number]): Message => {
		const rep = addContact(world, newPerson(world, rng, supplier.domain));
		const reference = `Q-${rng.int(10000, 99999)}`;
		const lines = request.options.map(
			(option, index) => `${capitalized(option)}: ${dollars(prices[index] as number)} in total`,
		);
		return addMessage(world, rng, {
			from: rep,
			to: [user],
			subject: `Quote ${reference}: ${quantity} ${request.item}`,
			body: `Hello ${userFirst},\n\nThank you for your request. Here is our quote ${reference} for ${quantity} ${request.item}, in two options:\n\n${lines.join("\n")}\n\nPrices include delivery and tax. The quote is valid for 30 days.\n\n${rep.name}\n${supplier.company}`,
			date: timeOn(rng, addDays("2025-06-02", rng.int(0, 9)), 8, 17),
			folder: rng.next() < 0.5 ? "archive" : "inbox",
			labels: rng.next() < 0.5 ? ["Work"] : [],
		});
	};
	const chosenQuote = quote(chosen, chosenTotals);
	quote(rival, rivalTotals);
	const optionIndex = rng.int(0, 1);
	const option = request.options[optionIndex] as string;
	const subject = `Purchase order for the ${request.item}`;
	const threadId = newThreadId(world, rng);
	const compared = rng.shuffle([chosen, rival]).map(supplier => supplier.company);
	addMessage(world, rng, {
		from: lead,
		to: [user, buyer],
		subject,
		threadId,
		body: `Hi ${userFirst} and ${firstName(buyer)},\n\nWe compared the quotes from ${compared.join(" and ")} for the ${quantity} ${request.item}, and we're going with ${chosen.company}, the ${option} option. ${userFirst}, the quotes came to you: can you send the total for that option so we can raise the purchase order?\n\n${firstName(lead)}`,
		date: timeOn(rng, addDays(TODAY, -rng.int(2, 4)), 8, 16),
		folder: "inbox",
	});
	const latest = addMessage(world, rng, {
		from: buyer,
		to: [user],
		cc: [lead],
		subject: `Re: ${subject}`,
		threadId,
		body: `Hi ${userFirst},\n\nI'm raising the purchase order this afternoon. Reply to me with the total and I'll put it through.\n\n${firstName(buyer)}`,
		date: timeOn(rng, addDays(TODAY, -1), 8, 16),
		folder: "inbox",
		read: false,
	});
	return {
		subject,
		threadId,
		latestId: latest.id,
		latestSender: buyer.email,
		supplier: chosen.company,
		option,
		totalCents: chosenTotals[optionIndex] as number,
		otherTotalsCents: [...chosenTotals.filter((_, index) => index !== optionIndex), ...rivalTotals],
		quoteId: chosenQuote.id,
	};
}

/**
 * The recovery tier's mail task: the session expires under the first Send, which comes after reading
 * both conversations the reply needs. The sign-in page shows that the message was not sent, and
 * signing in again opens a new, empty reply. The checks on the message grade every message sent, so
 * a duplicate fails `one-message-sent` alone, and each wrong recovery fails the check written for it.
 */
export const mailSendAfterSessionExpiryTask = kitTask<MailState<ExpiryReply>>({
	id: "mail-send-after-session-expiry",
	title: "Reply with a quoted total, sending again after the session expires on Send",
	capabilities: ["recovery", "reading", "search-filter", "forms", "auth"],
	difficulty: "expert",
	timeBudgetSec: 900,
	async start({ seed }) {
		const rng = new Seeded(seed);
		const world = generateMail(rng);
		const { quoteId, ...plan } = planSessionExpiry(world, rng);
		const site = await startMailSite(world, seed, { expireSessionOnFirstSend: true });
		return {
			instruction: [
				signIn(site.origin, world),
				`The conversation "${plan.subject}" names the supplier and the option your team chose, and asks you for that option's quoted total. The supplier's quote is in another email in the mailbox.`,
				"Reply to the latest message of that conversation, to its sender only, stating that total and no other amount.",
				"Send exactly one message, and finish with a final answer that states the total.",
			].join("\n"),
			solve: async () => {
				const client = await signedInClient(site.origin, world);
				for (const id of [plan.latestId, quoteId]) {
					const opened = await client.get(`/message/${id}`);
					if (opened.status !== 200) throw new Error(`message ${id} did not open; it answered ${opened.status}`);
				}
				const latest = messageById(world, plan.latestId);
				const change = {
					note: `Hi,\n\nThe total of ${plan.supplier}'s quote for the ${plan.option} option is ${dollars(plan.totalCents)}.`,
				};
				const rejected = await postFromForm(client, world, latest, "reply", change);
				if (!rejected.url.includes("/signin?expired=send") || !rejected.body.includes("The message was not sent")) {
					throw new Error(`the session did not expire under the first Send; it answered ${rejected.url}`);
				}
				// Signing in again opens a new reply form: the reply is written again and sent once.
				const { email, password } = world.account;
				const next = new URL(rejected.url).searchParams.get("next") ?? "/mail/inbox";
				const reopened = await client.post("/signin", { email, password, next });
				if (!reopened.url.includes("/compose?")) throw new Error(`signing in again answered ${reopened.url}`);
				await sendFromForm(client, world, latest, "reply", change);
				const conversation = await client.get(`/message/${plan.latestId}`);
				const shown = conversation.body.split('<span class="chip folder">Sent</span>').length - 1;
				if (shown !== 1) throw new Error(`the conversation shows ${shown} sent replies, not one`);
				return `Replied with the total: ${dollars(plan.totalCents)}.`;
			},
			finish: async () => ({ ...(await site.finish()), expected: plan }),
		};
	},
	checks: [
		{
			id: "session-expired",
			description: "the session expired under the first Send, and the site rejected that send",
			pass: state => state.rejectedSends.length === 1,
		},
		ONE_SENT,
		{
			id: "in-conversation",
			description: "every message sent is a reply within the purchase-order conversation",
			pass: state =>
				state.sent.length > 0 &&
				state.sent.every(
					mail => mail.threadId === state.expected.threadId && (mail.mode === "reply" || mail.mode === "replyall"),
				),
		},
		{
			id: "to-latest-sender",
			description: "every message sent goes to the sender of the conversation's latest message and nobody else",
			pass: state =>
				state.sent.length > 0 && state.sent.every(mail => sameSet(recipients(mail), [state.expected.latestSender])),
		},
		{
			id: "states-chosen-total",
			description:
				"every message sent states the chosen option's total in its own text, and no other total the quotes show",
			pass: state => {
				const { totalCents, otherTotalsCents } = state.expected;
				const others = otherTotalsCents.map(cents => cents / 100);
				return (
					state.sent.length > 0 &&
					state.sent.every(mail => answerStatesOnly(ownText(mail.body), totalCents / 100, others))
				);
			},
		},
		{
			id: "answer-states-total",
			description: "the final answer states the chosen option's total, and no other total the quotes show",
			pass: (state, answer) =>
				answerStatesOnly(
					answer,
					state.expected.totalCents / 100,
					state.expected.otherTotalsCents.map(cents => cents / 100),
				),
		},
	],
});

export const MAIL_TASKS: readonly KitTask[] = [
	replyWithInvoiceTotal,
	forwardWithAttachment,
	bulkArchiveNewsletters,
	createFilterAndApply,
	rescheduleMeeting,
	mailSendAfterSessionExpiryTask,
];
