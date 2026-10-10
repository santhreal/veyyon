/**
 * Tasks performed on Trellis. Each plans its scenario on a freshly seeded workspace, bending the
 * boards so the right cards are unique and the tempting wrong ones exist, computes the board a
 * correct run leaves behind by applying the same move rule the server uses, then grades what the
 * server recorded.
 */

import { answerNamesOnly, type Check, normalizeText } from "../../../../engine/kit/checks";
import { type KitTask, kitTask } from "../../../../engine/kit/catalog";
import { FormClient } from "../../../../engine/kit/form-client";
import { Seeded } from "../../../../engine/kit/seeded";
import {
	addDays,
	alphabetical,
	archiveCard,
	boardOf,
	type Card,
	type CardDetails,
	type CardState,
	CHECKLIST_POOL,
	type ChecklistItem,
	type ColumnId,
	columnCards,
	columnName,
	detailsOf,
	findCard,
	generateKanban,
	isOpen,
	LABELS,
	type LabelId,
	labelName,
	longDate,
	MOBILE,
	type Member,
	moveCard,
	OPEN_COLUMNS,
	PLATFORM,
	slashDate,
	stateOf,
	takeTitle,
	type KanbanWorld,
	WEBSITE,
	weekdayDate,
} from "./data";
import { type CardJson, type KanbanConflict, type KanbanSnapshot, startKanbanSite } from "./site";

/** The board a correct run leaves behind. */
interface Baseline {
	/** Column order of every board. */
	readonly columns: Readonly<Record<string, Readonly<Record<ColumnId, readonly string[]>>>>;
	/** The details of every card present before the trial. */
	readonly cards: Readonly<Record<string, CardDetails>>;
}

interface Expected<T> {
	readonly expected: T & { readonly baseline: Baseline };
}

type Graded<T> = KanbanSnapshot & Expected<T>;

function baselineOf(world: KanbanWorld): Baseline {
	const state = stateOf(world);
	return {
		columns: Object.fromEntries(state.boards.map(board => [board.id, board.columns])),
		cards: Object.fromEntries(state.cards.filter(card => card.seeded).map(card => [card.id, detailsOf(card)])),
	};
}

function sameList(a: readonly string[] | undefined, b: readonly string[] | undefined): boolean {
	return a !== undefined && b !== undefined && JSON.stringify(a) === JSON.stringify(b);
}

function columnOf(state: KanbanSnapshot, boardId: string, column: ColumnId): readonly string[] | undefined {
	return state.boards.find(board => board.id === boardId)?.columns[column];
}

function cardIn(state: KanbanSnapshot, id: string): CardState | undefined {
	return state.cards.find(card => card.id === id);
}

/** Every column of every board, the created cards left out, matches the baseline, except those `skip` names. */
function columnsKept(
	state: Graded<unknown>,
	skip: (boardId: string, column: ColumnId) => boolean = () => false,
): boolean {
	const seeded = new Set(state.cards.filter(card => card.seeded).map(card => card.id));
	return Object.entries(state.expected.baseline.columns).every(([boardId, columns]) =>
		(Object.entries(columns) as [ColumnId, readonly string[]][]).every(
			([column, ids]) =>
				skip(boardId, column) ||
				sameList(
					columnOf(state, boardId, column)?.filter(id => seeded.has(id)),
					ids,
				),
		),
	);
}

/** Every card present before the trial holds the details the baseline gives it, the `ignored` fields aside. */
function cardsKept(state: Graded<unknown>, ignored: readonly (keyof CardDetails)[] = []): boolean {
	return Object.entries(state.expected.baseline.cards).every(([id, expected]) => {
		const card = cardIn(state, id);
		if (!card) return false;
		const actual = detailsOf(card);
		return (Object.keys(expected) as (keyof CardDetails)[]).every(
			key => ignored.includes(key) || JSON.stringify(actual[key]) === JSON.stringify(expected[key]),
		);
	});
}

const NO_NEW_CARDS: Check<KanbanSnapshot> = {
	id: "no-new-cards",
	description: "created no card",
	pass: state => state.cards.every(card => card.seeded),
};

function indexes(count: number): number[] {
	return Array.from({ length: count }, (_, index) => index);
}

/** Give a card `label` (and a fresh title of that label when its first label was another). */
function relabel(world: KanbanWorld, card: Card, label: LabelId, second: LabelId | null = null): void {
	if (card.labels[0] !== label) card.title = takeTitle(world, label);
	card.labels = second && second !== label ? [label, second] : [label];
}

function intro(origin: string): string {
	return `Trellis is a kanban board application at ${origin}.`;
}

async function post(client: FormClient, path: string, body: unknown): Promise<unknown> {
	const response = await client.postJson(path, body);
	if (response.status !== 200) throw new Error(`POST ${path} answered ${response.status}: ${response.body}`);
	return JSON.parse(response.body) as unknown;
}

// ---------------------------------------------------------------------------------------------
// kanban-move-review-bugs

interface ReviewBugs {
	readonly person: string;
	readonly personId: string;
	/** The cards to move, in their In Progress order. */
	readonly targets: readonly string[];
}

