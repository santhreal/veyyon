/**
 * Parcel Mail's world: an account, its contacts, a seeded mailbox of a few hundred messages in
 * threads, folders and labels, the filters it holds, and the rules every page and every grader
 * share: how a search query matches, how a filter matches, and what a reply, a reply-all or a
 * forward starts with.
 */

import type { Seeded } from "../../../../engine/kit/seeded";

/** The mailbox's day: every seeded message is older, and everything sent in a trial is dated on it. */
export const TODAY = "2025-06-19";

export const FOLDERS = ["inbox", "archive", "sent", "trash"] as const;
export type Folder = (typeof FOLDERS)[number];
export const FOLDER_NAMES: Readonly<Record<Folder, string>> = {
	inbox: "Inbox",
	archive: "Archive",
	sent: "Sent",
	trash: "Trash",
};

export interface Person {
	readonly name: string;
	readonly email: string;
}

export interface Attachment {
	readonly name: string;
	readonly size: number;
}

export interface Message {
	readonly id: string;
	readonly threadId: string;
	readonly from: Person;
	readonly to: readonly Person[];
	readonly cc: readonly Person[];
	readonly subject: string;
	readonly body: string;
	/** ISO 8601 in UTC; pages show it in UTC too. */
	readonly date: string;
	readonly attachments: readonly Attachment[];
	folder: Folder;
	labels: string[];
	starred: boolean;
	read: boolean;
	/** In the mailbox before the trial started; false for what the account sent during it. */
	readonly seeded: boolean;
}

export const FILTER_FIELDS = ["from", "to", "subject", "words"] as const;
export type FilterField = (typeof FILTER_FIELDS)[number];
export const FILTER_FIELD_NAMES: Readonly<Record<FilterField, string>> = {
	from: "From",
	to: "To",
	subject: "Subject",
	words: "Has the words",
};

export interface FilterCondition {
	readonly field: FilterField;
	readonly value: string;
}

export interface FilterActions {
	readonly label: string | null;
	readonly archive: boolean;
	readonly star: boolean;
	readonly markRead: boolean;
	readonly trash: boolean;
}

export interface Filter {
	readonly id: string;
	readonly match: "all" | "any";
	readonly conditions: readonly FilterCondition[];
	readonly actions: FilterActions;
	/** In the account before the trial started. */
	readonly seeded: boolean;
	/** How many messages it changed when it was created and applied to existing mail. */
	readonly appliedTo: number;
}

export const COMPOSE_MODES = ["new", "reply", "replyall", "forward"] as const;
export type ComposeMode = (typeof COMPOSE_MODES)[number];

export interface SentAttachment {
	readonly name: string;
	readonly size: number;
	readonly sha256: string;
}

/** One message the account sent during the trial, as the compose form submitted it. */
export interface SentMail {
	readonly id: string;
	readonly mode: ComposeMode;
	/** The message replied to or forwarded. */
	readonly sourceId: string | null;
	readonly threadId: string;
	/** Lowercase addresses. */
	readonly to: readonly string[];
	readonly cc: readonly string[];
	readonly subject: string;
	readonly body: string;
	readonly attachments: readonly SentAttachment[];
}

export interface MailWorld {
	readonly account: { readonly name: string; readonly email: string; readonly password: string };
	/** The domain of the account's employer; coworkers have addresses on it. */
	readonly homeDomain: string;
	readonly contacts: Person[];
	readonly messages: Message[];
	readonly labels: string[];
	readonly filters: Filter[];
}

// ---------------------------------------------------------------------------------------------
// Dates, all in UTC.

const MONTHS = [
	"January",
	"February",
	"March",
	"April",
	"May",
	"June",
	"July",
	"August",
	"September",
	"October",
	"November",
	"December",
];
const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

export function monthName(index: number): string {
	return MONTHS[index] as string;
}

function pad(value: number): string {
	return String(value).padStart(2, "0");
}

