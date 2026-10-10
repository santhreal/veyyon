/**
 * A workflow across Northwind Bank and Gridwork: the debit card purchases expected in a month,
 * listed in a workbook, reconciled against what the bank's checking account shows for that month.
 * A row's status comes from the bank (posted or still pending); the charge that went through twice
 * is disputed at the bank, and only the list tells it from a purchase at another merchant for the
 * same amount; the purchase no row expects is added to the list from the bank; and the reply totals
 * the rows the bank has posted.
 *
 * The bank's month is rebuilt around the list: its generated card purchases give way to planted
 * ones beside the subscriptions it already bills, so every card purchase of the month is a row, the
 * duplicate, the unexpected purchase, or a decoy a check names: the purchase still pending, a refund
 * of an earlier purchase, a purchase at another merchant for the duplicated amount, and a purchase
 * dated the day after the month.
 */

import { setTimeout as sleep } from "node:timers/promises";
import { type KitTask, kitTask } from "../../../../engine/kit/catalog";
import { answerStatesOnly, type Check, normalizeText } from "../../../../engine/kit/checks";
import { FormClient, type FormResponse } from "../../../../engine/kit/form-client";
import { Seeded, seedOf } from "../../../../engine/kit/seeded";
import {
	addCardCharge,
	addDays,
	addTransaction,
	availableBalance,
	BANK_SENDER,
	type BankWorld,
	CARD_MERCHANTS,
	chargeCents,
	DISPUTE_REASONS,
	daysBetween,
	duplicateCharges,
	generateBank,
	KIND_LABELS,
	lastDayOf,
	longDate,
	type MerchantSpec,
	monthLabel,
	PENDING_DAYS,
	previousMonth,
	separateDuplicates,
	setAvailable,
	sortTransactions,
	type Transaction,
	usd,
} from "../bank/data";
import { type PhoneThread, threadSlug } from "../bank/phone";
import { type BankSite, type BankSnapshot, startBankSite } from "../bank/site";
import { type GridWorld, newWorkbook, sheetFrom, type Workbook, worldOf } from "../sheet/data";
import { type GridSnapshot, type SheetState, startSheetSite } from "../sheet/site";

/** The list's sheet. */
const SHEET = "Expected";
const HEADERS = ["Merchant", "Date", "Amount", "Status"];
const DUPLICATE_REASON = DISPUTE_REASONS[0];
/** Worlds drawn for one seed before the planner gives up. */
const PLAN_ATTEMPTS = 20;

/** Every workbook's raw inputs, by workbook id, then sheet name, then address. */
type Inputs = Readonly<Record<string, Readonly<Record<string, Readonly<Record<string, string>>>>>>;

interface BookCells {
	readonly id: string;
	readonly sheets: readonly { readonly name: string; readonly cells: Readonly<Record<string, string>> }[];
}

interface Purchase {
	readonly transactionId: string;
	readonly merchant: string;
	/** `YYYY-MM-DD`. */
	readonly date: string;
	/** Positive: what was charged. */
	readonly cents: number;
}

interface ListRow extends Purchase {
	/** The sheet row, 2 for the first purchase. */
	readonly row: number;
	/** False while the bank lists the purchase as pending. */
	readonly posted: boolean;
}

interface Reconcile {
	/** `YYYY-MM`. */
	readonly month: string;
	readonly bookName: string;
	/** The workbook's id. */
	readonly book: string;
	readonly rows: readonly ListRow[];
	/** The list's last row; the unexpected purchase goes in the row after it. */
	readonly lastRow: number;
	/** The later charge of the purchase that went through twice: the one to dispute. */
	readonly duplicateId: string;
	/** The listed purchase it repeats. */
	readonly originalId: string;
	/** A listed purchase at another merchant for the duplicated amount, within the same two days. */
	readonly sameAmountId: string;
	/** The posted purchase no row expects, at a listed merchant a day or two from its row. */
	readonly unexpected: Purchase;
	/** A refund, dated in the month, of a purchase the month before at a listed merchant. */
	readonly refund: Purchase;
	/** A purchase at a merchant the list does not name, dated the day after the month. */
	readonly afterMonth: Purchase;
	/** The listed purchases that posted. */
	readonly totalCents: number;
	/**
	 * Totals a miscounting run arrives at: the pending, duplicate, unexpected or after-month purchase
	 * counted, the refund or the same-amount purchase taken off, alone and together.
	 */
	readonly miscountCents: readonly number[];
	readonly before: Inputs;
}