function planReviewBugs(world: KanbanWorld, rng: Seeded): ReviewBugs & { baseline: Baseline } {
	const [twinA, twinB] = world.members as [Member, Member];
	const person = rng.pick([twinA, twinB]);
	const twin = person === twinA ? twinB : twinA;
	const others = world.members.filter(member => member !== twinA && member !== twinB);
	const isPersonsBug = (card: Card) => card.labels.includes("bug") && card.assignee === person.id;

	const progress = columnCards(world, PLATFORM, "in-progress");
	const targetSlots = new Set(rng.sample(indexes(progress.length), rng.int(3, 4)));
	const roles = ["twin-bug", "other-bug", "person-feature", "person-security"];
	const free = rng.shuffle(indexes(progress.length).filter(index => !targetSlots.has(index)));
	progress.forEach((card, index) => {
		if (targetSlots.has(index)) {
			relabel(world, card, "bug", rng.next() < 0.35 ? rng.pick(["performance", "security"] as const) : null);
			card.assignee = person.id;
			return;
		}
		const role = roles[free.indexOf(index)];
		if (role === "twin-bug") {
			relabel(world, card, "bug");
			card.assignee = twin.id;
		} else if (role === "other-bug") {
			relabel(world, card, "bug");
			card.assignee = rng.pick(others).id;
		} else if (role === "person-feature") {
			relabel(world, card, "feature");
			card.assignee = person.id;
		} else if (role === "person-security") {
			relabel(world, card, "security");
			card.assignee = person.id;
		} else if (isPersonsBug(card)) {
			card.assignee = rng.pick(others).id;
		}
	});

	// In Review holds one of the person's bugs lower down, so a filtered view's top is not the column's top.
	const review = columnCards(world, PLATFORM, "in-review");
	for (const card of review) if (isPersonsBug(card)) card.assignee = rng.pick(others).id;
	const low = review[rng.int(2, review.length - 1)] as Card;
	relabel(world, low, "bug");
	low.assignee = person.id;
	// The person's bugs elsewhere: in Ready on this board, and in progress on another board.
	const ready = rng.pick(columnCards(world, PLATFORM, "ready"));
	relabel(world, ready, "bug");
	ready.assignee = person.id;
	const elsewhere = rng.pick(columnCards(world, MOBILE, "in-progress"));
	relabel(world, elsewhere, "bug");
	elsewhere.assignee = person.id;

	const targets = progress.filter((_, index) => targetSlots.has(index)).map(card => card.id);
	const after = structuredClone(world);
	const top = (review[0] as Card).id;
	for (const id of targets) moveCard(after, id, "in-review", top);
	return { person: person.name, personId: person.id, targets, baseline: baselineOf(after) };
}

const moveReviewBugs = kitTask<Graded<ReviewBugs>>({
	id: "kanban-move-review-bugs",
	title: "Drag one person's bug cards to the top of In Review, keeping their order",
	capabilities: ["drag-drop", "search-filter", "reasoning"],
	difficulty: "hard",
	timeBudgetSec: 720,
	async start({ seed }) {
		const rng = new Seeded(seed);
		const world = generateKanban(rng);
		const plan = planReviewBugs(world, rng);
		const board = boardOf(world, PLATFORM);
		const top = board.columns["in-review"][0] as string;
		const site = await startKanbanSite(world);
		return {
			instruction: [
				intro(site.origin),
				`On the ${board.name} board, move every card that has the Bug label and is assigned to ${plan.person} from In Progress to In Review.`,
				"They must end up at the very top of In Review, above every card already there, in the same order relative to each other that they had in In Progress. Move nothing else.",
			].join("\n"),
			solve: async () => {
				const client = new FormClient(site.origin);
				for (const id of plan.targets) await post(client, `/api/cards/${id}/move`, { column: "in-review", before: top });
				return `Moved ${plan.targets.length} cards to the top of In Review.`;
			},
			finish: async () => ({ ...(await site.finish()), expected: plan }),
		};
	},
	checks: [
		{
			id: "bugs-on-top",
			description: "the person's In Progress bugs head In Review, in their In Progress order",
			pass: state =>
				sameList(columnOf(state, PLATFORM, "in-review")?.slice(0, state.expected.targets.length), state.expected.targets),
		},
		{
			id: "review-rest-kept",
			description: "the cards already in In Review follow them in their old order",
			pass: state => sameList(columnOf(state, PLATFORM, "in-review"), state.expected.baseline.columns[PLATFORM]?.["in-review"]),
		},
		{
			id: "progress-rest-kept",
			description: "every other In Progress card stayed, in its order",
			pass: state =>
				sameList(columnOf(state, PLATFORM, "in-progress"), state.expected.baseline.columns[PLATFORM]?.["in-progress"]),
		},
		{
			id: "nothing-else-moved",
			description: "no other column of any board changed",
			pass: state => columnsKept(state, (boardId, column) => boardId === PLATFORM && (column === "in-review" || column === "in-progress")),
		},
		{
			id: "cards-unchanged",
			description: "no card was edited or archived",
			pass: state => cardsKept(state, ["column"]),
		},
		NO_NEW_CARDS,
	],
});

// ---------------------------------------------------------------------------------------------
// kanban-sort-by-due-date

interface SortByDue {
	/** Ready, sorted: dated cards by due date, then undated ones in their old order. */
	readonly order: readonly string[];
}

