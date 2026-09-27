/**
 * Trellis's pages and JSON endpoints over one {@link KanbanWorld}.
 *
 * What makes it hard to operate is ordinary kanban design: cards move by dragging (pointer events
 * on most boards, the HTML drag-and-drop events on the Mobile App board) or through a "Move to…"
 * dialog whose positions count cards a filter hides; a title is edited in place after a
 * double-click; labels are colour chips until expanded; an avatar shows initials that two members
 * share; a card face omits the year of a date in the current year; the due date takes one format
 * and has a calendar popover that fills the field without saving it. Every change is posted to
 * the server as JSON, which is what a grader reads.
 */

import {
	escapeHtml,
	type HostedSite,
	hostSite,
	html,
	json,
	jsonBody,
	type SiteRequest,
	type SiteResponse,
	text,
} from "../../../../engine/kit/web-host";
import { page } from "../../ui";
import { ARCHIVE_SCRIPT, BOARD_SCRIPT, BOARD_STYLE } from "./client";
import {
	alphabetical,
	archiveCard,
	type Board,
	type Card,
	type ColumnId,
	COLUMNS,
	cardKey,
	columnName,
	findBoard,
	findCard,
	findMember,
	isColumn,
	isLabel,
	LABELS,
	longDate,
	moveCard,
	parseSlashDate,
	restoreCard,
	shortDate,
	stateOf,
	type KanbanState,
	type KanbanWorld,
	YOU,
} from "./data";

export interface KanbanSnapshot extends KanbanState {
	/** Move requests the server accepted. */
	readonly moves: number;
	/** Requests the server refused as invalid. */
	readonly rejected: number;
}

export interface KanbanSite extends HostedSite {
	finish(): Promise<KanbanSnapshot>;
}

const MAX_TITLE = 120;

/** What the card modal reads. */
export interface CardJson {
	readonly id: string;
	readonly key: string;
	readonly boardId: string;
	readonly title: string;
	readonly column: ColumnId;
	readonly labels: readonly string[];
	readonly assignee: string | null;
	readonly due: string | null;
	readonly completed: string | null;
	readonly completedLong: string | null;
	readonly checklist: readonly { readonly id: string; readonly text: string; readonly done: boolean }[];
	readonly comments: readonly { readonly id: string; readonly author: string; readonly body: string; readonly date: string }[];
	readonly archived: boolean;
}

function oneLine(value: unknown): string {
	return typeof value === "string" ? value.replaceAll(/\s+/g, " ").trim() : "";
}