interface ReconcileState {
	readonly bank: BankSnapshot;
	readonly grid: GridSnapshot;
	readonly expected: Reconcile;
}

function purchaseOf(entry: Transaction): Purchase {
	return { transactionId: entry.id, merchant: entry.description, date: entry.date, cents: -entry.amountCents };
}

function inputsOf(workbooks: readonly BookCells[]): Inputs {
	return Object.fromEntries(
		workbooks.map(book => [book.id, Object.fromEntries(book.sheets.map(sheet => [sheet.name, { ...sheet.cells }]))]),
	);
}

/** Every cell of every workbook whose raw input differs between the two, as `book/sheet!cell`. */
function changedCells(before: Inputs, after: Inputs): string[] {
	const changed: string[] = [];
	for (const id of new Set([...Object.keys(before), ...Object.keys(after)])) {
		const was = before[id] ?? {};
		const now = after[id] ?? {};
		for (const sheet of new Set([...Object.keys(was), ...Object.keys(now)])) {
			const x = was[sheet] ?? {};
			const y = now[sheet] ?? {};
			for (const cell of new Set([...Object.keys(x), ...Object.keys(y)])) {
				if (x[cell] !== y[cell]) changed.push(`${id}/${sheet}!${cell}`);
			}
		}
	}
	return changed;
}

const MONTH_PREFIXES = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];

/** The `YYYY-MM-DD` a typed date states: `2025-05-14`, `5/14/2025`, `May 14, 2025`; null for anything else. */
function typedDate(raw: string): string | null {
	const text = raw.trim();
	let parts: [number, number, number] | null = null;
	const iso = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(text);
	const slashed = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(text);
	const named = /^([a-z]{3})[a-z]*\.?\s+(\d{1,2}),?\s+(\d{4})$/i.exec(text);
	if (iso) parts = [Number(iso[1]), Number(iso[2]), Number(iso[3])];
	else if (slashed) parts = [Number(slashed[3]), Number(slashed[1]), Number(slashed[2])];
	else if (named) {
		const month = MONTH_PREFIXES.indexOf((named[1] as string).toLowerCase()) + 1;
		if (month > 0) parts = [Number(named[3]), month, Number(named[2])];
	}
	if (!parts) return null;
	const [year, month, day] = parts;
	if (month < 1 || month > 12 || day < 1 || day > 31) return null;
	return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

/** The rows of a CSV body, a quoted field's doubled quotes undone. */
function csvRows(body: string): string[][] {
	return body
		.split(/\r?\n/)
		.filter(line => line !== "")
		.map(line =>
			[...line.matchAll(/(?:^|,)(?:"((?:[^"]|"")*)"|([^,]*))/g)].map(
				match => match[1]?.replaceAll('""', '"') ?? match[2] ?? "",
			),
		);
}

// ---------------------------------------------------------------------------------------------
// The plan

interface MonthPlan {
	readonly month: string;
	/** The purchases the list expects, in its order: by date, then merchant. */
	readonly listed: readonly Transaction[];
	readonly original: Transaction;
	readonly duplicate: Transaction;
	readonly sameAmount: Transaction;
	readonly unexpected: Transaction;
	readonly refund: Transaction;
	readonly afterMonth: Transaction;
	readonly totalCents: number;
	readonly miscountCents: readonly number[];
}

/**
 * Rebuild the card purchases of the month before the bank's today on checking, or null when the
 * draw leaves a fact ambiguous: a second repeated purchase touching the month, or another pending
 * row.
 */