/** `Mar 3, 2025`. */
export function shortDate(iso: string): string {
	const date = new Date(iso);
	return `${monthName(date.getUTCMonth()).slice(0, 3)} ${date.getUTCDate()}, ${date.getUTCFullYear()}`;
}

/** `Mon, Mar 3, 2025, 09:14`. */
export function longDate(iso: string): string {
	const date = new Date(iso);
	return `${(WEEKDAYS[date.getUTCDay()] as string).slice(0, 3)}, ${shortDate(iso)}, ${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}`;
}

/** `March 3, 2025`. */
export function fullDate(iso: string): string {
	const date = new Date(iso.length === 10 ? `${iso}T12:00:00Z` : iso);
	return `${monthName(date.getUTCMonth())} ${date.getUTCDate()}, ${date.getUTCFullYear()}`;
}

/** `Tuesday, June 24` for a `YYYY-MM-DD` day. */
export function weekdayDate(day: string): string {
	const date = new Date(`${day}T12:00:00Z`);
	return `${WEEKDAYS[date.getUTCDay()]}, ${monthName(date.getUTCMonth())} ${date.getUTCDate()}`;
}

/** The `YYYY-MM-DD` day `days` after `day`. */
export function addDays(day: string, days: number): string {
	const date = new Date(`${day.slice(0, 10)}T12:00:00Z`);
	date.setUTCDate(date.getUTCDate() + days);
	return date.toISOString().slice(0, 10);
}

/** A time on `day` between 07:00 and 20:59, or in the hours given. */
export function timeOn(rng: Seeded, day: string, fromHour = 7, toHour = 20): string {
	return `${day}T${pad(rng.int(fromHour, toHour))}:${pad(rng.int(0, 59))}:00.000Z`;
}

/** A moment between two days, both included. */
export function dateBetween(rng: Seeded, from: string, to: string): string {
	const start = Date.parse(`${from}T00:00:00Z`);
	const end = Date.parse(`${to}T00:00:00Z`);
	const day = new Date(start + rng.int(0, Math.round((end - start) / 86_400_000)) * 86_400_000);
	return timeOn(rng, day.toISOString().slice(0, 10));
}

/** `iso` moved by some hours, as an ISO string. */
export function hoursAfter(iso: string, hours: number): string {
	return new Date(Date.parse(iso) + hours * 3_600_000).toISOString();
}

// ---------------------------------------------------------------------------------------------
// People and messages.

const FIRST = [
	"Avery",
	"Jordan",
	"Riley",
	"Morgan",
	"Casey",
	"Quinn",
	"Rowan",
	"Priya",
	"Omar",
	"Lena",
	"Tomas",
	"Ines",
	"Kenji",
	"Sofia",
	"Malik",
	"Hana",
	"Felix",
	"Nadia",
	"Arjun",
	"Clara",
	"Diego",
	"Elif",
	"Gavin",
	"Hugo",
	"Isla",
	"Jonas",
	"Keira",
	"Luca",
	"Maya",
	"Nico",
	"Oskar",
	"Petra",
	"Rafael",
	"Selin",
	"Theo",
	"Vera",
	"Wren",
	"Yusuf",
];
const LAST = [
	"Nakamura",
	"Okafor",
	"Moreau",
	"Haddad",
	"Brennan",
	"Alvarez",
	"Bergstrom",
	"Chandra",
	"Delacroix",
	"Esposito",
	"Fitzgerald",
	"Gallagher",
	"Hoffmann",
	"Iwasaki",
	"Jansen",
	"Kowalski",
	"Larsen",
	"Mbeki",
	"Nilsson",
	"Oyelaran",
	"Petrov",
	"Quintero",
	"Rasmussen",
	"Sato",
	"Takahashi",
	"Vasquez",
	"Weber",
	"Yilmaz",
	"Zhou",
];

