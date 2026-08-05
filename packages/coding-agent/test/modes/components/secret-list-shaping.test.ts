/**
 * What the Secrets table is allowed to hide, and what order it is allowed to show.
 *
 * WHY FILTERING IS A CONTRACT. The filter decides which credentials an operator can SEE, and a row
 * that is not on screen is a row they will conclude does not exist. Two failures matter more than
 * the rest and both are locked here: a broken vault file must survive every query, because it is
 * the one row that reports unreachable credentials and burying it leaves the operator with no sign
 * anything is wrong; and the query must never be matched against a stored value, because a table
 * that reveals a row when you type a guess at its contents is an oracle for the vault.
 *
 * WHY ORDER IS A CONTRACT. The cursor sits on an index, so an order that moves between two renders
 * of the same data is a row that changes under the key about to act on it. The order is therefore
 * total, not merely sorted: equal keys fall to name and then to scope. The expiry column carries
 * the second trap, since `null` there means "never expires" and any arithmetic that treats it as a
 * number sorts the one credential needing no attention above every credential that does.
 */
import { describe, expect, test } from "bun:test";
import { describeSort, nextSortKey, shapeSecretRows } from "@veyyon/coding-agent/modes/components/secret-list-shaping";
import type {
	ManagerRow,
	MatchSpan,
	SecretSortKey,
	ShapedRow,
	SortDirection,
} from "@veyyon/coding-agent/modes/components/secret-manager-types";
import { buildNamePlaceholder } from "@veyyon/coding-agent/secrets/placeholder";
import type { VaultScope } from "@veyyon/coding-agent/secrets/vault";

/** Every sort key, in the order the cycle walks them, for the loops that must hold across all four. */
const ALL_KEYS: readonly SecretSortKey[] = ["name", "scope", "expiry", "created"];

/** Both directions, for the loops that must hold whichever way a column runs. */
const ALL_DIRECTIONS: readonly SortDirection[] = ["asc", "desc"];

/**
 * A credential row.
 *
 * The value is derived from the name and deliberately distinctive, so a test can ask whether any
 * part of it reached the output and get a real answer rather than a coincidence.
 */
function secret(
	name: string,
	scope: VaultScope,
	stamps: { createdAt?: number; expiresAt?: number | null } = {},
): ManagerRow {
	return {
		kind: "secret",
		entry: {
			name,
			value: `hunter2-${name}-plaintext`,
			scope,
			createdAt: stamps.createdAt ?? 1_000,
			expiresAt: stamps.expiresAt === undefined ? null : stamps.expiresAt,
		},
	};
}

/** A vault file that would not open. */
function broken(scope: VaultScope, reason = "bad tag"): ManagerRow {
	return { kind: "broken", scope, reason };
}

/** Row identity in one string, so an ordering assertion reads as the list an operator would see. */
function ids(shaped: readonly ShapedRow[]): readonly string[] {
	return shaped.map(item => (item.row.kind === "broken" ? `broken:${item.row.scope}` : item.row.entry.name));
}

/** Spans as plain objects, so a mismatch prints the offsets rather than a class name. */
function spans(matches: readonly MatchSpan[]): readonly { start: number; end: number }[] {
	return matches.map(span => ({ start: span.start, end: span.end }));
}

/** The one shaped row a filter was expected to leave, failing loudly when it left a different count. */
function only(shaped: readonly ShapedRow[]): ShapedRow {
	expect(shaped).toHaveLength(1);
	return shaped[0];
}

