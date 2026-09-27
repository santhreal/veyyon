/**
 * WHY: a browser-suite application must refuse a request value that names nothing it has, and
 * record nothing for it. Three defects broke that. A request value looked up in a plain-object table
 * with `in` or `[]` also matched the members of `Object.prototype`: the shop put `size=constructor`
 * in the cart and placed an order at `shipping=toString` whose total was NaN, its sort control read
 * "Sort: undefined", and the mailbox printed a native function as a notice. A card's due date sent
 * as a number or a boolean was read as empty and cleared the date instead of being refused. A label
 * page whose name held a percent escape no decoder accepts (`/mail/label/%E0%A4%A`) threw, and the
 * mailbox answered 500 instead of its own "No such label".
 *
 * Each case sends every member of `Object.prototype`, as the runtime lists them, to an endpoint
 * that looks a request value up in a table, or a wrongly typed value to each field a card edit
 * takes, and asserts the refusal and that the page or card reads as it did before. The escape sweep
 * puts three broken escapes into every path segment, query value and form field each site of the
 * shop, the mailbox, the bank, its phone and the kanban board reads, and asserts no server error.
 *
 * Not caught: a table lookup on an endpoint this suite does not name, a wrongly typed field of a card
 * action other than the edit, and a route added later that the escape sweep does not list.
 */
import { describe, expect, it } from "bun:test";
import type { KitTrial } from "../../../engine/kit/catalog";
import { FormClient } from "../../../engine/kit/form-client";
import { BANK_TASKS } from "../../../suites/browser/apps/bank/tasks";
import { KANBAN_TASKS } from "../../../suites/browser/apps/kanban/tasks";
import { MAIL_TASKS } from "../../../suites/browser/apps/mail/tasks";
import { SHOP_TASKS } from "../../../suites/browser/apps/shop/tasks";
import { access, send, signInToBank, taskNamed, withTrial } from "./site-trial";

const PROTOTYPE_KEYS = Object.getOwnPropertyNames(Object.prototype);

describe("the shop", () => {
	const task = taskNamed(SHOP_TASKS, "shop-best-coupon");

	async function signedIn(trial: KitTrial<unknown>): Promise<FormClient> {
		const { origin, user, password } = access(trial);
		const client = new FormClient(origin);
		const response = await client.post("/signin", { email: user, password, next: "/cart" });
		if (!response.url.endsWith("/cart")) throw new Error(`signing in failed; it answered ${response.url}`);
		return client;
	}

	it("sorts by its default when the sort names no sort it offers", async () => {
		await withTrial(task, async trial => {
			const client = new FormClient(access(trial).origin);
			const mislabelled: string[] = [];
			for (const key of PROTOTYPE_KEYS) {
				const page = await client.get(`/search?sort=${encodeURIComponent(key)}`);
				if (!page.body.includes("Sort: Featured")) mislabelled.push(key);
			}
			expect(mislabelled).toEqual([]);
		});
	});

	it("refuses a size the product does not come in, and leaves the cart as it was", async () => {
		await withTrial(task, async trial => {
			const client = await signedIn(trial);
			const before = await client.get("/cart");
			const sku = /href="\/product\/(SK-[A-Z0-9]+)"/.exec(before.body)?.[1];
			if (!sku) throw new Error("the cart lists no product");
			const accepted: string[] = [];
			for (const key of PROTOTYPE_KEYS) {
				const response = await client.post("/cart/add", { sku, size: key, quantity: "1" });
				if (!response.body.includes("Choose a size.")) accepted.push(key);
			}
			expect(accepted).toEqual([]);
			expect((await client.get("/cart")).body).toBe(before.body);
		});
	});

	it("refuses a shipping speed it does not offer, and places no order", async () => {
		await withTrial(task, async trial => {
			const client = await signedIn(trial);
			const before = await client.get("/orders");
			const accepted: string[] = [];
			for (const key of PROTOTYPE_KEYS) {
				const response = await client.post("/checkout", { address: "saved", shipping: key });
				if (!response.body.includes("Choose a shipping speed.")) accepted.push(key);
			}
			expect(accepted).toEqual([]);
			expect((await client.get("/orders")).body).toBe(before.body);
		});
	});
});