function planSortByDue(world: KanbanWorld, rng: Seeded): SortByDue & { baseline: Baseline } {
	const ready = columnCards(world, MOBILE, "ready");
	const undated = new Set(rng.sample(indexes(ready.length), rng.int(2, 3)));
	const dated = ready.filter((_, index) => !undated.has(index));
	const nextYear = `${Number(world.today.slice(0, 4)) + 1}-01-01`;
	const offsets = indexes(91).map(index => index - 10);
	for (let attempt = 0; ; attempt++) {
		if (attempt > 200) throw new Error("no due dates spanning the new year");
		const picked = rng.sample(offsets, dated.length).map(offset => addDays(world.today, offset));
		// Dates on both sides of the new year, so a card face's missing year matters.
		const thisYear = picked.filter(date => date < nextYear).length;
		if (thisYear < 2 || picked.length - thisYear < 2) continue;
		dated.forEach((card, index) => {
			card.due = picked[index] as string;
		});
		break;
	}
	ready.forEach((card, index) => {
		if (undated.has(index)) card.due = null;
	});
	const order = [
		...[...dated].sort((a, b) => (a.due as string).localeCompare(b.due as string)),
		...ready.filter((_, index) => undated.has(index)),
	].map(card => card.id);
	if (sameList(order, ready.map(card => card.id))) return planSortByDue(world, rng);
	const after = structuredClone(world);
	for (const id of order) moveCard(after, id, "ready", null);
	return { order, baseline: baselineOf(after) };
}

const sortByDueDate = kitTask<Graded<SortByDue>>({
	id: "kanban-sort-by-due-date",
	title: "Reorder a column by due date",
	capabilities: ["drag-drop", "reading", "reasoning"],
	difficulty: "hard",
	timeBudgetSec: 720,
	async start({ seed }) {
		const rng = new Seeded(seed);
		const world = generateKanban(rng);
		const plan = planSortByDue(world, rng);
		const board = boardOf(world, MOBILE);
		const site = await startKanbanSite(world);
		return {
			instruction: [
				intro(site.origin),
				`On the ${board.name} board, reorder the Ready column by due date: the earliest due date at the top, the latest at the bottom.`,
				"Cards without a due date go below every dated card, keeping the order they have now among themselves.",
				"Keep every card in Ready and change nothing else: no other column, and no card's details.",
			].join("\n"),
			solve: async () => {
				const client = new FormClient(site.origin);
				for (const id of plan.order) await post(client, `/api/cards/${id}/move`, { column: "ready", before: null });
				return "Ready is sorted by due date.";
			},
			finish: async () => ({ ...(await site.finish()), expected: plan }),
		};
	},
	checks: [
		{
			id: "ready-sorted",
			description: "Ready holds its cards in due-date order, undated cards last in their old order",
			pass: state => sameList(columnOf(state, MOBILE, "ready"), state.expected.order),
		},
		{
			id: "nothing-else-moved",
			description: "no other column of any board changed",
			pass: state => columnsKept(state, (boardId, column) => boardId === MOBILE && column === "ready"),
		},
		{
			id: "cards-unchanged",
			description: "no card was edited or archived, due dates included",
			pass: state => cardsKept(state),
		},
		NO_NEW_CARDS,
	],
});

// ---------------------------------------------------------------------------------------------
// kanban-create-release-card

const RELEASE_STEPS = [
	"Freeze the release branch",
	"Run the upgrade smoke test",
	"Update the changelog",
	"Tag the release build",
	"Publish the release notes",
	"Notify the support team",
	"Verify the rollback plan",
];

interface ReleaseCard {
	readonly title: string;
	readonly label: LabelId;
	readonly assigneeId: string;
	readonly assignee: string;
	readonly due: string;
	readonly items: readonly string[];
}

function planReleaseCard(world: KanbanWorld, rng: Seeded): ReleaseCard & { baseline: Baseline } {
	const major = rng.int(3, 7);
	const minor = rng.int(2, 9);
	const label = rng.pick(["chore", "docs", "design", "performance"] as const);
	const [twinA, twinB] = world.members as [Member, Member];
	const person = rng.pick([twinA, twinB]);
	const twin = person === twinA ? twinB : twinA;
	const items = rng.sample(RELEASE_STEPS, 3);
	// Last release's card, finished, and a card about this release that is not the one to create.
	const previous = rng.pick(columnCards(world, WEBSITE, "done"));
	previous.title = `Release ${major}.${minor - 1} readiness review`;
	previous.labels = [label];
	previous.assignee = twin.id;
	previous.checklist = items.map((text, index) => ({ id: `i${world.nextId + index}`, text, done: true }));
	world.nextId += items.length;
	const announcement = rng.pick(columnCards(world, WEBSITE, "backlog"));
	announcement.title = `Release ${major}.${minor} announcement post`;
	announcement.labels = ["docs"];
	return {
		title: `Release ${major}.${minor} readiness review`,
		label,
		assigneeId: person.id,
		assignee: person.name,
		due: addDays(world.today, rng.int(20, 70)),
		items,
		baseline: baselineOf(world),
	};
}

function createdCards(state: KanbanSnapshot): readonly CardState[] {
	return state.cards.filter(card => !card.seeded);
}

function onlyCreated(state: KanbanSnapshot): CardState | undefined {
	const created = createdCards(state);
	return created.length === 1 ? created[0] : undefined;
}