function bendMonth(world: BankWorld, rng: Seeded): MonthPlan | null {
	const month = previousMonth(world.today);
	const first = `${month}-01`;
	const last = lastDayOf(month);
	const settled = addDays(world.today, -(PENDING_DAYS + 1));
	const postedEnd = settled < last ? settled : last;
	const pendingFrom = addDays(world.today, -PENDING_DAYS);
	const inMonth = (entry: Transaction) => entry.date.startsWith(`${month}-`);
	const monthCard = (entry: Transaction) => entry.account === "checking" && entry.kind === "card" && inMonth(entry);
	const available = availableBalance(world, "checking");

	// The month's generated purchases give way; the subscriptions it bills stay on the list.
	for (let i = world.transactions.length - 1; i >= 0; i--) {
		const entry = world.transactions[i] as Transaction;
		if (monthCard(entry) && entry.category !== "Subscriptions") world.transactions.splice(i, 1);
	}
	const subscriptions = world.transactions.filter(monthCard);
	const keep = new Set(subscriptions.map(entry => entry.id));
	const used = new Set(subscriptions.map(entry => -entry.amountCents));
	const fresh = (merchant: MerchantSpec) => {
		for (;;) {
			const cents = chargeCents(rng, merchant);
			if (!used.has(cents)) {
				used.add(cents);
				return cents;
			}
		}
	};
	const day = (from: string, to: string) => addDays(from, rng.int(0, daysBetween(from, to)));
	const plant = (merchant: MerchantSpec, date: string, cents: number) => {
		const charge = addCardCharge(world, rng, merchant, date, cents);
		keep.add(charge.id);
		return charge;
	};

	const pool = rng.shuffle(CARD_MERCHANTS.filter(merchant => merchant.category !== "Travel"));
	const [doubledAt, sameAmountAt, unexpectedAt, pendingAt, refundedAt, afterAt, ...rest] = pool as [
		MerchantSpec,
		MerchantSpec,
		MerchantSpec,
		MerchantSpec,
		MerchantSpec,
		MerchantSpec,
		...MerchantSpec[],
	];

	// One purchase charged again a day or two later, and another merchant's purchase for the same
	// amount within those days.
	const originalDate = day(first, addDays(postedEnd, -2));
	const gap = rng.int(1, 2);
	const doubledCents = fresh(doubledAt);
	const original = plant(doubledAt, originalDate, doubledCents);
	const duplicate = plant(doubledAt, addDays(originalDate, gap), doubledCents);
	const sameAmount = plant(sameAmountAt, addDays(originalDate, rng.int(0, gap)), doubledCents);

	// The purchase no row expects: at a listed merchant, a day or two from that merchant's row.
	const neighbourDate = day(addDays(first, 2), addDays(postedEnd, -2));
	plant(unexpectedAt, neighbourDate, fresh(unexpectedAt));
	const unexpected = plant(unexpectedAt, addDays(neighbourDate, rng.pick([-2, -1, 1, 2])), fresh(unexpectedAt));

	// A listed purchase the bank has not posted yet.
	plant(pendingAt, day(pendingFrom > first ? pendingFrom : first, last), fresh(pendingAt));

	// A refund, in the month, of a purchase the month before at a listed merchant.
	plant(refundedAt, day(first, postedEnd), fresh(refundedAt));
	const refundedCents = fresh(refundedAt);
	plant(refundedAt, addDays(first, -rng.int(3, 20)), refundedCents);
	const refund = addTransaction(world, rng, {
		account: "checking",
		date: day(first, postedEnd),
		description: `Refund · ${refundedAt.name}`,
		category: refundedAt.category,
		amountCents: refundedCents,
		kind: "refund",
	});

	// A merchant the list does not name, charged the day after the month.
	const afterMonth = plant(afterAt, addDays(last, 1), fresh(afterAt));

	// The rest of the month's purchases, one merchant twice.
	const extras = rest.slice(0, rng.int(3, 5));
	for (const merchant of [...extras, rng.pick(extras)]) plant(merchant, day(first, postedEnd), fresh(merchant));

	separateDuplicates(world, rng, keep);
	sortTransactions(world);
	setAvailable(world, "checking", available);

	const listed = world.transactions
		.filter(entry => monthCard(entry) && entry.id !== duplicate.id && entry.id !== unexpected.id)
		.sort(
			(a, b) =>
				a.date.localeCompare(b.date) || a.description.localeCompare(b.description) || b.amountCents - a.amountCents,
		);
	const pendingRows = listed.filter(entry => entry.status === "pending");
	if (
		pendingRows.length !== 1 ||
		[original, duplicate, sameAmount, unexpected].some(entry => entry.status !== "posted")
	) {
		return null;
	}
	const repeats = duplicateCharges(world.transactions).filter(pair => inMonth(pair.first) || inMonth(pair.second));
	if (repeats.length !== 1 || repeats[0]?.first.id !== original.id || repeats[0]?.second.id !== duplicate.id) {
		return null;
	}

	const totalCents = listed.reduce((sum, entry) => (entry.status === "posted" ? sum - entry.amountCents : sum), 0);
	const slips = [
		-(pendingRows[0] as Transaction).amountCents,
		-duplicate.amountCents,
		-unexpected.amountCents,
		-afterMonth.amountCents,
		-refund.amountCents,
		sameAmount.amountCents,
	];
	// An answer may name the month's year, which reads as that many whole dollars; and a miscount
	// whose slips cancel (the duplicate counted, the same-amount purchase dropped) lands on the total.
	const yearCents = Number(month.slice(0, 4)) * 100;
	const miscountCents: number[] = [];
	for (let mask = 1; mask < 1 << slips.length; mask++) {
		const cents = slips.reduce((sum, slip, bit) => (mask & (1 << bit) ? sum + slip : sum), totalCents);
		if (Math.abs(cents) !== totalCents && cents !== yearCents) miscountCents.push(cents);
	}
	return { month, listed, original, duplicate, sameAmount, unexpected, refund, afterMonth, totalCents, miscountCents };
}