const HOME_DOMAINS = ["fernhill.test", "quarry-lane.test", "tessellate.test"];
export const PARTNER_DOMAINS = [
	"harborline.test",
	"northwind-labs.test",
	"copperfield.test",
	"bluegate.test",
	"meridian-arch.test",
	"oakbridge.test",
	"sablepoint.test",
	"larkspur.test",
];

export const BASE_LABELS = ["Work", "Finance", "Travel", "Receipts", "Family", "Newsletters"];

/** An address for a person at a domain, in one of the shapes companies use. */
export function addressFor(rng: Seeded, first: string, last: string, domain: string): string {
	const f = first.toLowerCase();
	const l = last.toLowerCase();
	const local = rng.pick([`${f}.${l}`, `${f[0]}.${l}`, `${f}${l[0]}`, `${f}.${l[0]}`, `${f[0]}${l}`]);
	return `${local}@${domain}`;
}

export function firstName(person: Person): string {
	return person.name.split(" ")[0] as string;
}

/** A person whose name and address no contact and no account already has. */
export function newPerson(
	world: MailWorld,
	rng: Seeded,
	domain: string,
	names?: { readonly first: string; readonly last: string },
): Person {
	for (let attempt = 0; attempt < 200; attempt++) {
		const first = names?.first ?? rng.pick(FIRST);
		const last = names?.last ?? rng.pick(LAST);
		const name = `${first} ${last}`;
		const email = addressFor(rng, first, last, domain);
		const taken = (other: Person) => other.name === name || other.email === email;
		if (name === world.account.name || world.contacts.some(taken)) {
			if (names) throw new Error(`${name} is already a contact`);
			continue;
		}
		return { name, email };
	}
	throw new Error("no unused name left");
}

export function addContact(world: MailWorld, person: Person): Person {
	world.contacts.push(person);
	world.contacts.sort((a, b) => a.name.localeCompare(b.name));
	return person;
}

function unusedId(rng: Seeded, taken: (id: string) => boolean): string {
	for (;;) {
		const id = rng.code(8);
		if (!taken(id)) return id;
	}
}

export function newThreadId(world: MailWorld, rng: Seeded): string {
	return `T${unusedId(rng, id => world.messages.some(message => message.threadId === `T${id}`))}`;
}

export interface MessageSpec {
	readonly from: Person;
	readonly to: readonly Person[];
	readonly cc?: readonly Person[];
	readonly subject: string;
	readonly body: string;
	readonly date: string;
	readonly folder: Folder;
	readonly threadId?: string;
	readonly labels?: readonly string[];
	readonly starred?: boolean;
	readonly read?: boolean;
	readonly attachments?: readonly Attachment[];
}

export function addMessage(world: MailWorld, rng: Seeded, spec: MessageSpec): Message {
	const message: Message = {
		id: unusedId(rng, id => world.messages.some(other => other.id === id)),
		threadId: spec.threadId ?? newThreadId(world, rng),
		from: spec.from,
		to: spec.to,
		cc: spec.cc ?? [],
		subject: spec.subject,
		body: spec.body,
		date: spec.date,
		attachments: spec.attachments ?? [],
		folder: spec.folder,
		labels: [...(spec.labels ?? [])],
		starred: spec.starred ?? false,
		read: spec.read ?? true,
		seeded: true,
	};
	world.messages.push(message);
	return message;
}

export function findMessage(world: Pick<MailWorld, "messages">, id: string): Message | undefined {
	return world.messages.find(message => message.id === id);
}

/** The messages of a thread, oldest first; trashed ones only when `withTrash`. */
export function threadOf(world: Pick<MailWorld, "messages">, threadId: string, withTrash = false): Message[] {
	return world.messages
		.filter(message => message.threadId === threadId && (withTrash || message.folder !== "trash"))
		.sort((a, b) => a.date.localeCompare(b.date) || a.id.localeCompare(b.id));
}

export function snippet(body: string): string {
	const flat = body.replaceAll(/\s+/g, " ").trim();
	return flat.length > 90 ? `${flat.slice(0, 90)}…` : flat;
}