const createReleaseCard = kitTask<Graded<ReleaseCard>>({
	id: "kanban-create-release-card",
	title: "Create a fully specified card through the card dialog",
	capabilities: ["forms", "overlays", "date-picker"],
	difficulty: "medium",
	timeBudgetSec: 540,
	async start({ seed }) {
		const rng = new Seeded(seed);
		const world = generateKanban(rng);
		const plan = planReleaseCard(world, rng);
		const board = boardOf(world, WEBSITE);
		const site = await startKanbanSite(world);
		return {
			instruction: [
				intro(site.origin),
				`On the ${board.name} board, create a new card in the Backlog column titled "${plan.title}".`,
				`Give it the ${labelName(plan.label)} label and no other, assign it to ${plan.assignee}, and set its due date to ${weekdayDate(plan.due)}.`,
				`Give it a checklist of three items, in this order: "${plan.items.join('", "')}". Mark the first item done and leave the other two open.`,
				"Do not change any other card.",
			].join("\n"),
			solve: async () => {
				const client = new FormClient(site.origin);
				const created = (await post(client, `/api/boards/${WEBSITE}/cards`, { column: "backlog", title: plan.title })) as {
					card: { id: string };
				};
				const id = created.card.id;
				await post(client, `/api/cards/${id}/labels`, { label: plan.label, on: true });
				await post(client, `/api/cards/${id}`, { assignee: plan.assigneeId, due: slashDate(plan.due) });
				let itemIds: string[] = [];
				for (const text of plan.items) {
					const updated = (await post(client, `/api/cards/${id}/checklist`, { text })) as { card: { checklist: { id: string }[] } };
					itemIds = updated.card.checklist.map(item => item.id);
				}
				await post(client, `/api/cards/${id}/checklist/${itemIds[0]}`, { done: true });
				return `Created "${plan.title}".`;
			},
			finish: async () => ({ ...(await site.finish()), expected: plan }),
		};
	},
	checks: [
		{ id: "one-new-card", description: "created exactly one card", pass: state => createdCards(state).length === 1 },
		{
			id: "in-backlog",
			description: "the card is in the Backlog of the board named, not archived",
			pass: state => {
				const card = onlyCreated(state);
				return card?.boardId === WEBSITE && card.column === "backlog" && !card.archived;
			},
		},
		{ id: "title", description: "has the title given", pass: state => onlyCreated(state)?.title === state.expected.title },
		{
			id: "label",
			description: "has the one label given",
			pass: state => sameList(onlyCreated(state)?.labels, [state.expected.label]),
		},
		{ id: "assignee", description: "is assigned to the person named", pass: state => onlyCreated(state)?.assignee === state.expected.assigneeId },
		{ id: "due-date", description: "is due on the date given", pass: state => onlyCreated(state)?.due === state.expected.due },
		{
			id: "checklist-items",
			description: "has the three checklist items, in order",
			pass: state =>
				sameList(
					onlyCreated(state)?.checklist.map(item => normalizeText(item.text)),
					state.expected.items.map(normalizeText),
				),
		},
		{
			id: "first-item-done",
			description: "only the first checklist item is done",
			pass: state => sameList(onlyCreated(state)?.checklist.map(item => String(item.done)), ["true", "false", "false"]),
		},
		{
			id: "other-cards-unchanged",
			description: "no other card was edited, moved or archived",
			pass: state => cardsKept(state) && columnsKept(state),
		},
	],
});

// ---------------------------------------------------------------------------------------------
// kanban-rename-and-archive

const QUALIFIERS = [
	"on Android",
	"in the admin console",
	"for enterprise workspaces",
	"after the v2 migration",
	"in Safari",
	"for EU customers",
];

interface RenameArchive {
	readonly renames: readonly { readonly id: string; readonly from: string; readonly to: string }[];
	readonly cutoff: string;
	/** The Done cards completed before the cutoff, top first. */
	readonly toArchive: readonly string[];
	/** Every archived card after a correct run, those archived before the trial included. */
	readonly archived: readonly string[];
}

function planRenameArchive(world: KanbanWorld, rng: Seeded): RenameArchive & { baseline: Baseline } {
	const targets = [
		rng.pick(columnCards(world, PLATFORM, "backlog")),
		rng.pick(columnCards(world, PLATFORM, "ready")),
		rng.pick(columnCards(world, PLATFORM, rng.pick(["in-progress", "in-review"] as const))),
	];
	const qualifiers = rng.sample(QUALIFIERS, targets.length);
	const renames = targets.map((card, index) => ({ id: card.id, from: card.title, to: `${card.title} ${qualifiers[index]}` }));
	// The same title on another board, and a longer title holding one of them on this one.
	const [first, second] = targets as [Card, Card, Card];
	rng.pick(columnCards(world, MOBILE, rng.pick(OPEN_COLUMNS))).title = first.title;
	const followUp = rng.pick(
		OPEN_COLUMNS.flatMap(column => columnCards(world, PLATFORM, column)).filter(card => !targets.includes(card)),
	);
	followUp.title = `${second.title} follow-up`;

	const cutoff = addDays(world.today, -rng.int(24, 34));
	const done = rng.shuffle(columnCards(world, PLATFORM, "done"));
	done.forEach((card, index) => {
		if (index === 0) card.completed = cutoff;
		else if (index === 1) card.completed = addDays(cutoff, -1);
		else if (index === 2) {
			// Finished before the cutoff, due after it.
			card.completed = addDays(cutoff, -rng.int(3, 12));
			card.due = addDays(cutoff, rng.int(3, 10));
		} else if (index === 3) {
			// Due before the cutoff, finished after it.
			card.due = addDays(cutoff, -rng.int(3, 15));
			card.completed = addDays(cutoff, rng.int(2, 10));
		} else {
			card.completed = addDays(world.today, -rng.int(1, 60));
		}
	});
	const toArchive = columnCards(world, PLATFORM, "done")
		.filter(card => (card.completed as string) < cutoff)
		.map(card => card.id);
	const after = structuredClone(world);
	for (const rename of renames) (after.cards.find(card => card.id === rename.id) as Card).title = rename.to;
	for (const id of toArchive) archiveCard(after, id);
	const archived = after.cards.filter(card => card.archived).map(card => card.id);
	return { renames, cutoff, toArchive, archived, baseline: baselineOf(after) };
}

