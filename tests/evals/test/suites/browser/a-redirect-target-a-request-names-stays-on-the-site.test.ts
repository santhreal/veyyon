/**
 * WHY: a sign-in form carries the page to land on as `next`, and the mailbox's new-label form the
 * page to return to as `back`. The shop and the mailbox redirected to any value that started with
 * "/", so `next=//evil.test/x` sent a signed-in session to another host; the bank refused `//` but
 * not `/\`, which a browser reads the same way, nor a tab inside `//`, which a browser drops. All
 * three now resolve the target with the kit's `localPath`.
 *
 * Each case sends every foreign target to every form of the shop, the mailbox and the bank that
 * redirects to a target the request names, and asserts that the redirect resolves to the site's own
 * origin, and that a local target is kept.
 *
 * Not caught: a redirect built from a request value other than through these forms.
 */
import { describe, expect, it } from "bun:test";
import { BANK_TASKS } from "../../../suites/browser/apps/bank/tasks";
import { MAIL_TASKS } from "../../../suites/browser/apps/mail/tasks";
import { SHOP_TASKS } from "../../../suites/browser/apps/shop/tasks";
import { access, send, signInToBank, taskNamed, withTrial } from "./site-trial";

const FOREIGN = ["//evil.test/x", "https://evil.test/x", "/\\evil.test/x", "/\t/evil.test/x"];

/** The targets whose redirect left `origin`, each with where it went. */
async function offsite(origin: string, redirectFor: (target: string) => Promise<string>): Promise<string[]> {
	const left: string[] = [];
	for (const target of FOREIGN) {
		const location = await redirectFor(target);
		if (!location || new URL(location, origin).origin !== origin)
			left.push(`${JSON.stringify(target)} -> ${location}`);
	}
	return left;
}

describe("a redirect a request names", () => {
	it("keeps the shop's sign-in on the shop", async () => {
		await withTrial(taskNamed(SHOP_TASKS, "shop-best-coupon"), async trial => {
			const { origin, user, password } = access(trial);
			const signIn = async (next: string) =>
				(await send(origin, "/signin", { form: { email: user, password, next } })).location;
			expect(await signIn("/cart")).toBe("/cart");
			expect(await offsite(origin, signIn)).toEqual([]);
		});
	});

	it("keeps the mailbox's sign-in and its new-label form on the mailbox", async () => {
		await withTrial(taskNamed(MAIL_TASKS, "mail-create-filter-and-apply"), async trial => {
			const { origin, user, password } = access(trial);
			const signIn = async (next: string) => send(origin, "/signin", { form: { email: user, password, next } });
			expect((await signIn("/mail/archive")).location).toBe("/mail/archive");
			expect(await offsite(origin, async next => (await signIn(next)).location)).toEqual([]);
			const { cookie } = await signIn("/mail/inbox");
			// An existing label, so the form changes nothing before it redirects.
			const back = async (target: string) =>
				(await send(origin, "/labels", { form: { name: "Receipts", back: target }, cookie })).location;
			expect(await back("/settings/labels")).toBe("/settings/labels");
			expect(await offsite(origin, back)).toEqual([]);
		});
	});

	// Five sign-ins, each waiting the bank's 2 s for its code to reach the phone.
	it("keeps the bank's sign-in on the bank", async () => {
		await withTrial(taskNamed(BANK_TASKS, "bank-alert-settings"), async trial => {
			const { origin } = access(trial);
			expect((await signInToBank(trial, "/activity")).location).toBe("/activity");
			expect(await offsite(origin, async next => (await signInToBank(trial, next)).location)).toEqual([]);
		});
	}, 30_000);
});