describe("filtering on the placeholder text", () => {
	/**
	 * Locks out matching the bare NAME instead of the rendered placeholder. `#GITHUB_TOKEN#` is what
	 * the row shows and what an operator pastes into a prompt, so typing its leading `#` is the most
	 * natural way to search. Matching `entry.name` would make that exact query return nothing.
	 */
	test("a query containing the leading hash matches the rendered placeholder", () => {
		const shaped = shapeSecretRows([secret("GITHUB_TOKEN", "project")], {
			query: "#git",
			sortKey: "name",
			direction: "asc",
		});
		expect(ids(shaped)).toEqual(["GITHUB_TOKEN"]);
		expect(spans(only(shaped).nameMatches)).toEqual([{ start: 0, end: 4 }]);
	});

	/**
	 * Locks out a case-sensitive `includes`. Vault names are uppercase and nobody types them that
	 * way while searching, so a case-sensitive filter would report an empty vault for the query a
	 * user is most likely to enter.
	 */
	test("the query matches regardless of the case it was typed in", () => {
		const rows = [secret("GITHUB_TOKEN", "project")];
		for (const query of ["github", "GITHUB", "GiThUb"]) {
			const shaped = shapeSecretRows(rows, { query, sortKey: "name", direction: "asc" });
			expect(ids(shaped)).toEqual(["GITHUB_TOKEN"]);
			expect(spans(only(shaped).nameMatches)).toEqual([{ start: 1, end: 7 }]);
		}
	});

	/**
	 * Locks out returning only the first hit. A highlight built from one span leaves the second
	 * occurrence uncoloured, which reads as "this row matched somewhere else" and sends the operator
	 * looking for a match that is in front of them.
	 */
	test("every occurrence in one placeholder is reported, ascending and disjoint", () => {
		const shaped = shapeSecretRows([secret("AB_TOKEN_AB", "project")], {
			query: "ab",
			sortKey: "name",
			direction: "asc",
		});
		expect(spans(only(shaped).nameMatches)).toEqual([
			{ start: 1, end: 3 },
			{ start: 10, end: 12 },
		]);
	});

	/**
	 * Locks out advancing the scan by one character instead of by the query length. On a run of
	 * repeats that produces overlapping spans, and a consumer that paints them in sequence then
	 * writes escape sequences into the middle of a span it has already opened.
	 */
	test("a run of repeated characters yields non-overlapping spans", () => {
		const shaped = shapeSecretRows([secret("AAAAA", "project")], {
			query: "aa",
			sortKey: "name",
			direction: "asc",
		});
		// `#AAAAA#`: matches at offsets 1 and 3, and the trailing single `A` cannot start a third.
		expect(spans(only(shaped).nameMatches)).toEqual([
			{ start: 1, end: 3 },
			{ start: 3, end: 5 },
		]);
	});

	/**
	 * Locks out a filter that keeps everything. A query nobody's credentials match must empty the
	 * table, otherwise the filter is decoration and the operator scrolls the same forty rows.
	 */
	test("a query no credential contains removes every credential row", () => {
		const shaped = shapeSecretRows([secret("GITHUB_TOKEN", "project"), secret("NPM_TOKEN", "profile")], {
			query: "zzzz",
			sortKey: "name",
			direction: "asc",
		});
		expect(ids(shaped)).toEqual([]);
	});

	/**
	 * Locks out matching a query longer than the text. An unguarded scan that clamps rather than
	 * fails would hand back a span reaching past the end of the cell, and the highlight would slice
	 * a string at an offset that does not exist.
	 */
	test("a query longer than the placeholder matches nothing", () => {
		const shaped = shapeSecretRows([secret("SHORT", "project")], {
			query: "#SHORT_BUT_LONGER#",
			sortKey: "name",
			direction: "asc",
		});
		expect(ids(shaped)).toEqual([]);
	});

	/**
	 * Locks out folding with `toLowerCase`, which can change a string's LENGTH. A single `İ` earlier
	 * in the text shifts every later offset by one, so the highlight paints the wrong characters on
	 * exactly the rows that are hardest to eyeball.
	 */
	test("a non-ASCII character in the name does not shift the offsets after it", () => {
		const name = "TOKEN_\u0130_END";
		const shaped = shapeSecretRows([secret(name, "project")], {
			query: "end",
			sortKey: "name",
			direction: "asc",
		});
		const placeholder = buildNamePlaceholder(name);
		expect(spans(only(shaped).nameMatches)).toEqual([{ start: 9, end: 12 }]);
		expect(placeholder.slice(9, 12)).toBe("END");
	});

	/**
	 * Locks out treating a fumbled space as a real query. Neither a placeholder nor a scope can
	 * contain a space, so an untrimmed filter blanks the whole table on a keystroke the operator did
	 * not mean to make and cannot see.
	 */
	test("surrounding whitespace is ignored and a whitespace-only query filters nothing", () => {
		const rows = [secret("GITHUB_TOKEN", "project"), secret("NPM_TOKEN", "profile")];
		expect(ids(shapeSecretRows(rows, { query: "  github  ", sortKey: "name", direction: "asc" }))).toEqual([
			"GITHUB_TOKEN",
		]);
		expect(ids(shapeSecretRows(rows, { query: "   ", sortKey: "name", direction: "asc" }))).toEqual([
			"GITHUB_TOKEN",
			"NPM_TOKEN",
		]);
	});
});