const renameAndArchive = kitTask<Graded<RenameArchive>>({
	id: "kanban-rename-and-archive",
	title: "Rename cards in place and archive what finished before a date",
	capabilities: ["inline-edit", "reading", "overlays"],
	difficulty: "medium",
	timeBudgetSec: 600,
	async start({ seed }) {
		const rng = new Seeded(seed);
		const world = generateKanban(rng);
		const plan = planRenameArchive(world, rng);
		const board = boardOf(world, PLATFORM);
		const site = await startKanbanSite(world);
		return {
			instruction: [
				intro(site.origin),
				`On the ${board.name} board:`,
				...plan.renames.map(rename => `- rename the card "${rename.from}" to "${rename.to}";`),
				`- archive every card in the Done column that was completed before ${longDate(plan.cutoff)}.`,
				"Leave every other card as it is.",
			].join("\n"),
			solve: async () => {
				const client = new FormClient(site.origin);
				for (const rename of plan.renames) await post(client, `/api/cards/${rename.id}`, { title: rename.to });
				for (const id of plan.toArchive) await post(client, `/api/cards/${id}/archive`, {});
				return "Renamed three cards and archived the old Done cards.";
			},
			finish: async () => ({ ...(await site.finish()), expected: plan }),
		};
	},
	checks: [
		{
			id: "renamed",
			description: "the three cards carry their new titles",
			pass: state => state.expected.renames.every(rename => cardIn(state, rename.id)?.title === rename.to),
		},
		{
			id: "archived-set",
			description: "exactly the Done cards completed before the date were archived, and no card was restored",
			pass: state =>
				sameList(
					state.cards.filter(card => card.archived).map(card => card.id).sort(),
					[...state.expected.archived].sort(),
				),
		},
		{
			id: "other-titles-kept",
			description: "no other card was renamed, the look-alike titles included",
			pass: state => {
				const renamed = new Set(state.expected.renames.map(rename => rename.id));
				return Object.entries(state.expected.baseline.cards).every(
					([id, expected]) => renamed.has(id) || cardIn(state, id)?.title === expected.title,
				);
			},
		},
		{ id: "nothing-moved", description: "no card changed column or position", pass: state => columnsKept(state) },
		{
			id: "cards-unchanged",
			description: "no other detail of any card changed",
			pass: state => cardsKept(state, ["title", "archived"]),
		},
		NO_NEW_CARDS,
	],
});

// ---------------------------------------------------------------------------------------------
// kanban-rebalance-load

interface Rebalance {
	readonly limit: number;
	readonly moves: readonly { readonly id: string; readonly from: string; readonly to: string }[];
	/** The assignee of every card, on every board, after a correct run. */
	readonly assignees: Readonly<Record<string, string | null>>;
}

/** Hand each overloaded member's latest-due open cards to the least-loaded member until nobody exceeds `limit`. */
function rebalance(world: KanbanWorld, boardId: string, limit: number): Rebalance["moves"] {
	const open = world.cards.filter(card => card.boardId === boardId && isOpen(card));
	const load = new Map(world.members.map(member => [member.id, open.filter(card => card.assignee === member.id).length]));
	const byName = alphabetical(world.members);
	const moves: { id: string; from: string; to: string }[] = [];
	for (const giver of byName.filter(member => (load.get(member.id) ?? 0) > limit)) {
		while ((load.get(giver.id) ?? 0) > limit) {
			const card = open
				.filter(entry => entry.assignee === giver.id)
				.reduce((latest, entry) => ((entry.due as string) > (latest.due as string) ? entry : latest));
			const receiver = byName
				.filter(member => member.id !== giver.id)
				.reduce((least, member) => ((load.get(member.id) ?? 0) < (load.get(least.id) ?? 0) ? member : least));
			card.assignee = receiver.id;
			load.set(giver.id, (load.get(giver.id) ?? 0) - 1);
			load.set(receiver.id, (load.get(receiver.id) ?? 0) + 1);
			moves.push({ id: card.id, from: giver.id, to: receiver.id });
		}
	}
	return moves;
}

