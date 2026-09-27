/**
 * Trellis, a kanban board application: a seeded workspace of boards, members and cards, and the one
 * set of rules (card order, dates, what counts as open) that every page and every grader uses.
 */

import type { Seeded } from "../../../../engine/kit/seeded";

export const COLUMNS = [
	{ id: "backlog", name: "Backlog" },
	{ id: "ready", name: "Ready" },
	{ id: "in-progress", name: "In Progress" },
	{ id: "in-review", name: "In Review" },
	{ id: "done", name: "Done" },
] as const;

export type ColumnId = (typeof COLUMNS)[number]["id"];

export const LABELS = [
	{ id: "bug", name: "Bug", color: "#dc2626" },
	{ id: "feature", name: "Feature", color: "#16a34a" },
	{ id: "chore", name: "Chore", color: "#64748b" },
	{ id: "design", name: "Design", color: "#9333ea" },
	{ id: "security", name: "Security", color: "#ea580c" },
	{ id: "docs", name: "Docs", color: "#2563eb" },
	{ id: "performance", name: "Performance", color: "#ca8a04" },
] as const;

export type LabelId = (typeof LABELS)[number]["id"];

export type DragMode = "pointer" | "html5";

export interface Member {
	readonly id: string;
	readonly name: string;
	readonly initials: string;
}

export interface ChecklistItem {
	readonly id: string;
	text: string;
	done: boolean;
}

/** The author id of a comment written during the trial. */
export const YOU = "me";

export interface CardComment {
	readonly id: string;
	/** A member id, or {@link YOU} for the person using the application. */
	readonly author: string;
	readonly body: string;
	readonly date: string;
}

export interface Card {
	readonly id: string;
	readonly boardId: string;
	/** Shown as `<board key>-<number>`. */
	readonly number: number;
	title: string;
	column: ColumnId;
	labels: LabelId[];
	/** A member id, or null when nobody holds the card. */
	assignee: string | null;
	/** `YYYY-MM-DD`. */
	due: string | null;
	/** `YYYY-MM-DD`: the day the card last entered Done; null outside Done. */
	completed: string | null;
	checklist: ChecklistItem[];
	comments: CardComment[];
	archived: boolean;
	/** Present before the trial started. */
	readonly seeded: boolean;
}

export interface Board {
	readonly id: string;
	readonly name: string;
	readonly key: string;
	/** How cards are dragged on this board: pointer events, or the HTML drag-and-drop events. */
	readonly drag: DragMode;
	/** The ids of the board's cards that are not archived, column by column, top first. */
	readonly columns: Record<ColumnId, string[]>;
}

export interface KanbanWorld {
	/** `YYYY-MM-DD`: the day the application treats as today. */
	readonly today: string;
	readonly members: Member[];
	readonly boards: Board[];
	readonly cards: Card[];
	/** Titles not used yet, by label, for planners that need fresh ones. */
	readonly spareTitles: Record<LabelId, string[]>;
	nextId: number;
}

/** What a trial's grader reads about one card. */
export interface CardState {
	readonly id: string;
	readonly boardId: string;
	readonly key: string;
	readonly title: string;
	readonly column: ColumnId;
	readonly labels: readonly LabelId[];
	readonly assignee: string | null;
	readonly due: string | null;
	readonly completed: string | null;
	readonly checklist: readonly { readonly text: string; readonly done: boolean }[];
	readonly archived: boolean;
	readonly seeded: boolean;
}

export interface BoardState {
	readonly id: string;
	readonly name: string;
	readonly columns: Readonly<Record<ColumnId, readonly string[]>>;
}

export interface KanbanState {
	readonly boards: readonly BoardState[];
	readonly cards: readonly CardState[];
}