describe("filtering on the scope", () => {
	/**
	 * Locks out searching the placeholder alone. Scope is the other column on the row and "show me
	 * everything in project" is the second question the filter exists to answer.
	 */
	test("a query naming a scope keeps that scope's rows and offsets into the scope text", () => {
		const shaped = shapeSecretRows([secret("GITHUB_TOKEN", "project"), secret("NPM_TOKEN", "profile")], {
			query: "proj",
			sortKey: "name",
			direction: "asc",
		});
		expect(ids(shaped)).toEqual(["GITHUB_TOKEN"]);
		expect(spans(only(shaped).scopeMatches)).toEqual([{ start: 0, end: 4 }]);
		expect(spans(only(shaped).nameMatches)).toEqual([]);
	});

	/**
	 * Locks out reporting one cell's spans for both cells, or dropping the second cell's spans once
	 * the first has decided the row survives. Each list indexes a DIFFERENT string, so reusing one
	 * for the other paints offsets from the placeholder onto the scope.
	 */
	test("a row matching in both cells carries the spans of each cell separately", () => {
		const shaped = shapeSecretRows([secret("PROJECT_KEY", "project")], {
			query: "project",
			sortKey: "name",
			direction: "asc",
		});
		expect(spans(only(shaped).nameMatches)).toEqual([{ start: 1, end: 8 }]);
		expect(spans(only(shaped).scopeMatches)).toEqual([{ start: 0, end: 7 }]);
	});

	/**
	 * Locks out requiring both cells to match. The two cells are ORed: a credential whose name says
	 * nothing about where it lives is exactly the one a scope query has to find.
	 */
	test("a scope match alone is enough to keep a row whose name does not match", () => {
		const shaped = shapeSecretRows([secret("AAAAA", "global")], {
			query: "global",
			sortKey: "name",
			direction: "asc",
		});
		expect(ids(shaped)).toEqual(["AAAAA"]);
		expect(spans(only(shaped).nameMatches)).toEqual([]);
	});
});

describe("the empty query", () => {
	/**
	 * Locks out an empty query being treated as a substring that matches at every offset, which
	 * would hand each cell a span of zero width at position zero and make the whole table look
	 * highlighted.
	 */
	test("no query keeps every row and reports no matches", () => {
		const shaped = shapeSecretRows([secret("GITHUB_TOKEN", "project"), broken("global")], {
			query: "",
			sortKey: "name",
			direction: "asc",
		});
		expect(ids(shaped)).toEqual(["broken:global", "GITHUB_TOKEN"]);
		for (const row of shaped) {
			expect(spans(row.nameMatches)).toEqual([]);
			expect(spans(row.scopeMatches)).toEqual([]);
		}
	});

	/**
	 * Locks out allocating a fresh empty array per cell. Shaping runs on every redraw, so two
	 * throwaway arrays per row is garbage proportional to the vault multiplied by the frame rate,
	 * for a value no reader can tell apart from the shared one.
	 */
	test("unmatched cells share one empty span list rather than allocating per row", () => {
		const shaped = shapeSecretRows([secret("GITHUB_TOKEN", "project"), secret("NPM_TOKEN", "profile")], {
			query: "",
			sortKey: "name",
			direction: "asc",
		});
		expect(shaped[0].nameMatches).toBe(shaped[1].nameMatches);
		expect(shaped[0].nameMatches).toBe(shaped[0].scopeMatches);
	});
});