function planRebalance(world: KanbanWorld, rng: Seeded): Rebalance & { baseline: Baseline } {
	const open = OPEN_COLUMNS.flatMap(column => columnCards(world, WEBSITE, column));
	const [twinA, twinB] = world.members as [Member, Member];
	const overTwin = rng.pick([twinA, twinB]);
	const rest = world.members.filter(member => member !== overTwin);
	const overOther = rng.pick(rest.filter(member => member !== twinA && member !== twinB));
	const under = rng.shuffle(rest.filter(member => member !== overOther));
	let limit = 0;
	let loads = new Map<string, number>();
	for (let attempt = 0; ; attempt++) {
		if (attempt > 200) throw new Error("no loads fit the board");
		limit = rng.int(4, 5);
		const least = rng.int(1, limit - 2);
		loads = new Map([
			[overTwin.id, limit + rng.int(1, 3)],
			[overOther.id, limit + rng.int(1, 3)],
			...under.map((member, index): [string, number] => [member.id, index < 2 ? least : rng.int(least + 1, limit)]),
		]);
		const total = [...loads.values()].reduce((sum, value) => sum + value, 0);
		// The rule must bring everyone within the limit: the others have room for every card handed over.
		const excess = [overTwin, overOther].reduce((sum, member) => sum + (loads.get(member.id) ?? 0) - limit, 0);
		const room = under.reduce((sum, member) => sum + limit - (loads.get(member.id) ?? 0), 0);
		if (total <= open.length - 3 && excess <= room) break;
	}
	const shuffled = rng.shuffle(open);
	let next = 0;
	for (const [memberId, count] of loads) {
		for (let index = 0; index < count; index++) (shuffled[next++] as Card).assignee = memberId;
	}
	for (const card of shuffled.slice(next)) card.assignee = null;
	// Every open card of an overloaded member has its own due date, so "latest first" picks one card.
	for (const member of [overTwin, overOther]) {
		const cards = open.filter(card => card.assignee === member.id);
		const dates = rng.sample(indexes(91), cards.length).map(offset => addDays(world.today, offset - 10));
		cards.forEach((card, index) => {
			card.due = dates[index] as string;
		});
	}
	// Finished cards of an overloaded member, which do not count.
	for (const card of rng.sample(columnCards(world, WEBSITE, "done"), 2)) card.assignee = overTwin.id;

	const after = structuredClone(world);
	const moves = rebalance(after, WEBSITE, limit);
	const assignees = Object.fromEntries(after.cards.map(card => [card.id, card.assignee]));
	return { limit, moves, assignees, baseline: baselineOf(after) };
}

function openLoads(state: KanbanSnapshot, boardId: string): Map<string, number> {
	const load = new Map<string, number>();
	for (const card of state.cards) {
		if (card.boardId !== boardId || !isOpen(card) || !card.assignee) continue;
		load.set(card.assignee, (load.get(card.assignee) ?? 0) + 1);
	}
	return load;
}

const rebalanceLoad = kitTask<Graded<Rebalance>>({
	id: "kanban-rebalance-load",
	title: "Rebalance open cards across a team by a stated rule",
	capabilities: ["reasoning", "search-filter", "reading", "overlays"],
	difficulty: "expert",
	timeBudgetSec: 900,
	async start({ seed }) {
		const rng = new Seeded(seed);
		const world = generateKanban(rng);
		const plan = planRebalance(world, rng);
		const board = boardOf(world, WEBSITE);
		const site = await startKanbanSite(world);
		const n = plan.limit;
		return {
			instruction: [
				intro(site.origin),
				`On the ${board.name} board, nobody may hold more than ${n} open cards. A card is open when it is in any column except Done; archived cards and cards on other boards do not count.`,
				"Bring everyone within the limit by reassigning cards, following these rules exactly:",
				"- Take the people over the limit in alphabetical order of their full names.",
				`- For each of them, reassign their open cards one at a time, the one with the latest due date first, until they hold ${n}.`,
				"- Each card goes to whoever holds the fewest open cards on the board at that moment, not counting the person giving it up; when several tie, to the one whose full name comes first alphabetically. Everyone in the board's assignee list can receive cards.",
				"Change only assignees: move no card to another column and change nothing else.",
			].join("\n"),
			solve: async () => {
				const client = new FormClient(site.origin);
				for (const move of plan.moves) await post(client, `/api/cards/${move.id}`, { assignee: move.to });
				return `Reassigned ${plan.moves.length} cards.`;
			},
			finish: async () => ({ ...(await site.finish()), expected: plan }),
		};
	},
	checks: [
		{
			id: "reassigned",
			description: "each card the rule moves went to the person the rule picks",
			pass: state => state.expected.moves.every(move => cardIn(state, move.id)?.assignee === move.to),
		},
		{
			id: "others-kept",
			description: "every other card, on every board, kept its assignee",
			pass: state => {
				const moved = new Set(state.expected.moves.map(move => move.id));
				return Object.entries(state.expected.assignees).every(
					([id, assignee]) => moved.has(id) || cardIn(state, id)?.assignee === assignee,
				);
			},
		},
		{
			id: "within-limit",
			description: "nobody holds more open cards than the limit",
			pass: state => [...openLoads(state, WEBSITE).values()].every(count => count <= state.expected.limit),
		},
		{ id: "nothing-moved", description: "no card changed column or position", pass: state => columnsKept(state) },
		{ id: "cards-unchanged", description: "no other detail of any card changed", pass: state => cardsKept(state, ["assignee"]) },
		NO_NEW_CARDS,
	],
});