const BOARD_SPECS: readonly { id: string; name: string; key: string; drag: DragMode }[] = [
	{ id: "platform", name: "Platform", key: "PLAT", drag: "pointer" },
	{ id: "mobile", name: "Mobile App", key: "MOB", drag: "html5" },
	{ id: "website", name: "Website", key: "WEB", drag: "pointer" },
];

export const PLATFORM = "platform";
export const MOBILE = "mobile";
export const WEBSITE = "website";

const FIRST_NAMES = [
	"Avery",
	"Alex",
	"Jordan",
	"Jamie",
	"Riley",
	"Robin",
	"Morgan",
	"Maya",
	"Casey",
	"Cameron",
	"Taylor",
	"Theo",
	"Priya",
	"Sasha",
	"Noor",
	"Elena",
];

const LAST_NAMES = [
	"Nakamura",
	"Novak",
	"Okafor",
	"Ortega",
	"Lindqvist",
	"Larsen",
	"Moreau",
	"Mendes",
	"Castillo",
	"Chen",
	"Haddad",
	"Hughes",
	"Brennan",
	"Baptiste",
	"Petrov",
	"Silva",
];

const TITLE_PARTS: Readonly<Record<LabelId, { readonly verbs: readonly string[]; readonly subjects: readonly string[] }>> = {
	bug: {
		verbs: ["Fix", "Investigate", "Reproduce"],
		subjects: [
			"login redirect loop",
			"stale cache after deploy",
			"timezone drift in reports",
			"double charge on retry",
			"broken avatar upload",
			"pagination skipping rows",
			"crash when the session expires",
			"memory leak in the socket client",
			"wrong totals on invoices",
			"flaky nightly export",
			"missing rows in CSV export",
			"token refresh race",
			"duplicate notifications",
			"404 on shared links",
			"scroll jump on long lists",
			"late password reset emails",
			"rounding error in tax totals",
			"retry storm during outages",
			"broken deep links",
			"blank screen on slow networks",
			"sort order lost on reload",
			"stuck upload progress bar",
		],
	},
	feature: {
		verbs: ["Add", "Prototype", "Scope"],
		subjects: [
			"CSV export for reports",
			"bulk edit for tags",
			"SAML single sign-on",
			"audit log filters",
			"saved searches",
			"team invitations",
			"webhooks for billing events",
			"recovery codes for two-factor",
			"draft autosave",
			"a public status page",
			"per-project quotas",
			"calendar sync",
			"usage alerts",
			"comment mentions",
			"dark mode",
			"custom fields",
			"activity digest emails",
			"guest access",
			"workspace templates",
			"read receipts",
		],
	},
	chore: {
		verbs: ["Clean up", "Update", "Simplify"],
		subjects: [
			"the build cache",
			"CI runners",
			"test fixtures",
			"feature flags",
			"dependency pins",
			"the Docker base image",
			"staging seed data",
			"the lint config",
			"cron jobs",
			"the logging setup",
			"the release scripts",
			"the backup job",
			"the on-call runbook",
			"unused endpoints",
			"the alert thresholds",
			"the monorepo layout",
		],
	},
	design: {
		verbs: ["Redesign", "Polish"],
		subjects: [
			"the onboarding flow",
			"empty states",
			"the settings page",
			"the pricing table",
			"mobile navigation",
			"error pages",
			"the invite dialog",
			"the billing page",
			"notification emails",
			"the sign-up form",
			"search results",
			"the dashboard header",
		],
	},
	security: {
		verbs: ["Review", "Harden"],
		subjects: [
			"admin permissions",
			"session cookies",
			"the password policy",
			"API key scopes",
			"third-party scripts",
			"file upload validation",
			"rate limiting",
			"webhook signatures",
			"the SSO callback",
			"CORS rules",
		],
	},
	docs: {
		verbs: ["Document", "Rewrite the guide to"],
		subjects: [
			"API rate limits",
			"webhook retries",
			"the deployment steps",
			"the SDK quickstart",
			"billing plans",
			"data retention",
			"the CLI flags",
			"the import format",
			"single sign-on setup",
			"the audit log",
		],
	},
	performance: {
		verbs: ["Speed up", "Profile"],
		subjects: [
			"cold start",
			"image thumbnails",
			"report generation",
			"search indexing",
			"the dashboard query",
			"CSV import",
			"the activity feed",
			"page load on mobile",
			"background jobs",
			"the permissions check",
		],
	},
};