describe("a broken vault file is never hidden", () => {
	/**
	 * Locks out filtering a broken row away. It is the only row that reports credentials the tool
	 * cannot reach, and a query that matches nothing else would otherwise leave an operator looking
	 * at an empty table with a damaged vault on disk.
	 */
	test("a broken row survives a query that matches nothing at all", () => {
		const shaped = shapeSecretRows([secret("GITHUB_TOKEN", "project"), broken("global")], {
			query: "zzzz",
			sortKey: "name",
			direction: "asc",
		});
		expect(ids(shaped)).toEqual(["broken:global"]);
	});

	/**
	 * Locks out sorting broken rows by the same rule as credentials, which would let a column or a
	 * direction push the alarm below the fold on a long vault. It stays at the top for all eight
	 * combinations of key and direction.
	 */
	test("a broken row leads the list for every sort key and both directions", () => {
		const rows = [
			secret("AAAAA", "project", { createdAt: 1, expiresAt: 1 }),
			broken("global"),
			secret("ZZZZZ", "global", { createdAt: 9, expiresAt: null }),
		];
		for (const sortKey of ALL_KEYS) {
			for (const direction of ALL_DIRECTIONS) {
				const shaped = shapeSecretRows(rows, { query: "", sortKey, direction });
				expect(ids(shaped)[0]).toBe("broken:global");
			}
		}
	});

	/**
	 * Locks out reversing the broken group with the direction. These rows are pinned above the
	 * credentials, so ordering them by the direction of a column they have no value for would make
	 * two unreadable vaults swap places for no reason the operator asked for.
	 */
	test("two broken rows keep the same widest-first order in both directions", () => {
		const rows = [broken("project"), broken("global"), broken("profile")];
		for (const direction of ALL_DIRECTIONS) {
			const shaped = shapeSecretRows(rows, { query: "", sortKey: "expiry", direction });
			expect(ids(shaped)).toEqual(["broken:global", "broken:profile", "broken:project"]);
		}
	});

	/**
	 * Locks out inventing a placeholder for a row that has none while still letting a scope query
	 * highlight the one cell a broken row does render. A name span here would index a string that
	 * does not exist on the row.
	 */
	test("a broken row highlights its scope and never reports a placeholder match", () => {
		const shaped = shapeSecretRows([broken("profile")], {
			query: "profile",
			sortKey: "name",
			direction: "asc",
		});
		expect(spans(only(shaped).scopeMatches)).toEqual([{ start: 0, end: 7 }]);
		expect(spans(only(shaped).nameMatches)).toEqual([]);
	});
});