// ---------------------------------------------------------------------------------------------
// kanban-edit-after-conflict

/** The column a card moves on to, from each column this task takes it from. */
const NEXT_COLUMN = { backlog: "ready", ready: "in-progress", "in-progress": "in-review" } as const;

interface EditAfterConflict {
	readonly boardId: string;
	readonly cardId: string;
	/** The card's title before the teammate's edit: the one the instruction names. */
	readonly title: string;
	/** The card's labels before the teammate's edit. */
	readonly labels: readonly LabelId[];
	readonly from: ColumnId;
	readonly to: ColumnId;
	/** The card at the top of `to` before the trial, which the card lands above. */
	readonly above: string | null;
	readonly assigneeId: string;
	readonly assignee: string;
	readonly due: string;
	readonly itemId: string;
	readonly item: string;
	/** The edit the teammate saves the moment the trial's first change to the card arrives. */
	readonly teammate: KanbanConflict;
	/** The card's labels after the teammate's edit. */
	readonly teammateLabels: readonly LabelId[];
	/** The title of the card on the same board that begins with the card's title. */
	readonly lookAlike: string;
}

/**
 * One card to change in four ways. The site's teammate renames it and adds a label the moment the
 * first change to it arrives, and the site refuses that change as stale. A follow-up card on the
 * same board begins with its title and holds the same open item; a card on another board has its title.
 */
function planEditAfterConflict(world: KanbanWorld, rng: Seeded): EditAfterConflict & { baseline: Baseline } {
	const boardId = rng.pick([PLATFORM, MOBILE, WEBSITE]);
	const from = rng.pick(["backlog", "ready", "in-progress"] as const);
	const to = NEXT_COLUMN[from];
	const card = rng.pick(columnCards(world, boardId, from));
	const [holder, teammate, assignee] = rng.sample(world.members, 3) as [Member, Member, Member];
	card.assignee = holder.id;
	card.due = rng.next() < 0.3 ? null : addDays(world.today, rng.int(-5, 20));
	const due = addDays(world.today, rng.int(21, 75));
	const texts = rng.sample(CHECKLIST_POOL, rng.int(3, 4));
	const ticked = rng.int(0, texts.length - 1);
	card.checklist = texts.map((text, index) => ({
		id: `i${world.nextId++}`,
		text,
		done: index !== ticked && rng.next() < 0.5,
	}));
	const item = card.checklist[ticked] as ChecklistItem;
	// A follow-up on the same board holding the same open item, and the same title on another board.
	const lookAlike = rng.pick(
		OPEN_COLUMNS.filter(column => column !== from && column !== to).flatMap(column =>
			columnCards(world, boardId, column),
		),
	);
	lookAlike.title = `${card.title} follow-up`;
	lookAlike.checklist = [
		{ id: `i${world.nextId++}`, text: item.text, done: false },
		{
			id: `i${world.nextId++}`,
			text: rng.pick(CHECKLIST_POOL.filter(text => text !== item.text)),
			done: rng.next() < 0.5,
		},
	];
	const otherBoard = rng.pick([PLATFORM, MOBILE, WEBSITE].filter(id => id !== boardId));
	rng.pick(OPEN_COLUMNS.flatMap(column => columnCards(world, otherBoard, column))).title = card.title;
	const label = rng.pick(LABELS.filter(entry => !card.labels.includes(entry.id))).id;
	const edit: KanbanConflict = {
		cardId: card.id,
		teammate: teammate.id,
		title: `${card.title} ${rng.pick(QUALIFIERS)}`,
		label,
	};
	const above = boardOf(world, boardId).columns[to][0] ?? null;

	const after = structuredClone(world);
	const done = findCard(after, card.id) as Card;
	done.title = edit.title;
	done.labels.push(label);
	done.assignee = assignee.id;
	done.due = due;
	for (const entry of done.checklist) if (entry.id === item.id) entry.done = true;
	moveCard(after, card.id, to, above);
	return {
		boardId,
		cardId: card.id,
		title: card.title,
		labels: [...card.labels],
		from,
		to,
		above,
		assigneeId: assignee.id,
		assignee: assignee.name,
		due,
		itemId: item.id,
		item: item.text,
		teammate: edit,
		teammateLabels: [...done.labels],
		lookAlike: lookAlike.title,
		baseline: baselineOf(after),
	};
}

/**
 * Every card present before the trial but `except` holds its baseline details, and every column,
 * `except` and created cards left out, keeps its baseline order.
 */
function othersKept(state: Graded<unknown>, except: string): boolean {
	const others = new Set(state.cards.filter(card => card.seeded && card.id !== except).map(card => card.id));
	const ordered = Object.entries(state.expected.baseline.columns).every(([boardId, columns]) =>
		(Object.entries(columns) as [ColumnId, readonly string[]][]).every(([column, ids]) =>
			sameList(
				columnOf(state, boardId, column)?.filter(id => others.has(id)),
				ids.filter(id => id !== except),
			),
		),
	);
	return (
		ordered &&
		Object.entries(state.expected.baseline.cards).every(([id, expected]) => {
			const card = cardIn(state, id);
			return id === except || (card !== undefined && JSON.stringify(detailsOf(card)) === JSON.stringify(expected));
		})
	);
}