/** How often each label is a card's first label. */
const LABEL_WEIGHTS: readonly LabelId[] = [
	"bug",
	"bug",
	"bug",
	"feature",
	"feature",
	"feature",
	"chore",
	"chore",
	"design",
	"security",
	"docs",
	"performance",
];

const CHECKLIST_POOL = [
	"Write the tests",
	"Update the docs",
	"Get a design review",
	"Check the metrics",
	"Ship behind a flag",
	"Remove the flag",
	"Notify support",
	"Update the changelog",
	"Run the load test",
	"Review the copy",
];

const COMMENT_POOL = [
	"Blocked on the API review.",
	"I can pick this up after the release.",
	"Needs a design pass first.",
	"Repro steps are in the support ticket.",
	"Pairing on this tomorrow.",
	"Moved the estimate to three points.",
	"QA found one more edge case.",
	"Waiting on the vendor's reply.",
];

/** Rows per column of a generated board, as [min, max]. */
const COLUMN_SIZES: Readonly<Record<ColumnId, readonly [number, number]>> = {
	backlog: [10, 13],
	ready: [9, 12],
	"in-progress": [9, 11],
	"in-review": [6, 8],
	done: [10, 13],
};

export const OPEN_COLUMNS: readonly ColumnId[] = ["backlog", "ready", "in-progress", "in-review"];

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

const DAY_MS = 86_400_000;

function utc(iso: string): Date {
	const [year, month, day] = iso.split("-").map(Number) as [number, number, number];
	return new Date(Date.UTC(year, month - 1, day));
}

export function addDays(iso: string, days: number): string {
	return new Date(utc(iso).getTime() + days * DAY_MS).toISOString().slice(0, 10);
}

/** `Nov 3` in the year of `today`, `Jan 9, 2027` in any other year: how a card face shows a date. */
export function shortDate(iso: string, today: string): string {
	const date = utc(iso);
	const month = (MONTHS[date.getUTCMonth()] as string).slice(0, 3);
	const base = `${month} ${date.getUTCDate()}`;
	return iso.slice(0, 4) === today.slice(0, 4) ? base : `${base}, ${date.getUTCFullYear()}`;
}

/** `November 3, 2026`. */
export function longDate(iso: string): string {
	const date = utc(iso);
	return `${MONTHS[date.getUTCMonth()]} ${date.getUTCDate()}, ${date.getUTCFullYear()}`;
}

/** `Tuesday, November 3, 2026`. */
export function weekdayDate(iso: string): string {
	return `${WEEKDAYS[utc(iso).getUTCDay()]}, ${longDate(iso)}`;
}

/** `11/3/2026`: the format the due date field takes. */
export function slashDate(iso: string): string {
	const date = utc(iso);
	return `${date.getUTCMonth() + 1}/${date.getUTCDate()}/${date.getUTCFullYear()}`;
}

/** The ISO date a `M/D/YYYY` field holds, or null when it is not a real date in that format. */
export function parseSlashDate(value: string): string | null {
	const match = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(value.trim());
	if (!match) return null;
	const [month, day, year] = [Number(match[1]), Number(match[2]), Number(match[3])];
	if (month < 1 || month > 12 || day < 1 || day > 31 || year < 2000 || year > 2100) return null;
	const date = new Date(Date.UTC(year, month - 1, day));
	if (date.getUTCMonth() !== month - 1) return null;
	return date.toISOString().slice(0, 10);
}