interface Planned {
	readonly bank: BankWorld;
	readonly bankSeed: number;
	readonly grid: GridWorld;
	readonly book: Workbook;
	readonly plan: Reconcile;
}

/** Each application's world from a stream of its own, drawn again until the month bends. */
function planTrial(seed: number): Planned {
	for (let attempt = 0; attempt < PLAN_ATTEMPTS; attempt++) {
		const bankSeed = seedOf(`${seed}:bank:${attempt}`);
		const bank = generateBank(new Seeded(bankSeed));
		const bent = bendMonth(bank, new Seeded(seedOf(`${seed}:plan:${attempt}`)));
		if (!bent) continue;
		const sheetRng = new Seeded(seedOf(`${seed}:sheet:${attempt}`));
		const bookName = `Card Purchases ${monthLabel(bent.month)}`;
		const sheet = sheetFrom(SHEET, [
			HEADERS,
			...bent.listed.map(entry => [entry.description, entry.date, (-entry.amountCents / 100).toFixed(2), ""]),
		]);
		const book = newWorkbook(sheetRng, bookName, [sheet], bank.customer.name);
		const grid: GridWorld = { ...worldOf(sheetRng, [book]), user: bank.customer.name };
		const rows = bent.listed.map(
			(entry, index): ListRow => ({ ...purchaseOf(entry), row: index + 2, posted: entry.status === "posted" }),
		);
		return {
			bank,
			bankSeed,
			grid,
			book,
			plan: {
				month: bent.month,
				bookName,
				book: book.id,
				rows,
				lastRow: rows.length + 1,
				duplicateId: bent.duplicate.id,
				originalId: bent.original.id,
				sameAmountId: bent.sameAmount.id,
				unexpected: purchaseOf(bent.unexpected),
				refund: { ...purchaseOf(bent.refund), cents: bent.refund.amountCents },
				afterMonth: purchaseOf(bent.afterMonth),
				totalCents: bent.totalCents,
				miscountCents: bent.miscountCents,
				before: inputsOf(grid.workbooks),
			},
		};
	}
	throw new Error(`no world of seed ${seed} bent into an unambiguous month in ${PLAN_ATTEMPTS} draws`);
}

// ---------------------------------------------------------------------------------------------
// The scripted solution