describe("ordering by expiry", () => {
	const rows = [
		secret("NEVER", "project", { expiresAt: null }),
		secret("LATER", "project", { expiresAt: 5_000 }),
		secret("SOONEST", "project", { expiresAt: 1_000 }),
	];

	/**
	 * Locks out coercing `null` to zero, which is what `(a.expiresAt ?? 0) - (b.expiresAt ?? 0)`
	 * does. A credential that never expires would lead the soonest-first list, telling the operator
	 * the entry needing no attention is the one about to die.
	 */
	test("soonest first puts a credential that never expires last", () => {
		const shaped = shapeSecretRows(rows, { query: "", sortKey: "expiry", direction: "asc" });
		expect(ids(shaped)).toEqual(["SOONEST", "LATER", "NEVER"]);
	});

	/**
	 * Locks out a null rule written only for the ascending path. Reversing the column has to reverse
	 * the whole order, so "never" becomes the latest expiry and leads, rather than staying pinned at
	 * the bottom because the comparator special-cased one direction.
	 */
	test("latest first puts a credential that never expires first", () => {
		const shaped = shapeSecretRows(rows, { query: "", sortKey: "expiry", direction: "desc" });
		expect(ids(shaped)).toEqual(["NEVER", "LATER", "SOONEST"]);
	});

	/**
	 * Locks out an input order that leaks into the result. `null` arriving first is the arrangement
	 * a comparator with a broken null branch most often gets away with, because a stable sort leaves
	 * it where it already was.
	 */
	test("the null row is placed by the rule, not by where it sat in the input", () => {
		const nullFirst = [rows[0], rows[2], rows[1]];
		const nullLast = [rows[1], rows[2], rows[0]];
		const options = { query: "", sortKey: "expiry", direction: "asc" } as const;
		expect(ids(shapeSecretRows(nullFirst, options))).toEqual(["SOONEST", "LATER", "NEVER"]);
		expect(ids(shapeSecretRows(nullLast, options))).toEqual(["SOONEST", "LATER", "NEVER"]);
	});

	/**
	 * Locks out an unordered tail when nothing expires. A vault of permanent credentials is the
	 * common case, and if every key compares equal the list has to fall back to a real order rather
	 * than to whatever the vault files happened to yield.
	 */
	test("credentials that all never expire fall back to name order", () => {
		const shaped = shapeSecretRows(
			[secret("CHARLIE", "project"), secret("ALPHA", "project"), secret("BRAVO", "project")],
			{ query: "", sortKey: "expiry", direction: "asc" },
		);
		expect(ids(shaped)).toEqual(["ALPHA", "BRAVO", "CHARLIE"]);
	});

	/**
	 * Locks out an expiry stamp of exactly zero being read as "no expiry" by a truthiness check.
	 * Zero is a real epoch millisecond and such a credential is already expired, so it belongs at
	 * the very front of soonest-first, not at the back with the permanent ones.
	 */
	test("an expiry of exactly zero sorts ahead of every later stamp", () => {
		const shaped = shapeSecretRows(
			[secret("NEVER", "project", { expiresAt: null }), secret("EPOCH", "project", { expiresAt: 0 })],
			{ query: "", sortKey: "expiry", direction: "asc" },
		);
		expect(ids(shaped)).toEqual(["EPOCH", "NEVER"]);
	});
});