export function describePerson(person: Person): string {
	return `${person.name} <${person.email}>`;
}

// ---------------------------------------------------------------------------------------------
// The background mailbox.

interface Sender {
	readonly name: string;
	readonly email: string;
	readonly label: string | null;
	readonly subjects: readonly string[];
	readonly lines: readonly string[];
}

const TOPICS = [
	"compilers in the wild",
	"late-season tomatoes",
	"city bike lanes",
	"the quiet return of vinyl",
	"remote teams that work",
	"rainwater barrels",
	"sourdough at altitude",
	"a field guide to moths",
	"caching done right",
	"small-town libraries",
	"night trains of Europe",
	"repairing old radios",
];
const CITIES = ["Lisbon", "Oslo", "Montreal", "Kyoto", "Valencia", "Tallinn", "Porto", "Dublin"];
const STREETS = ["Maple Ave", "Oak Street", "Cedar Lane", "Birch Road", "Willow Way", "Pine Court"];

const SERVICES: readonly Sender[] = [
	{
		name: "Trailhead Bank",
		email: "alerts@trailhead-bank.test",
		label: "Finance",
		subjects: [
			"Your monthly statement is ready",
			"A payment was received",
			"Card ending {n4} was used online",
			"New sign-in to online banking",
		],
		lines: [
			"Sign in to online banking to see the details.",
			"If this was not you, call the number on the back of your card.",
		],
	},
	{
		name: "Skyway Air",
		email: "itinerary@skyway-air.test",
		label: "Travel",
		subjects: ["Your trip to {city} is confirmed", "Check-in is open for {city}", "Seat change on your {city} flight"],
		lines: ["Your booking reference is {code}.", "Bags can be dropped two hours before departure."],
	},
	{
		name: "Gridline Power",
		email: "billing@gridline-power.test",
		label: "Finance",
		subjects: ["Your {month} statement", "Autopay scheduled for {month}"],
		lines: ["Your account is set to pay automatically.", "Usage was about the same as last month."],
	},
	{
		name: "Swift Couriers",
		email: "tracking@swiftcouriers.test",
		label: "Receipts",
		subjects: ["Your parcel {code} is out for delivery", "Parcel {code} was delivered", "Delivery attempt for {code}"],
		lines: ["Track it any time with reference {code}.", "The driver left it at the front door."],
	},
	{
		name: "Nextblock Neighbors",
		email: "notify@nextblock.test",
		label: null,
		subjects: ["New post: lost cat near {street}", "Street cleaning on {street}", "Block party planning"],
		lines: ["Reply on the board to join the conversation.", "Posted by a neighbor near {street}."],
	},
	{
		name: "The Morning Fold",
		email: "hello@morningfold.test",
		label: "Newsletters",
		subjects: ["The Morning Fold: {topic}", "Weekend edition: {topic}"],
		lines: [
			"In this edition: {topic}, {topic2}, and a reader question.",
			"You are receiving this because you subscribed.",
		],
	},
	{
		name: "Cobalt Dev Weekly",
		email: "digest@cobaltdev.test",
		label: "Newsletters",
		subjects: ["Cobalt Dev Weekly #{n3}: {topic}"],
		lines: ["This week: {topic} and {topic2}.", "Forward this to a friend who writes code."],
	},
	{
		name: "Garden & Grain",
		email: "news@gardengrain.test",
		label: "Newsletters",
		subjects: ["Garden & Grain: {topic}", "Seasonal notes: {topic}"],
		lines: ["Our growers wrote about {topic} this month.", "Seed swap dates are on the website."],
	},
];

const PERSON_SUBJECTS = [
	"Lunch on Thursday?",
	"Notes from today's sync",
	"Draft for your comments",
	"Photos from the weekend",
	"Quick question about the report",
	"Travel plans for the conference",
	"Budget draft",
	"Welcome aboard",
	"Parking changes next week",
	"Book club pick",
	"Can you cover Friday?",
	"Slides for Monday",
	"Hiring loop feedback",
	"Office plants rota",
	"Retro action items",
	"Dinner recommendations",
	"Conference talk proposal",
	"Roadmap questions",
	"Moving desks",
	"Onboarding checklist",
];