/** Throw unless the response came from a URL (path and query) that starts with `prefix`. */
function landedOn(response: FormResponse, prefix: string): FormResponse {
	const url = new URL(response.url);
	if (!`${url.pathname}${url.search}`.startsWith(prefix)) {
		throw new Error(`expected to land on ${prefix}, the site answered ${response.url}`);
	}
	return response;
}

/** Sign in as a person does: the password, then the code the phone receives after it. */
async function signIn(site: BankSite, world: BankWorld): Promise<FormClient> {
	const phone = new FormClient(site.phoneOrigin);
	const thread = async () =>
		JSON.parse((await phone.get(`/api/conversations/${threadSlug(BANK_SENDER)}`)).body) as PhoneThread;
	const seen = (await thread()).messages.at(-1)?.id ?? 0;
	const client = new FormClient(site.origin);
	landedOn(
		await client.post("/signin", { username: world.customer.username, password: world.customer.password }),
		"/signin/verify",
	);
	const deadline = Date.now() + 15_000;
	for (;;) {
		const fresh = (await thread()).messages.filter(message => message.id > seen).at(-1);
		const code = fresh ? /\b(\d{6})\b/.exec(fresh.body)?.[1] : undefined;
		if (code) {
			const verified = await client.post("/signin/verify", { code });
			if (new URL(verified.url).pathname !== "/") throw new Error(`the code was refused: ${verified.url}`);
			return client;
		}
		if (Date.now() > deadline) throw new Error("no sign-in code reached the phone");
		await sleep(200);
	}
}

interface ActivityRow {
	readonly id: string;
	readonly date: string;
	readonly description: string;
	readonly posted: boolean;
	/** Negative for money out. */
	readonly cents: number;
}

/** Checking's transactions dated in the month, from the activity CSV. */
async function checkingActivity(client: FormClient, month: string): Promise<ActivityRow[]> {
	const query = new URLSearchParams({ account: "checking", from: `${month}-01`, to: lastDayOf(month) });
	const [, ...lines] = csvRows((await client.get(`/activity.csv?${query}`)).body);
	// Date, Description, Category, Account, Status, Amount, Transaction ID.
	return lines.map(cells => ({
		id: cells[6] ?? "",
		date: cells[0] ?? "",
		description: cells[1] ?? "",
		posted: cells[4] === "Posted",
		cents: Math.round(Number(cells[5]) * 100),
	}));
}

async function postOk(client: FormClient, path: string, body: unknown): Promise<void> {
	const response = await client.postJson(path, body);
	if (response.status !== 200) throw new Error(`${path} answered ${response.status}: ${response.body}`);
}

// ---------------------------------------------------------------------------------------------
// Checks

function listSheet(state: ReconcileState): SheetState | undefined {
	return state.grid.workbooks
		.find(book => book.id === state.expected.book)
		?.sheets.find(sheet => sheet.name === SHEET);
}

function statusOf(sheet: SheetState | undefined, row: number): string {
	return normalizeText(sheet?.cells[`D${row}`] ?? "");
}

const BANK_OTHERWISE_UNCHANGED: Check<ReconcileState> = {
	id: "bank-otherwise-unchanged",
	description: "moved no money, added no payee and changed no alert",
	pass: ({ bank }) =>
		bank.payments.length === 0 &&
		bank.transfers.length === 0 &&
		bank.payees.every(payee => payee.seeded) &&
		bank.initialAlerts.every(initial => {
			const alert = bank.alerts.find(entry => entry.key === initial.key);
			return (
				alert !== undefined &&
				alert.thresholdCents === initial.thresholdCents &&
				alert.email === initial.email &&
				alert.text === initial.text
			);
		}),
};