describe("the mailbox", () => {
	it("shows no notice for a notice it does not have", async () => {
		await withTrial(taskNamed(MAIL_TASKS, "mail-create-filter-and-apply"), async trial => {
			const { origin, user, password } = access(trial);
			const client = new FormClient(origin);
			const signin = await client.post("/signin", { email: user, password, next: "/mail/inbox" });
			if (!signin.url.endsWith("/mail/inbox")) throw new Error(`signing in failed; it answered ${signin.url}`);
			// A notice the mailbox has is shown, so the check below can see one.
			expect((await client.get("/mail/inbox?notice=sent")).body).toContain(
				'<p class="notice">Your message was sent.</p>',
			);
			const shown: string[] = [];
			for (const key of PROTOTYPE_KEYS) {
				const page = await client.get(`/mail/inbox?notice=${encodeURIComponent(key)}`);
				if (page.body.includes('<p class="notice">')) shown.push(key);
			}
			expect(shown).toEqual([]);
		});
	});
});

describe("the kanban board", () => {
	it("refuses a card edit whose field has the wrong type, and leaves the card as it was", async () => {
		await withTrial(taskNamed(KANBAN_TASKS, "kanban-sort-by-due-date"), async trial => {
			const client = new FormClient(access(trial).origin);
			const board = await client.get("/b/mobile");
			let id = "";
			let before = "";
			// A card with a due date, an assignee and a title, so clearing any of them would show.
			for (const [, candidate] of board.body.matchAll(/data-card="(c\d+)"/g)) {
				const card = await client.get(`/api/cards/${candidate}`);
				if (card.body.includes('"due":"') && card.body.includes('"assignee":"')) {
					id = candidate ?? "";
					before = card.body;
					break;
				}
			}
			if (!id) throw new Error("the board has no card with a due date and an assignee");
			const accepted: string[] = [];
			for (const field of ["title", "assignee", "due"]) {
				for (const value of [0, 7, true, false, {}, [], ["3/9/2027"]]) {
					const response = await client.postJson(`/api/cards/${id}`, { [field]: value });
					const after = await client.get(`/api/cards/${id}`);
					if (response.status !== 400 || after.body !== before) accepted.push(`${field}=${JSON.stringify(value)}`);
				}
			}
			expect(accepted).toEqual([]);
		});
	});
});

/** Escapes no decoder accepts: a truncated UTF-8 sequence, a bare `%`, and a `%` before letters. */
const BROKEN_ESCAPES = ["%E0%A4%A", "%", "%ZZ"];

/** A path to GET, or a path and a urlencoded body to POST, each `{x}` standing for a broken escape. */
type Probe = string | readonly [string, string];

/** The probes that answered a server error, with each broken escape in turn. */
async function serverErrors(origin: string, cookie: string, probes: readonly Probe[]): Promise<string[]> {
	const failed: string[] = [];
	for (const broken of BROKEN_ESCAPES) {
		for (const probe of probes) {
			const [path, form] = typeof probe === "string" ? [probe, undefined] : probe;
			const response = await send(origin, path.replaceAll("{x}", broken), {
				cookie,
				form: form?.replaceAll("{x}", broken),
			});
			if (response.status >= 500) {
				failed.push(`${form === undefined ? "GET" : "POST"} ${path} with ${broken}: ${response.status}`);
			}
		}
	}
	return failed;
}