/** Seven members; the first two share their initials. */
function generateMembers(rng: Seeded): Member[] {
	const byInitial = (names: readonly string[]) => {
		const groups = new Map<string, string[]>();
		for (const name of names) groups.set(name[0] as string, [...(groups.get(name[0] as string) ?? []), name]);
		return [...groups.values()].filter(group => group.length >= 2);
	};
	const [firstA, firstB] = rng.sample(rng.pick(byInitial(FIRST_NAMES)), 2) as [string, string];
	const [lastA, lastB] = rng.sample(rng.pick(byInitial(LAST_NAMES)), 2) as [string, string];
	const names = [`${firstA} ${lastA}`, `${firstB} ${lastB}`];
	const usedFirst = new Set([firstA, firstB]);
	const usedLast = new Set([lastA, lastB]);
	while (names.length < 7) {
		const first = rng.pick(FIRST_NAMES);
		const last = rng.pick(LAST_NAMES);
		if (usedFirst.has(first) || usedLast.has(last)) continue;
		usedFirst.add(first);
		usedLast.add(last);
		names.push(`${first} ${last}`);
	}
	return names.map((name, index) => ({
		id: `u${index + 1}`,
		name,
		initials: name
			.split(" ")
			.map(part => part[0] ?? "")
			.join(""),
	}));
}

/**
 * Every title in a seeded order, by label: `generate` for the cards generated, `spare` held back for
 * planners that retitle cards (up to nine bug cards and a few of each other label per task).
 */
function titlePools(rng: Seeded): { generate: Record<LabelId, string[]>; spare: Record<LabelId, string[]> } {
	const generate = {} as Record<LabelId, string[]>;
	const spare = {} as Record<LabelId, string[]>;
	for (const label of LABELS) {
		const parts = TITLE_PARTS[label.id];
		const titles = rng.shuffle(parts.verbs.flatMap(verb => parts.subjects.map(subject => `${verb} ${subject}`)));
		const reserved = label.id === "bug" ? 12 : 4;
		spare[label.id] = titles.slice(0, reserved);
		generate[label.id] = titles.slice(reserved);
	}
	return { generate, spare };
}

/** A fresh title of `label`, or of another label when that one ran out; the label it came from. */
function takeAnyTitle(pools: Record<LabelId, string[]>, label: LabelId): { title: string; label: LabelId } {
	for (const candidate of [label, ...LABELS.map(entry => entry.id)]) {
		const title = pools[candidate].pop();
		if (title) return { title, label: candidate };
	}
	throw new Error("the title pools ran out");
}

/** A fresh title of `label`. */
export function takeTitle(world: KanbanWorld, label: LabelId): string {
	const title = world.spareTitles[label].pop();
	if (!title) throw new Error(`no spare ${label} title`);
	return title;
}

interface CardDraft {
	readonly column: ColumnId;
	readonly archived: boolean;
}

function generateCard(
	rng: Seeded,
	world: Pick<KanbanWorld, "today" | "members">,
	pools: Record<LabelId, string[]>,
	board: Board,
	id: string,
	number: number,
	draft: CardDraft,
	itemCounter: { next: number },
): Card {
	const picked = takeAnyTitle(pools, rng.pick(LABEL_WEIGHTS));
	const labels: LabelId[] = [picked.label];
	if (rng.next() < 0.2) {
		const second = rng.pick(LABELS.filter(label => label.id !== picked.label)).id;
		labels.push(second);
	}
	const done = draft.column === "done";
	let due: string | null = null;
	if (done ? rng.next() < 0.6 : rng.next() < 0.72) {
		due = done ? addDays(world.today, -rng.int(5, 60)) : addDays(world.today, rng.int(-12, 75));
	}
	const checklist: ChecklistItem[] = [];
	if (rng.next() < 0.4) {
		for (const text of rng.sample(CHECKLIST_POOL, rng.int(2, 5))) {
			checklist.push({ id: `i${itemCounter.next++}`, text, done: done || rng.next() < 0.4 });
		}
	}
	const comments: CardComment[] = [];
	if (rng.next() < 0.3) {
		const count = rng.int(1, 3);
		for (let index = 0; index < count; index++) {
			comments.push({
				id: `m${itemCounter.next++}`,
				author: rng.pick(world.members).id,
				body: rng.pick(COMMENT_POOL),
				date: addDays(world.today, -rng.int(1, 30)),
			});
		}
	}
	return {
		id,
		boardId: board.id,
		number,
		title: picked.title,
		column: draft.column,
		labels,
		assignee: rng.next() < 0.85 ? rng.pick(world.members).id : null,
		due,
		completed: done ? addDays(world.today, -rng.int(1, 60)) : null,
		checklist,
		comments,
		archived: draft.archived,
		seeded: true,
	};
}