describe("the order is total and repeatable", () => {
	/**
	 * Locks out relying on the input order for ties. The cursor holds an index, so two rows with the
	 * same expiry that swap between renders move a credential under a key already being pressed.
	 */
	test("equal sort keys fall back to name in ascending order", () => {
		const shaped = shapeSecretRows(
			[
				secret("CHARLIE", "project", { expiresAt: 5_000 }),
				secret("ALPHA", "project", { expiresAt: 5_000 }),
				secret("BRAVO", "project", { expiresAt: 5_000 }),
			],
			{ query: "", sortKey: "expiry", direction: "asc" },
		);
		expect(ids(shaped)).toEqual(["ALPHA", "BRAVO", "CHARLIE"]);
	});

	/**
	 * Locks out negating the tie-break along with the column. Reversing expiry is a statement about
	 * expiry, and rows that tie in it should not also reshuffle amongst themselves, which would look
	 * like unrelated rows moving for no reason.
	 */
	test("reversing the column leaves the name tie-break ascending", () => {
		const shaped = shapeSecretRows(
			[
				secret("CHARLIE", "project", { expiresAt: 5_000 }),
				secret("ALPHA", "project", { expiresAt: 5_000 }),
				secret("BRAVO", "project", { expiresAt: 5_000 }),
			],
			{ query: "", sortKey: "expiry", direction: "desc" },
		);
		expect(ids(shaped)).toEqual(["ALPHA", "BRAVO", "CHARLIE"]);
	});

	/**
	 * Locks out a tie that no rule resolves. One name can exist in two scopes, so name alone is not
	 * a total order, and without the scope fall-back those two rows are free to trade places.
	 */
	test("the same name in two scopes is ordered widest scope first", () => {
		const shaped = shapeSecretRows(
			[secret("SHARED", "project"), secret("SHARED", "global"), secret("SHARED", "profile")],
			{ query: "", sortKey: "name", direction: "asc" },
		);
		expect(shaped.map(item => (item.row.kind === "secret" ? item.row.entry.scope : "broken"))).toEqual([
			"global",
			"profile",
			"project",
		]);
	});

	/**
	 * Locks out any dependence on the order the vault files were read in. The same set of rows must
	 * produce the same list whichever arrangement it arrives in, for every column, or a rescan that
	 * changes nothing still redraws a different table.
	 */
	test("the result is identical whichever order the same rows arrive in", () => {
		const forward = [
			secret("ALPHA", "global", { createdAt: 3_000, expiresAt: 2_000 }),
			secret("BRAVO", "profile", { createdAt: 1_000, expiresAt: null }),
			secret("CHARLIE", "project", { createdAt: 2_000, expiresAt: 2_000 }),
			broken("global"),
		];
		const reversed = [...forward].reverse();
		for (const sortKey of ALL_KEYS) {
			for (const direction of ALL_DIRECTIONS) {
				const options = { query: "", sortKey, direction };
				expect(ids(shapeSecretRows(reversed, options))).toEqual(ids(shapeSecretRows(forward, options)));
			}
		}
	});

	/**
	 * Locks out ordering by creation being lost to the name fall-back, and confirms both directions
	 * of the column an operator uses to find what they added most recently.
	 */
	test("creation order runs oldest first and reverses cleanly", () => {
		const rows = [
			secret("MIDDLE", "project", { createdAt: 2_000 }),
			secret("OLDEST", "project", { createdAt: 1_000 }),
			secret("NEWEST", "project", { createdAt: 3_000 }),
		];
		expect(ids(shapeSecretRows(rows, { query: "", sortKey: "created", direction: "asc" }))).toEqual([
			"OLDEST",
			"MIDDLE",
			"NEWEST",
		]);
		expect(ids(shapeSecretRows(rows, { query: "", sortKey: "created", direction: "desc" }))).toEqual([
			"NEWEST",
			"MIDDLE",
			"OLDEST",
		]);
	});

	/**
	 * Locks out the filter and the sort disagreeing about which rows exist. Rows removed by a query
	 * must not leave gaps or reappear in the ordered result.
	 */
	test("filtering and ordering compose, leaving only the matched rows in order", () => {
		const shaped = shapeSecretRows(
			[
				secret("NPM_TOKEN", "project", { expiresAt: 3_000 }),
				secret("GITHUB_TOKEN", "project", { expiresAt: 1_000 }),
				secret("AWS_TOKEN", "profile", { expiresAt: 2_000 }),
				secret("SSH_KEY", "project", { expiresAt: 500 }),
			],
			{ query: "token", sortKey: "expiry", direction: "asc" },
		);
		expect(ids(shaped)).toEqual(["GITHUB_TOKEN", "AWS_TOKEN", "NPM_TOKEN"]);
	});
});

describe("the sort key cycle", () => {
	/**
	 * Locks out a cycle that skips a column or stalls on one. The key is the only way to reach the
	 * other columns, so a broken step makes a column unreachable with no other route to it.
	 */
	test("four presses visit every column and return to the start", () => {
		const walked: SecretSortKey[] = [];
		let key: SecretSortKey = "name";
		for (let press = 0; press < 4; press++) {
			key = nextSortKey(key);
			walked.push(key);
		}
		expect(walked).toEqual(["scope", "expiry", "created", "name"]);
		expect(key).toBe("name");
	});

	/**
	 * Locks out a cycle that depends on where it was entered. The card can open on any column, so
	 * starting anywhere has to still walk all four before repeating.
	 */
	test("the cycle covers all four columns from whichever column it starts on", () => {
		for (const start of ALL_KEYS) {
			const seen = new Set<SecretSortKey>([start]);
			let key = start;
			for (let press = 0; press < 3; press++) {
				key = nextSortKey(key);
				seen.add(key);
			}
			expect([...seen].sort()).toEqual(["created", "expiry", "name", "scope"]);
			expect(nextSortKey(key)).toBe(start);
		}
	});
});