export async function startKanbanSite(world: KanbanWorld): Promise<KanbanSite> {
	let moves = 0;
	let rejected = 0;

	const refuse = (message: string, status = 400): SiteResponse => {
		rejected++;
		return json({ error: message }, { status });
	};

	const nav = () =>
		`<a href="/">Boards</a>${world.boards.map(board => `<a href="/b/${board.id}">${escapeHtml(board.name)}</a>`).join("")}`;

	const render = (title: string, body: string, script = "", style = ""): SiteResponse =>
		html(page(title, body, { brand: "Trellis", nav: nav(), script, style }));

	const cardJson = (card: Card): CardJson => ({
		id: card.id,
		key: cardKey(world, card),
		boardId: card.boardId,
		title: card.title,
		column: card.column,
		labels: [...card.labels],
		assignee: card.assignee,
		due: card.due,
		completed: card.completed,
		completedLong: card.completed ? longDate(card.completed) : null,
		checklist: card.checklist.map(item => ({ id: item.id, text: item.text, done: item.done })),
		comments: card.comments.map(comment => ({
			id: comment.id,
			author: comment.author === YOU ? "You" : (findMember(world, comment.author)?.name ?? "Former member"),
			body: comment.body,
			date: longDate(comment.date),
		})),
		archived: card.archived,
	});

	const cardHtml = (board: Board, card: Card) => {
		const chips = card.labels
			.map(id => {
				const label = LABELS.find(entry => entry.id === id);
				if (!label) return "";
				return `<span class="chip" role="img" style="background:${label.color}" title="${label.name}" aria-label="Label: ${label.name}"><span class="chip-text">${label.name}</span></span>`;
			})
			.join("");
		const badges: string[] = [`<span class="key">${escapeHtml(cardKey(world, card))}</span>`];
		if (card.due) {
			const overdue = card.column !== "done" && card.due < world.today;
			badges.push(
				`<span class="badge due${overdue ? " overdue" : ""}" title="Due date">Due <time datetime="${card.due}">${shortDate(card.due, world.today)}</time></span>`,
			);
		}
		if (card.completed) {
			badges.push(
				`<span class="badge done-badge" title="Completed">✓ <time datetime="${card.completed}">${shortDate(card.completed, world.today)}</time></span>`,
			);
		}
		if (card.checklist.length > 0) {
			const done = card.checklist.filter(item => item.done).length;
			badges.push(`<span class="badge" title="Checklist">☑ ${done}/${card.checklist.length}</span>`);
		}
		if (card.comments.length > 0) badges.push(`<span class="badge" title="Comments">💬 ${card.comments.length}</span>`);
		const member = card.assignee ? findMember(world, card.assignee) : undefined;
		if (member) {
			badges.push(
				`<span class="avatar" role="img" title="${escapeHtml(member.name)}" aria-label="Assigned to ${escapeHtml(member.name)}">${escapeHtml(member.initials)}</span>`,
			);
		}
		return `<article class="kcard" tabindex="0" data-card="${card.id}" data-labels="${card.labels.join(" ")}" data-assignee="${card.assignee ?? ""}"${board.drag === "html5" ? ' draggable="true"' : ""}>
<div class="chips">${chips}</div>
<div class="ctitle">${escapeHtml(card.title)}</div>
<div class="meta">${badges.join("")}</div>
<button type="button" class="menu-btn" aria-label="Card actions" aria-haspopup="menu">⋯</button>
</article>`;
	};

	const boardPage = (board: Board, url: URL): SiteResponse => {
		const label = url.searchParams.get("label") ?? "";
		const member = url.searchParams.get("member") ?? "";
		const query = url.searchParams.get("q") ?? "";
		const columns = COLUMNS.map(column => {
			const ids = board.columns[column.id];
			const cards = ids.map(id => cardHtml(board, findCard(world, id) as Card)).join("");
			return `<section class="column" data-column="${column.id}" aria-labelledby="col-${column.id}">
<header class="column-head"><h2 id="col-${column.id}">${column.name}</h2><span class="count">${ids.length}</span></header>
<div class="cards" data-list="${column.id}">${cards}</div>
<footer class="column-foot"><button type="button" class="add-card secondary">+ Add a card</button></footer>
</section>`;
		}).join("");
		const option = (value: string, name: string, selected: string) =>
			`<option value="${escapeHtml(value)}"${value === selected ? " selected" : ""}>${escapeHtml(name)}</option>`;
		const labelOptions = [option("", "Any label", label), ...LABELS.map(entry => option(entry.id, entry.name, label))].join("");
		const memberOptions = [
			option("", "Anyone", member),
			option("none", "Unassigned", member),
			...alphabetical(world.members).map(entry => option(entry.id, entry.name, member)),
		].join("");
		const onBoard = world.cards.filter(card => card.boardId === board.id);
		const archivedCount = onBoard.filter(card => card.archived).length;
		const config = {
			board: board.id,
			drag: board.drag,
			today: world.today,
			members: alphabetical(world.members).map(entry => ({ id: entry.id, name: entry.name, initials: entry.initials })),
			labels: LABELS,
			columns: COLUMNS,
		};
		return render(
			`${board.name} · Trellis`,
			`<div class="boardbar row"><h1>${escapeHtml(board.name)}</h1><span class="muted">${board.key} · ${onBoard.length - archivedCount} cards</span>
<a href="/b/${board.id}/archived">Archived cards (${archivedCount})</a>
<button type="button" class="secondary" id="help-button" aria-keyshortcuts="?">Keyboard shortcuts (?)</button></div>
<form id="filters" class="filterbar row" role="search" onsubmit="return false">
<label>Label <select id="filter-label" name="label">${labelOptions}</select></label>
<label>Assignee <select id="filter-member" name="member">${memberOptions}</select></label>
<label>Title <input id="filter-q" name="q" type="search" placeholder="Filter by title (/)" value="${escapeHtml(query)}"></label>
<button type="button" class="secondary" id="clear-filters">Clear filters (x)</button>
<span id="filter-status" class="muted" aria-live="polite"></span>
</form>
<div id="board" class="board" data-board="${board.id}">${columns}</div>
<div id="toast" role="status" hidden></div>`,
			`var TRELLIS = ${JSON.stringify(config).replaceAll("<", "\\u003c")};\n${BOARD_SCRIPT}`,
			BOARD_STYLE,
		);
	};

	const archivedPage = (board: Board): SiteResponse => {
		const rows = world.cards
			.filter(card => card.boardId === board.id && card.archived)
			.map(
				card =>
					`<tr><td>${escapeHtml(cardKey(world, card))}</td><td>${escapeHtml(card.title)}</td><td>${columnName(card.column)}</td><td><button type="button" class="secondary" data-restore="${card.id}">Send to board</button></td></tr>`,
			)
			.join("");
		return render(
			`Archived · ${board.name}`,
			`<h1>Archived cards of ${escapeHtml(board.name)}</h1>
<p><a href="/b/${board.id}">← Back to the board</a></p>
${rows ? `<table><tr><th>Card</th><th>Title</th><th>Archived from</th><th></th></tr>${rows}</table>` : "<p>No archived cards.</p>"}`,
			ARCHIVE_SCRIPT,
		);
	};

	const homePage = (): SiteResponse =>
		render(
			"Boards · Trellis",
			`<h1>Your boards</h1><div class="grid">${world.boards
				.map(board => {
					const counts = COLUMNS.map(column => `${column.name}: ${board.columns[column.id].length}`).join(" · ");
					return `<a class="card" href="/b/${board.id}"><strong>${escapeHtml(board.name)}</strong><div class="muted">${counts}</div></a>`;
				})
				.join("")}</div>`,
		);

	const updateCard = (card: Card, body: Record<string, unknown>): SiteResponse => {
		let title: string | undefined;
		if ("title" in body) {
			title = oneLine(body.title);
			if (!title) return refuse("A card needs a title.");
			if (title.length > MAX_TITLE) return refuse(`A title holds at most ${MAX_TITLE} characters.`);
		}
		let assignee: string | null | undefined;
		if ("assignee" in body) {
			if (body.assignee !== null && !(typeof body.assignee === "string" && findMember(world, body.assignee))) {
				return refuse("Choose a member of the workspace.");
			}
			assignee = body.assignee as string | null;
		}
		let due: string | null | undefined;
		if ("due" in body) {
			// Null clears the date; anything but a string is refused rather than read as empty.
			const value = body.due === null ? "" : typeof body.due === "string" ? oneLine(body.due) : null;
			due = value ? parseSlashDate(value) : null;
			if (value === null || (value && !due)) return refuse("Enter the due date as M/D/YYYY, for example 3/9/2027.");
		}
		if (title !== undefined) card.title = title;
		if (assignee !== undefined) card.assignee = assignee;
		if (due !== undefined) card.due = due;
		return json({ card: cardJson(card) });
	};

	const cardAction = (card: Card, action: string, body: Record<string, unknown>): SiteResponse => {
		if (action === "") return updateCard(card, body);
		if (action === "move") {
			const before = body.before === undefined ? null : body.before;
			if (!isColumn(body.column) || (before !== null && typeof before !== "string")) return refuse("Choose a column.");
			const error = moveCard(world, card.id, body.column, before);
			if (error) return refuse(error);
			moves++;
			return json({ card: cardJson(card) });
		}
		if (action === "archive") {
			const error = archiveCard(world, card.id);
			return error ? refuse(error) : json({ card: cardJson(card) });
		}
		if (action === "restore") {
			const error = restoreCard(world, card.id);
			return error ? refuse(error) : json({ card: cardJson(card) });
		}
		if (action === "labels") {
			if (!isLabel(body.label) || typeof body.on !== "boolean") return refuse("Choose a label.");
			const has = card.labels.includes(body.label);
			if (body.on && !has) card.labels.push(body.label);
			if (!body.on && has) card.labels.splice(card.labels.indexOf(body.label), 1);
			return json({ card: cardJson(card) });
		}
		if (action === "checklist") {
			const itemText = oneLine(body.text);
			if (!itemText) return refuse("A checklist item needs text.");
			if (itemText.length > MAX_TITLE) return refuse(`A checklist item holds at most ${MAX_TITLE} characters.`);
			card.checklist.push({ id: `i${world.nextId++}`, text: itemText, done: false });
			return json({ card: cardJson(card) });
		}
		const itemMatch = /^checklist\/([a-z0-9]+)(\/delete)?$/.exec(action);
		if (itemMatch) {
			const item = card.checklist.find(entry => entry.id === itemMatch[1]);
			if (!item) return refuse("No such checklist item.", 404);
			if (itemMatch[2]) card.checklist.splice(card.checklist.indexOf(item), 1);
			else if (typeof body.done === "boolean") item.done = body.done;
			else return refuse("Say whether the item is done.");
			return json({ card: cardJson(card) });
		}
		if (action === "comments") {
			const commentBody = typeof body.body === "string" ? body.body.trim() : "";
			if (!commentBody) return refuse("A comment needs text.");
			card.comments.push({ id: `m${world.nextId++}`, author: YOU, body: commentBody.slice(0, 1000), date: world.today });
			return json({ card: cardJson(card) });
		}
		return text("Not found", { status: 404 });
	};

	const createCard = (board: Board, body: Record<string, unknown>): SiteResponse => {
		const title = oneLine(body.title);
		if (!isColumn(body.column)) return refuse("Choose a column.");
		if (!title) return refuse("A card needs a title.");
		if (title.length > MAX_TITLE) return refuse(`A title holds at most ${MAX_TITLE} characters.`);
		const numbers = world.cards.filter(card => card.boardId === board.id).map(card => card.number);
		const card: Card = {
			id: `c${world.nextId++}`,
			boardId: board.id,
			number: Math.max(100, ...numbers) + 1,
			title,
			column: body.column,
			labels: [],
			assignee: null,
			due: null,
			completed: body.column === "done" ? world.today : null,
			checklist: [],
			comments: [],
			archived: false,
			seeded: false,
		};
		world.cards.push(card);
		board.columns[card.column].push(card.id);
		return json({ card: cardJson(card) });
	};

	const route = (request: SiteRequest): SiteResponse => {
		const { method, url } = request;
		const pathname = url.pathname;
		if (pathname === "/" && method === "GET") return homePage();
		const boardMatch = /^\/b\/([a-z]+)(\/archived)?$/.exec(pathname);
		if (boardMatch && method === "GET") {
			const board = findBoard(world, boardMatch[1] as string);
			if (!board) return text("No such board", { status: 404 });
			return boardMatch[2] ? archivedPage(board) : boardPage(board, url);
		}
		const parsed = jsonBody(request);
		const body = (parsed !== null && typeof parsed === "object" ? parsed : {}) as Record<string, unknown>;
		const cardMatch = /^\/api\/cards\/(c\d+)(?:\/(.+))?$/.exec(pathname);
		if (cardMatch) {
			const card = findCard(world, cardMatch[1] as string);
			if (!card) return json({ error: "No such card." }, { status: 404 });
			if (method === "GET" && !cardMatch[2]) return json({ card: cardJson(card) });
			if (method === "POST") return cardAction(card, cardMatch[2] ?? "", body);
		}
		const createMatch = /^\/api\/boards\/([a-z]+)\/cards$/.exec(pathname);
		if (createMatch && method === "POST") {
			const board = findBoard(world, createMatch[1] as string);
			if (!board) return json({ error: "No such board." }, { status: 404 });
			return createCard(board, body);
		}
		return text("Not found", { status: 404 });
	};

	const site = await hostSite(route);
	return {
		origin: site.origin,
		close: () => site.close(),
		async finish() {
			await site.close();
			return { ...stateOf(world), moves, rejected };
		},
	};
}