describe("a malformed percent escape", () => {
	it("is answered by the shop without a server error", async () => {
		await withTrial(taskNamed(SHOP_TASKS, "shop-best-coupon"), async trial => {
			const { origin, user, password } = access(trial);
			const { cookie } = await send(origin, "/signin", { form: { email: user, password, next: "/account" } });
			const probes: Probe[] = [
				"/{x}",
				"/product/{x}",
				"/orders/{x}",
				"/orders/{x}/return",
				"/account/messages/{x}",
				"/search?q={x}&category={x}&min={x}&max={x}&rating={x}&sort={x}&page={x}",
				"/signin?next={x}",
				["/cart/add", "sku={x}&size={x}&quantity={x}"],
				["/cart/update", "index={x}&quantity={x}"],
				["/cart/coupon", "code={x}"],
				["/checkout", "address=new&name={x}&street={x}&city={x}&postalCode={x}&shipping={x}"],
				["/signin", "email={x}&password={x}&next={x}"],
			];
			expect(await serverErrors(origin, cookie, probes)).toEqual([]);
		});
	});

	it("is answered by the mailbox without a server error, and a label it cannot decode is its own not-found", async () => {
		await withTrial(taskNamed(MAIL_TASKS, "mail-create-filter-and-apply"), async trial => {
			const { origin, user, password } = access(trial);
			const { cookie } = await send(origin, "/signin", { form: { email: user, password, next: "/mail/inbox" } });
			const label = await send(origin, "/mail/label/%E0%A4%A", { cookie });
			expect([label.status, label.body]).toEqual([404, "No such label"]);
			const probes: Probe[] = [
				"/{x}",
				"/mail/label/{x}",
				"/message/{x}",
				"/compose?mode={x}&id={x}",
				"/compose?mode=reply&id={x}",
				"/mail/search?q={x}",
				"/mail/inbox?notice={x}&q={x}",
				"/api/list?view={x}&q={x}&offset={x}&limit={x}",
				"/api/ids?view={x}&q={x}",
				"/api/contacts?q={x}",
				"/settings/filters?created={x}",
				"/signin?next={x}",
				["/compose/send", "mode={x}&source={x}&to={x}&cc={x}&subject={x}&body={x}&attachments={x}"],
				["/settings/filters", "match={x}&field0={x}&value0={x}&label={x}&newLabel={x}"],
				["/api/filters/preview", "field0={x}&value0={x}"],
				["/labels", "name={x}&back={x}"],
				["/labels/delete", "name={x}"],
			];
			expect(await serverErrors(origin, cookie, probes)).toEqual([]);
		});
	});

	it("is answered by the bank and its phone without a server error", async () => {
		await withTrial(taskNamed(BANK_TASKS, "bank-alert-settings"), async trial => {
			const { origin } = access(trial);
			const { cookie } = await signInToBank(trial, "/");
			const probes: Probe[] = [
				"/{x}",
				"/transactions/{x}",
				"/transactions/{x}/dispute",
				"/transfer/done/{x}",
				"/pay/done/{x}",
				"/pay?bill={x}",
				"/payees?added={x}",
				"/activity?account={x}&from={x}&to={x}&category={x}&status={x}&q={x}&page={x}",
				"/activity.csv?q={x}&category={x}",
				"/signin?next={x}",
				["/transfer", "from={x}&to={x}&amount={x}&memo={x}"],
				["/pay", "bill={x}&from={x}&payee={x}&amount={x}&memo={x}"],
				["/api/alerts/marketing", "email={x}&text={x}"],
			];
			expect(await serverErrors(origin, cookie, probes)).toEqual([]);
			const phone = /Messages app is at (http:\/\/127\.0\.0\.1:\d+)/.exec(trial.instruction)?.[1] ?? "";
			expect(await serverErrors(phone, "", ["/{x}", "/c/{x}", "/api/conversations/{x}"])).toEqual([]);
		});
	});

	it("is answered by the kanban board without a server error", async () => {
		await withTrial(taskNamed(KANBAN_TASKS, "kanban-sort-by-due-date"), async trial => {
			const probes: Probe[] = [
				"/{x}",
				"/b/{x}",
				"/b/{x}/archived",
				"/b/platform?label={x}&member={x}&q={x}",
				"/api/cards/{x}",
				["/api/cards/c1/{x}", "title={x}"],
				["/api/boards/{x}/cards", "title={x}"],
			];
			expect(await serverErrors(access(trial).origin, "", probes)).toEqual([]);
		});
	});
});