export const kanbanEditAfterConflictTask = kitTask<Graded<EditAfterConflict>>({
	id: "kanban-edit-after-conflict",
	title: "Edit a card whose first save a teammate's edit refuses, keeping the teammate's edit",
	capabilities: ["recovery", "forms", "overlays", "date-picker", "reading"],
	difficulty: "expert",
	timeBudgetSec: 900,
	async start({ seed }) {
		const rng = new Seeded(seed);
		const world = generateKanban(rng);
		const plan = planEditAfterConflict(world, rng);
		const board = boardOf(world, plan.boardId);
		const site = await startKanbanSite(world, { conflict: plan.teammate });
		return {
			instruction: [
				intro(site.origin),
				`On the ${board.name} board, update the card "${plan.title}" in the ${columnName(plan.from)} column:`,
				`- assign it to ${plan.assignee};`,
				`- set its due date to ${weekdayDate(plan.due)};`,
				`- mark its checklist item "${plan.item}" done, leaving its other items as they are;`,
				`- move it to the top of the ${columnName(plan.to)} column.`,
				"Other people edit this board at the same time. Keep every change they make, and change no other card.",
				"When you are done, reply with the card's current title.",
			].join("\n"),
			solve: async () => {
				const client = new FormClient(site.origin);
				const path = `/api/cards/${plan.cardId}`;
				const read = async (): Promise<CardJson> => {
					const reply = JSON.parse((await client.get(path)).body) as { readonly card: CardJson };
					return reply.card;
				};
				const save = async (action: string, body: Readonly<Record<string, unknown>>): Promise<CardJson> => {
					const reply = (await post(client, `${path}${action}`, body)) as { readonly card: CardJson };
					return reply.card;
				};
				await client.get(`/b/${plan.boardId}`);
				const opened = await read();
				const fields = { assignee: plan.assigneeId, due: slashDate(plan.due) };
				// The teammate saves first, so the save based on the card as opened is refused.
				const refused = await client.postJson(path, { ...fields, version: opened.version });
				if (refused.status !== 409) throw new Error(`the first save answered ${refused.status}, not 409`);
				// Read the card again and make only this task's changes on top of the teammate's edit.
				let card = await read();
				card = await save("", { ...fields, version: card.version });
				card = await save(`/checklist/${plan.itemId}`, { done: true, version: card.version });
				card = await save("/move", { column: plan.to, before: plan.above, version: card.version });
				return `The card's title is now "${card.title}".`;
			},
			finish: async () => ({ ...(await site.finish()), expected: plan }),
		};
	},
	checks: [
		{
			id: "assignee",
			description: "the card is assigned to the person named",
			pass: state => cardIn(state, state.expected.cardId)?.assignee === state.expected.assigneeId,
		},
		{
			id: "due-date",
			description: "the card is due on the date given",
			pass: state => cardIn(state, state.expected.cardId)?.due === state.expected.due,
		},
		{
			id: "checklist",
			description:
				"the named checklist item is done, and the card's other items are as they were, none added or removed",
			pass: state => {
				const card = cardIn(state, state.expected.cardId);
				const expected = state.expected.baseline.cards[state.expected.cardId];
				return (
					card !== undefined && JSON.stringify(detailsOf(card).checklist) === JSON.stringify(expected?.checklist)
				);
			},
		},
		{
			id: "moved",
			description: "the card is at the top of the column named",
			pass: state => columnOf(state, state.expected.boardId, state.expected.to)?.[0] === state.expected.cardId,
		},
		{
			id: "teammate-edit-kept",
			description:
				"the card keeps the title and labels the teammate's edit left it with (as seeded when the edit never came), none changed back and none added",
			pass: state => {
				const card = cardIn(state, state.expected.cardId);
				const edited = (state.conflict?.firedBy ?? null) !== null;
				const title = edited ? state.expected.teammate.title : state.expected.title;
				const labels = edited ? state.expected.teammateLabels : state.expected.labels;
				return card !== undefined && card.title === title && sameList([...card.labels].sort(), [...labels].sort());
			},
		},
		{
			id: "other-cards-unchanged",
			description: "no other card was edited or moved, the look-alikes included, and every column keeps its order",
			pass: state => othersKept(state, state.expected.cardId),
		},
		{
			id: "nothing-created-or-archived",
			description: "no card was created, archived or restored",
			pass: state =>
				state.cards.every(card => card.seeded) &&
				sameList(
					state.cards
						.filter(card => card.archived)
						.map(card => card.id)
						.sort(),
					Object.entries(state.expected.baseline.cards)
						.filter(([, card]) => card.archived)
						.map(([id]) => id)
						.sort(),
				),
		},
		{
			id: "conflict-then-saved",
			description:
				"a save of the card was refused as older than the teammate's edit, and a save of it succeeded after that",
			pass: state => (state.conflict?.firedBy ?? null) !== null && (state.conflict?.savedAfter ?? 0) > 0,
		},
		{
			id: "answer",
			description: "the reply gives the card's title after the teammate's edit, and not the look-alike's",
			pass: (state, answer) => answerNamesOnly(answer, state.expected.teammate.title, [state.expected.lookAlike]),
		},
	],
});

export const KANBAN_TASKS: readonly KitTask[] = [
	moveReviewBugs,
	sortByDueDate,
	createReleaseCard,
	renameAndArchive,
	rebalanceLoad,
	kanbanEditAfterConflictTask,
];