const PERSON_LINES = [
	"I put my notes in the shared folder; the second half still needs a pass.",
	"Can we move this to after lunch? My morning is packed.",
	"Thanks for the quick turnaround on this.",
	"Let me know if anything looks off before I send it wider.",
	"I booked the small room for an hour, it was the only one free.",
	"No rush on this, whenever you get a minute is fine.",
	"The numbers match what finance sent over last week.",
	"I'll bring the printouts if you bring the coffee.",
	"Pinging you since you were on the original thread.",
	"Happy to pair on it tomorrow if that helps.",
	"I think we're close, just two open questions left.",
	"Sharing this before the meeting so nobody is surprised.",
];

const REPLY_LINES = [
	"Sounds good to me.",
	"Thanks, that works.",
	"Makes sense, let's go with that.",
	"Got it, I'll take a look this afternoon.",
	"Perfect, see you then.",
];

const ATTACHMENT_NAMES = [
	"notes.pdf",
	"photo-0412.jpg",
	"draft-v2.docx",
	"agenda.pdf",
	"summary-slides.pptx",
	"floorplan.png",
];

function fill(rng: Seeded, template: string): string {
	return template
		.replaceAll("{n4}", String(rng.int(1000, 9999)))
		.replaceAll("{n3}", String(rng.int(100, 480)))
		.replaceAll("{city}", rng.pick(CITIES))
		.replaceAll("{street}", rng.pick(STREETS))
		.replaceAll("{month}", monthName(rng.int(0, 11)))
		.replaceAll("{code}", rng.code(6))
		.replaceAll("{topic2}", rng.pick(TOPICS))
		.replaceAll("{topic}", rng.pick(TOPICS));
}

function personBody(rng: Seeded, to: string, from: string, count: number): string {
	return `Hi ${to},\n\n${rng.sample(PERSON_LINES, count).join(" ")}\n\n${from}`;
}

function incomingFolder(rng: Seeded): Folder {
	const roll = rng.next();
	if (roll < 0.62) return "inbox";
	if (roll < 0.95) return "archive";
	return "trash";
}

const SEEDED_FILTER: Filter = {
	id: "F-SEEDED",
	match: "all",
	conditions: [{ field: "from", value: "notify@nextblock.test" }],
	actions: { label: null, archive: false, star: false, markRead: true, trash: false },
	seeded: true,
	appliedTo: 0,
};

/**
 * An account with thirty contacts (a third of them coworkers) and three hundred-odd messages from
 * October 2024 to the day before {@link TODAY}: services, newsletters, and people, some in
 * threads the account replied to.
 */