/** Three boards of about fifty cards each, seven members, and a today between mid-November and early December. */
export function generateKanban(rng: Seeded): KanbanWorld {
	const today = addDays("2026-11-16", rng.int(0, 20));
	const members = generateMembers(rng);
	const { generate: pools, spare } = titlePools(rng);
	const boards: Board[] = [];
	const cards: Card[] = [];
	const itemCounter = { next: 1 };
	let nextId = 1;
	for (const spec of BOARD_SPECS) {
		const board: Board = { ...spec, columns: { backlog: [], ready: [], "in-progress": [], "in-review": [], done: [] } };
		boards.push(board);
		const drafts: CardDraft[] = [];
		for (const column of COLUMNS) {
			const [min, max] = COLUMN_SIZES[column.id];
			const count = rng.int(min, max);
			for (let index = 0; index < count; index++) drafts.push({ column: column.id, archived: false });
		}
		const archivedCount = rng.int(2, 3);
		for (let index = 0; index < archivedCount; index++) {
			drafts.push({ column: rng.pick(COLUMNS).id, archived: true });
		}
		// Card numbers follow creation, which is not the order the columns show them in.
		const numbers = rng.shuffle(drafts.map((_, index) => 101 + index));
		drafts.forEach((draft, index) => {
			const card = generateCard(
				rng,
				{ today, members },
				pools,
				board,
				`c${nextId++}`,
				numbers[index] as number,
				draft,
				itemCounter,
			);
			cards.push(card);
			if (!card.archived) board.columns[card.column].push(card.id);
		});
	}
	for (const label of LABELS) spare[label.id].push(...pools[label.id]);
	return { today, members, boards, cards, spareTitles: spare, nextId: Math.max(nextId, itemCounter.next) + 1000 };
}

export function findBoard(world: Pick<KanbanWorld, "boards">, id: string): Board | undefined {
	return world.boards.find(board => board.id === id);
}

export function findCard(world: Pick<KanbanWorld, "cards">, id: string): Card | undefined {
	return world.cards.find(card => card.id === id);
}

export function findMember(world: Pick<KanbanWorld, "members">, id: string): Member | undefined {
	return world.members.find(member => member.id === id);
}

export function boardOf(world: KanbanWorld, boardId: string): Board {
	const board = findBoard(world, boardId);
	if (!board) throw new Error(`no board ${boardId}`);
	return board;
}

/** The cards of one column, top first. */
export function columnCards(world: KanbanWorld, boardId: string, column: ColumnId): Card[] {
	return boardOf(world, boardId).columns[column].map(id => findCard(world, id) as Card);
}

export function cardKey(world: Pick<KanbanWorld, "boards">, card: Card): string {
	return `${findBoard(world, card.boardId)?.key ?? "?"}-${card.number}`;
}

export function columnName(column: ColumnId): string {
	return COLUMNS.find(entry => entry.id === column)?.name ?? column;
}

export function isColumn(value: unknown): value is ColumnId {
	return COLUMNS.some(column => column.id === value);
}