export const reconcileAndDisputeTask: KitTask = kitTask<ReconcileState>({
	id: "workflow-reconcile-and-dispute",
	title: "Reconcile a month's card purchases in a workbook against the bank and dispute the double charge",
	capabilities: ["workflow", "auth", "multi-tab", "search-filter", "reasoning", "forms", "inline-edit", "multi-page"],
	difficulty: "expert",
	timeBudgetSec: 1200,
	async start({ seed }) {
		const { bank, bankSeed, grid, book, plan } = planTrial(seed);
		const bankSite = await startBankSite(bank, bankSeed);
		const gridSite = await startSheetSite(grid).catch(async (error: unknown) => {
			await bankSite.close();
			throw error;
		});
		const month = monthLabel(plan.month);
		return {
			instruction: [
				`Gridwork, a spreadsheet application, is at ${gridSite.origin}. Its workbook "${plan.bookName}" lists on the ${SHEET} sheet the debit card purchases you expected on your checking account in ${month}, with an empty Status column.`,
				`Northwind Bank's online banking is at ${bankSite.origin}. Sign in with username ${bank.customer.username} and password ${bank.customer.password}.`,
				`After the password, the bank texts a one-time code to your phone; your phone's Messages app is at ${bankSite.phoneOrigin}.`,
				`The bank's date today is ${longDate(bank.today)}.`,
				`Reconcile the list with the debit card purchases your checking account shows dated in ${month}. A purchase belongs to a row when its merchant, date and amount all agree with the row.`,
				"Set each row's Status to Matched when its purchase has posted, or to Pending when the bank still lists it as pending.",
				`One purchase on the list went through twice: the same merchant charged the same amount again one or two days later. Dispute that later charge at the bank with the reason "${DUPLICATE_REASON}", and add no row for it.`,
				`One other posted purchase dated in ${month} is on no row. Add it in the first empty row below the list, with its merchant, date and amount written as the rows above write them, and the Status Unexpected.`,
				"A refund is not a purchase. Change nothing else in the workbook or at the bank.",
				"Reply with the total, in dollars and cents, of the rows you marked Matched, and state no other total.",
			].join("\n"),
			solve: async () => {
				const client = await signIn(bankSite, bank);
				const sheetClient = new FormClient(gridSite.origin);
				const [, ...listLines] = csvRows(
					(await sheetClient.get(`/wb/${book.id}/export.csv?sheet=${encodeURIComponent(SHEET)}`)).body,
				);
				const list = listLines.map(cells => ({
					merchant: cells[0] ?? "",
					date: cells[1] ?? "",
					cents: Math.round(Number(cells[2]) * 100),
				}));
				const purchases: ActivityRow[] = [];
				for (const row of await checkingActivity(client, plan.month)) {
					if (row.cents >= 0) continue;
					if ((await client.get(`/transactions/${row.id}`)).body.includes(KIND_LABELS.card)) purchases.push(row);
				}
				const owned = list.map(entry => {
					const found = purchases.filter(
						row => row.description === entry.merchant && row.date === entry.date && -row.cents === entry.cents,
					);
					if (found.length !== 1)
						throw new Error(`${found.length} purchases belong to ${entry.merchant} on ${entry.date}`);
					return found[0] as ActivityRow;
				});
				const unlisted = purchases.filter(row => row.posted && !owned.includes(row));
				const repeats = unlisted.filter(row =>
					owned.some(
						mine =>
							mine.description === row.description &&
							mine.cents === row.cents &&
							daysBetween(mine.date, row.date) >= 1 &&
							daysBetween(mine.date, row.date) <= 2,
					),
				);
				const others = unlisted.filter(row => !repeats.includes(row));
				const duplicate = repeats[0];
				const extra = others[0];
				if (repeats.length !== 1 || duplicate?.id !== plan.duplicateId) {
					throw new Error(
						`the bank shows repeats ${repeats.map(row => row.id).join(", ")}, the plan ${plan.duplicateId}`,
					);
				}
				if (others.length !== 1 || extra?.id !== plan.unexpected.transactionId) {
					throw new Error(
						`the bank shows unlisted ${others.map(row => row.id).join(", ")}, the plan ${plan.unexpected.transactionId}`,
					);
				}
				landedOn(
					await client.post(`/transactions/${duplicate.id}/dispute`, {
						reason: DUPLICATE_REASON,
						details: "The same purchase was charged a second time.",
						certify: "yes",
					}),
					`/transactions/${duplicate.id}`,
				);
				const next = list.length + 2;
				await postOk(sheetClient, `/api/wb/${book.id}/cells`, {
					sheet: SHEET,
					edits: [
						...owned.map((row, index) => ({ cell: `D${index + 2}`, raw: row.posted ? "Matched" : "Pending" })),
						{ cell: `A${next}`, raw: extra.description },
						{ cell: `B${next}`, raw: extra.date },
						{ cell: `C${next}`, raw: (-extra.cents / 100).toFixed(2) },
						{ cell: `D${next}`, raw: "Unexpected" },
					],
				});
				const total = owned.reduce((sum, row) => (row.posted ? sum - row.cents : sum), 0);
				if (total !== plan.totalCents)
					throw new Error(`the matched rows total ${total}, the plan ${plan.totalCents}`);
				return `The rows marked Matched total ${usd(total)}.`;
			},
			finish: async () => {
				const [bankState, gridState] = await Promise.all([bankSite.finish(), gridSite.finish()]);
				return { bank: bankState, grid: gridState, expected: plan };
			},
		};
	},
	checks: [
		{
			id: "disputed-the-duplicate",
			description: `disputed the later charge of the purchase that went through twice, as ${DUPLICATE_REASON}`,
			pass: state =>
				state.bank.disputes.some(
					dispute => dispute.transactionId === state.expected.duplicateId && dispute.reason === DUPLICATE_REASON,
				),
		},
		{
			id: "nothing-else-disputed",
			description:
				"disputed no other charge: not the original, the same-amount purchase, the unexpected one or the refund",
			pass: state => state.bank.disputes.every(dispute => dispute.transactionId === state.expected.duplicateId),
		},
		BANK_OTHERWISE_UNCHANGED,
		{
			id: "posted-rows-matched",
			description: "every row whose purchase posted says Matched",
			pass: state => {
				const sheet = listSheet(state);
				return state.expected.rows.filter(row => row.posted).every(row => statusOf(sheet, row.row) === "matched");
			},
		},
		{
			id: "pending-row-pending",
			description: "the row whose purchase is still pending says Pending, not Matched",
			pass: state => {
				const sheet = listSheet(state);
				const pending = state.expected.rows.filter(row => !row.posted);
				return pending.length > 0 && pending.every(row => statusOf(sheet, row.row) === "pending");
			},
		},
		{
			id: "unexpected-row-added",
			description:
				"the first row below the list holds the unexpected purchase's merchant, date and amount, Status Unexpected",
			pass: state => {
				const sheet = listSheet(state);
				const row = state.expected.lastRow + 1;
				const { merchant, date, cents } = state.expected.unexpected;
				const amount = sheet?.values[`C${row}`];
				return (
					sheet !== undefined &&
					normalizeText(sheet.cells[`A${row}`] ?? "") === normalizeText(merchant) &&
					typedDate(sheet.cells[`B${row}`] ?? "") === date &&
					typeof amount === "number" &&
					Math.abs(Math.abs(amount) * 100 - cents) < 0.5 &&
					statusOf(sheet, row) === "unexpected"
				);
			},
		},
		{
			id: "nothing-else-changed",
			description:
				"changed only the list's Status cells and the one new row: no row for the duplicate, the refund, the pending or the after-month purchase",
			pass: state => {
				const { book, lastRow, before } = state.expected;
				const allowed = new Set<string>();
				for (let row = 2; row <= lastRow; row++) allowed.add(`${book}/${SHEET}!D${row}`);
				for (const column of ["A", "B", "C", "D"]) allowed.add(`${book}/${SHEET}!${column}${lastRow + 1}`);
				return changedCells(before, inputsOf(state.grid.workbooks)).every(key => allowed.has(key));
			},
		},
		{
			id: "answer-total",
			description: "states the total of the rows marked Matched, the listed purchases that posted, and no miscounted total",
			pass: (state, answer) =>
				answerStatesOnly(
					answer,
					state.expected.totalCents / 100,
					state.expected.miscountCents.map(cents => cents / 100),
					undefined,
					"either",
				),
		},
	],
});