export function generateMail(rng: Seeded): MailWorld {
	const homeDomain = rng.pick(HOME_DOMAINS);
	const userFirst = rng.pick(FIRST);
	const userLast = rng.pick(LAST);
	const world: MailWorld = {
		account: {
			name: `${userFirst} ${userLast}`,
			email: `${userFirst}.${userLast}@${homeDomain}`.toLowerCase(),
			password: `not-a-real-${rng.code(6).toLowerCase()}`,
		},
		homeDomain,
		contacts: [],
		messages: [],
		labels: [...BASE_LABELS],
		filters: [SEEDED_FILTER],
	};
	const me: Person = { name: world.account.name, email: world.account.email };
	while (world.contacts.length < 30) {
		addContact(world, newPerson(world, rng, world.contacts.length < 10 ? homeDomain : rng.pick(PARTNER_DOMAINS)));
	}
	const people = [...world.contacts];
	const target = rng.int(300, 340);
	while (world.messages.length < target) {
		const date = dateBetween(rng, "2024-10-01", addDays(TODAY, -1));
		const recent = Date.parse(date) > Date.parse(`${addDays(TODAY, -30)}T00:00:00Z`);
		const read = rng.next() < (recent ? 0.6 : 0.93);
		if (rng.next() < 0.45) {
			const sender = rng.pick(SERVICES);
			const subject = fill(rng, rng.pick(sender.subjects));
			addMessage(world, rng, {
				from: { name: sender.name, email: sender.email },
				to: [me],
				subject,
				body: `${sender.lines.map(line => fill(rng, line)).join("\n\n")}\n\n${sender.name}`,
				date,
				folder: incomingFolder(rng),
				labels: sender.label && rng.next() < 0.7 ? [sender.label] : [],
				starred: rng.next() < 0.04,
				read,
			});
			continue;
		}
		const person = rng.pick(people);
		const coworker = person.email.endsWith(`@${homeDomain}`);
		const subject = rng.pick(PERSON_SUBJECTS);
		const labels = coworker && rng.next() < 0.4 ? ["Work"] : !coworker && rng.next() < 0.15 ? ["Family"] : [];
		const attachments = rng.next() < 0.12 ? [{ name: rng.pick(ATTACHMENT_NAMES), size: rng.int(18, 2400) * 1024 }] : [];
		const opening = addMessage(world, rng, {
			from: person,
			to: [me],
			subject,
			body: personBody(rng, userFirst, firstName(person), rng.int(1, 3)),
			date,
			folder: incomingFolder(rng),
			labels,
			starred: rng.next() < 0.06,
			read,
			attachments,
		});
		if (rng.next() < 0.25) {
			// The account replied, and the other side answered.
			const replyDate = hoursAfter(date, rng.int(1, 30));
			const answerDate = hoursAfter(replyDate, rng.int(1, 30));
			if (answerDate >= `${TODAY}T00:00:00.000Z`) continue;
			addMessage(world, rng, {
				from: me,
				to: [person],
				subject: `Re: ${subject}`,
				body: `${rng.pick(REPLY_LINES)}\n\n${userFirst}`,
				date: replyDate,
				folder: "sent",
				threadId: opening.threadId,
			});
			addMessage(world, rng, {
				from: person,
				to: [me],
				subject: `Re: ${subject}`,
				body: `${rng.pick(REPLY_LINES)}\n\n${firstName(person)}`,
				date: answerDate,
				folder: opening.folder,
				threadId: opening.threadId,
				labels,
				read: opening.read,
			});
		}
	}
	return world;
}

// ---------------------------------------------------------------------------------------------
// Search.

export interface Query {
	readonly from: readonly string[];
	readonly to: readonly string[];
	readonly subject: readonly string[];
	readonly words: readonly string[];
	readonly labels: readonly string[];
	readonly hasAttachment: boolean;
	/** `null` searches every folder but the Trash. */
	readonly folder: Folder | "anywhere" | null;
	readonly starred: boolean;
	readonly unread: boolean;
}

/**
 * A search box query: `from:`, `to:`, `subject:`, `label:`, `has:attachment`, `in:<folder>`,
 * `in:anywhere`, `is:starred`, `is:unread`, and free words, all of which must match. A value
 * with spaces is quoted: `subject:"weekly report"`.
 */