export function isLabel(value: unknown): value is LabelId {
	return LABELS.some(label => label.id === value);
}

export function labelName(label: LabelId): string {
	return LABELS.find(entry => entry.id === label)?.name ?? label;
}

/** A card counts toward someone's load when it is on the board, not archived, and not in Done. */
export function isOpen(card: Pick<Card, "archived" | "column">): boolean {
	return !card.archived && card.column !== "done";
}

/** Members in alphabetical order of their full names. */
export function alphabetical(members: readonly Member[]): Member[] {
	return [...members].sort((a, b) => a.name.localeCompare(b.name, "en"));
}

/**
 * Move a card: it lands immediately above `before`, or at the bottom of `column` when `before` is
 * null. Entering Done stamps today as the completion day; leaving Done clears it. Returns an error
 * message, or null when the card moved.
 */
export function moveCard(world: KanbanWorld, cardId: string, column: ColumnId, before: string | null): string | null {
	const card = findCard(world, cardId);
	if (!card || card.archived) return "That card is not on a board.";
	if (before === card.id) return null;
	const board = boardOf(world, card.boardId);
	if (before !== null) {
		const anchor = findCard(world, before);
		if (!anchor || anchor.boardId !== card.boardId || anchor.archived || anchor.column !== column) {
			return "The card to drop above is not in that column.";
		}
	}
	const source = board.columns[card.column];
	source.splice(source.indexOf(card.id), 1);
	const target = board.columns[column];
	target.splice(before === null ? target.length : target.indexOf(before), 0, card.id);
	if (column === "done" && card.column !== "done") card.completed = world.today;
	if (column !== "done") card.completed = null;
	card.column = column;
	return null;
}

export function archiveCard(world: KanbanWorld, cardId: string): string | null {
	const card = findCard(world, cardId);
	if (!card || card.archived) return "That card is not on a board.";
	const list = boardOf(world, card.boardId).columns[card.column];
	list.splice(list.indexOf(card.id), 1);
	card.archived = true;
	return null;
}

/** Send an archived card back to the bottom of the column it was archived from. */
export function restoreCard(world: KanbanWorld, cardId: string): string | null {
	const card = findCard(world, cardId);
	if (!card?.archived) return "That card is not archived.";
	boardOf(world, card.boardId).columns[card.column].push(card.id);
	card.archived = false;
	return null;
}

export function cardState(world: Pick<KanbanWorld, "boards">, card: Card): CardState {
	return {
		id: card.id,
		boardId: card.boardId,
		key: cardKey(world, card),
		title: card.title,
		column: card.column,
		labels: [...card.labels],
		assignee: card.assignee,
		due: card.due,
		completed: card.completed,
		checklist: card.checklist.map(item => ({ text: item.text, done: item.done })),
		archived: card.archived,
		seeded: card.seeded,
	};
}

export function stateOf(world: KanbanWorld): KanbanState {
	return {
		boards: world.boards.map(board => ({
			id: board.id,
			name: board.name,
			columns: Object.fromEntries(COLUMNS.map(column => [column.id, [...board.columns[column.id]]])) as Record<
				ColumnId,
				string[]
			>,
		})),
		cards: world.cards.map(card => cardState(world, card)),
	};
}

/** Everything about a card a task could change, each field comparable as JSON. */
export interface CardDetails {
	readonly title: string;
	readonly column: ColumnId;
	readonly labels: readonly LabelId[];
	readonly assignee: string | null;
	readonly due: string | null;
	readonly completed: string | null;
	readonly archived: boolean;
	readonly checklist: readonly (readonly [string, boolean])[];
}

export function detailsOf(card: CardState): CardDetails {
	return {
		title: card.title,
		column: card.column,
		labels: [...card.labels].sort(),
		assignee: card.assignee,
		due: card.due,
		completed: card.completed,
		archived: card.archived,
		checklist: card.checklist.map(item => [item.text, item.done] as const),
	};
}