describe("the footer's sort label", () => {
	/**
	 * Locks out a label that names the column but not which end of it is on top. "sorted by expiry"
	 * alone leaves an operator to guess whether the first row is the credential about to die or the
	 * one that never will, which is the entire reason to sort by that column.
	 */
	test("each column and direction has its own spelled-out label", () => {
		expect(describeSort("name", "asc")).toBe("sorted by name (A to Z)");
		expect(describeSort("name", "desc")).toBe("sorted by name (Z to A)");
		expect(describeSort("scope", "asc")).toBe("sorted by scope (widest first)");
		expect(describeSort("scope", "desc")).toBe("sorted by scope (narrowest first)");
		expect(describeSort("expiry", "asc")).toBe("sorted by expiry (soonest first)");
		expect(describeSort("expiry", "desc")).toBe("sorted by expiry (latest first)");
		expect(describeSort("created", "asc")).toBe("sorted by created (oldest first)");
		expect(describeSort("created", "desc")).toBe("sorted by created (newest first)");
	});

	/**
	 * Locks out two columns sharing a label, which would make the cycle look like it had stopped
	 * moving and invite an operator to keep pressing past the column they wanted.
	 */
	test("no two column and direction pairs produce the same label", () => {
		const labels = ALL_KEYS.flatMap(key => ALL_DIRECTIONS.map(direction => describeSort(key, direction)));
		expect(labels).toHaveLength(8);
		expect(new Set(labels).size).toBe(8);
	});
});

describe("the credential value never reaches the output", () => {
	/**
	 * Locks out searching `entry.value`. A filter that matches the stored value turns the table into
	 * an oracle: type a guess, and a row appearing confirms it. That is the vault's one promise, and
	 * it would be broken by a single extra clause in the match.
	 */
	test("a query equal to a stored value matches nothing", () => {
		const rows = [secret("GITHUB_TOKEN", "project"), broken("global")];
		const shaped = shapeSecretRows(rows, {
			query: "hunter2-GITHUB_TOKEN-plaintext",
			sortKey: "name",
			direction: "asc",
		});
		expect(ids(shaped)).toEqual(["broken:global"]);
	});

	/**
	 * Locks out a partial-value match, which leaks the value one character at a time: an oracle that
	 * answers "does it start with this" is as good as one that answers "is it this".
	 */
	test("a query equal to a fragment of a stored value matches nothing", () => {
		const shaped = shapeSecretRows([secret("GITHUB_TOKEN", "project")], {
			query: "hunter",
			sortKey: "name",
			direction: "asc",
		});
		expect(ids(shaped)).toEqual([]);
	});

	/**
	 * Locks out a span that reaches past the cell it belongs to. Every offset is consumed as an
	 * index into the placeholder or the scope, so a span longer than its own text would slice
	 * whatever the container happens to have concatenated after it.
	 */
	test("every span stays inside the cell it indexes", () => {
		const rows = [secret("PROJECT_TOKEN", "project"), secret("PROJECT_KEY", "profile"), broken("project")];
		const shaped = shapeSecretRows(rows, { query: "p", sortKey: "name", direction: "asc" });
		expect(ids(shaped)).toEqual(["broken:project", "PROJECT_KEY", "PROJECT_TOKEN"]);
		for (const item of shaped) {
			const nameText = item.row.kind === "secret" ? buildNamePlaceholder(item.row.entry.name) : "";
			const scopeText = item.row.kind === "secret" ? item.row.entry.scope : item.row.scope;
			for (const span of item.nameMatches) {
				expect(span.start).toBeGreaterThanOrEqual(0);
				expect(span.end).toBeLessThanOrEqual(nameText.length);
			}
			for (const span of item.scopeMatches) {
				expect(span.start).toBeGreaterThanOrEqual(0);
				expect(span.end).toBeLessThanOrEqual(scopeText.length);
			}
		}
	});
});