export function parseQuery(text: string): Query {
	const from: string[] = [];
	const to: string[] = [];
	const subject: string[] = [];
	const words: string[] = [];
	const labels: string[] = [];
	let hasAttachment = false;
	let folder: Folder | "anywhere" | null = null;
	let starred = false;
	let unread = false;
	for (const match of text.matchAll(/(\w+):(?:"([^"]*)"|(\S+))|"([^"]*)"|(\S+)/g)) {
		const operator = match[1]?.toLowerCase();
		const value = (match[2] ?? match[3] ?? match[4] ?? match[5] ?? "").trim().toLowerCase();
		if (!value) continue;
		if (operator === "from") from.push(value);
		else if (operator === "to") to.push(value);
		else if (operator === "subject") subject.push(value);
		else if (operator === "label") labels.push(value);
		else if (operator === "has" && value.startsWith("attachment")) hasAttachment = true;
		else if (operator === "in" && (FOLDERS as readonly string[]).includes(value)) folder = value as Folder;
		else if (operator === "in" && (value === "anywhere" || value === "all")) folder = "anywhere";
		else if (operator === "is" && value === "starred") starred = true;
		else if (operator === "is" && value === "unread") unread = true;
		else words.push(operator ? `${operator}:${value}` : value);
	}
	return { from, to, subject, words, labels, hasAttachment, folder, starred, unread };
}

function senderText(message: Message): string {
	return `${message.from.name} ${message.from.email}`.toLowerCase();
}

function recipientText(message: Message): string {
	return [...message.to, ...message.cc].map(person => `${person.name} ${person.email}`).join(" ").toLowerCase();
}

export function matchesQuery(message: Message, query: Query): boolean {
	const inScope =
		query.folder === null
			? message.folder !== "trash"
			: query.folder === "anywhere" || message.folder === query.folder;
	if (!inScope) return false;
	const sender = senderText(message);
	const recipients = recipientText(message);
	const subject = message.subject.toLowerCase();
	const everything = `${sender} ${recipients} ${subject} ${message.body.toLowerCase()} ${message.attachments.map(item => item.name.toLowerCase()).join(" ")}`;
	const labels = message.labels.map(label => label.toLowerCase());
	return (
		query.from.every(value => sender.includes(value)) &&
		query.to.every(value => recipients.includes(value)) &&
		query.subject.every(value => subject.includes(value)) &&
		query.words.every(value => everything.includes(value)) &&
		query.labels.every(value => labels.includes(value)) &&
		(!query.hasAttachment || message.attachments.length > 0) &&
		(!query.starred || message.starred) &&
		(!query.unread || !message.read)
	);
}

/**
 * What a mailbox view lists, newest first. A non-empty query searches instead of listing the view;
 * otherwise the view is a folder, `starred`, or `label:<name>`.
 */
export function listMessages(world: Pick<MailWorld, "messages">, view: string, q: string): Message[] {
	let keep: (message: Message) => boolean;
	if (q.trim()) {
		const query = parseQuery(q);
		keep = message => matchesQuery(message, query);
	} else if (view === "starred") keep = message => message.starred && message.folder !== "trash";
	else if (view.startsWith("label:")) {
		const label = view.slice("label:".length).toLowerCase();
		keep = message => message.folder !== "trash" && message.labels.some(entry => entry.toLowerCase() === label);
	} else keep = message => message.folder === view;
	return world.messages.filter(keep).sort((a, b) => b.date.localeCompare(a.date) || a.id.localeCompare(b.id));
}

// ---------------------------------------------------------------------------------------------
// Filters.

/** A condition's value as a filter compares it: trimmed, lowercased, surrounding quotes dropped. */
export function conditionValue(value: string): string {
	return value
		.trim()
		.replace(/^"(.*)"$/, "$1")
		.trim()
		.toLowerCase();
}

function conditionMatches(condition: FilterCondition, message: Message): boolean {
	const value = conditionValue(condition.value);
	if (!value) return false;
	if (condition.field === "from") return senderText(message).includes(value);
	if (condition.field === "to") return recipientText(message).includes(value);
	if (condition.field === "subject") return message.subject.toLowerCase().includes(value);
	return `${message.subject} ${message.body}`.toLowerCase().includes(value);
}

export function filterMatches(filter: Pick<Filter, "match" | "conditions">, message: Message): boolean {
	if (filter.conditions.length === 0) return false;
	return filter.match === "all"
		? filter.conditions.every(condition => conditionMatches(condition, message))
		: filter.conditions.some(condition => conditionMatches(condition, message));
}

/** A filter applied to existing mail reaches received mail outside the Trash. */
export function filterReaches(message: Message): boolean {
	return message.folder === "inbox" || message.folder === "archive";
}

/** Apply a filter's actions to one message; whether anything changed. */
export function applyFilterActions(actions: FilterActions, message: Message): boolean {
	const before = JSON.stringify([message.folder, message.labels, message.starred, message.read]);
	if (actions.label && !message.labels.some(label => label.toLowerCase() === actions.label?.toLowerCase())) {
		message.labels.push(actions.label);
	}
	if (actions.archive && message.folder === "inbox") message.folder = "archive";
	if (actions.star) message.starred = true;
	if (actions.markRead) message.read = true;
	if (actions.trash) message.folder = "trash";
	return JSON.stringify([message.folder, message.labels, message.starred, message.read]) !== before;
}

export function describeFilter(filter: Filter): { when: string; then: string } {
	const when = filter.conditions
		.map(condition => `${FILTER_FIELD_NAMES[condition.field]} contains “${condition.value}”`)
		.join(filter.match === "all" ? " and " : " or ");
	const actions: string[] = [];
	if (filter.actions.archive) actions.push("Skip the Inbox");
	if (filter.actions.label) actions.push(`Apply label “${filter.actions.label}”`);
	if (filter.actions.star) actions.push("Star it");
	if (filter.actions.markRead) actions.push("Mark as read");
	if (filter.actions.trash) actions.push("Delete it");
	return { when, then: actions.join(", ") };
}

// ---------------------------------------------------------------------------------------------
// Composing.

export function isEmail(value: string): boolean {
	return /^[^\s@<>,;"]+@[^\s@<>,;"]+\.[a-z]{2,}$/i.test(value);
}

export interface Prefill {
	readonly to: readonly Person[];
	readonly cc: readonly Person[];
	readonly subject: string;
	readonly body: string;
}

function uniquePeople(people: readonly Person[], without: readonly string[]): Person[] {
	const seen = new Set(without);
	const out: Person[] = [];
	for (const person of people) {
		if (seen.has(person.email)) continue;
		seen.add(person.email);
		out.push(person);
	}
	return out;
}

export function forwardBlock(source: Message): string {
	return [
		"---------- Forwarded message ---------",
		`From: ${describePerson(source.from)}`,
		`Date: ${longDate(source.date)}`,
		`Subject: ${source.subject}`,
		`To: ${source.to.map(describePerson).join(", ")}`,
		...(source.cc.length > 0 ? [`Cc: ${source.cc.map(describePerson).join(", ")}`] : []),
		"",
		source.body,
	].join("\n");
}

/**
 * What the compose form starts with. A reply goes to the sender (or, on the account's own message,
 * to its recipients); a reply-all adds every other recipient and keeps the copied ones in Cc; a
 * forward starts empty. A reply quotes the message line by line; a forward includes it whole.
 */
export function composePrefill(world: Pick<MailWorld, "account">, source: Message | undefined, mode: ComposeMode): Prefill {
	if (!source || mode === "new") return { to: [], cc: [], subject: "", body: "" };
	const me = world.account.email;
	if (mode === "forward") {
		return {
			to: [],
			cc: [],
			subject: /^fwd?:/i.test(source.subject) ? source.subject : `Fwd: ${source.subject}`,
			body: `\n\n${forwardBlock(source)}`,
		};
	}
	const fromMe = source.from.email === me;
	const primary = fromMe ? source.to : [source.from];
	const to = uniquePeople(mode === "replyall" ? [...primary, ...source.to] : primary, [me]);
	const cc = mode === "replyall" ? uniquePeople(source.cc, [me, ...to.map(person => person.email)]) : [];
	const quoted = source.body
		.split("\n")
		.map(line => (line ? `> ${line}` : ">"))
		.join("\n");
	return {
		to,
		cc,
		subject: /^re:/i.test(source.subject) ? source.subject : `Re: ${source.subject}`,
		body: `\n\nOn ${longDate(source.date)}, ${describePerson(source.from)} wrote:\n${quoted}`,
	};
}
