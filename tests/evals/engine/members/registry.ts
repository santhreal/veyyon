/**
 * One registry, for every kind of member this package discovers.
 *
 * There used to be three of these — a suite registry keyed on `name`, a harness
 * registry keyed on `name`, a backend registry keyed on `id` — each with its own
 * not-found error, its own duplicate error and its own module-level singleton.
 * Three copies of one data structure is three places a lookup rule can drift, and
 * the split key meant a caller could not write one function over "a member".
 *
 * A member is identified by `id`, and `id` is its file name. Nothing assigns an id
 * by hand: `discover.ts` derives it from the path, so the name in an error message
 * is the name of the file to open.
 */

/** Anything this package discovers from a directory of member files. */
export interface Member {
	readonly id: string;
}

export class MemberNotFoundError extends Error {
	constructor(
		readonly kind: string,
		readonly id: string,
		readonly known: readonly string[],
	) {
		super(
			`No ${kind} named "${id}". ${
				known.length > 0 ? `Registered: ${known.join(", ")}` : `The ${kind} directory holds no members.`
			}`,
		);
		this.name = "MemberNotFoundError";
	}
}

export class DuplicateMemberError extends Error {
	constructor(
		readonly kind: string,
		readonly id: string,
	) {
		super(`Two ${kind} members claim the id "${id}"; an id is a file name, so two files disagree about theirs.`);
		this.name = "DuplicateMemberError";
	}
}

/**
 * A set of members of one kind, keyed on id.
 *
 * Insertion order is preserved, so a listing reads in the order the directory was
 * walked (sorted by file name) rather than in whatever order imports resolved.
 */
export class Registry<T extends Member> {
	readonly kind: string;
	readonly #members = new Map<string, T>();

	constructor(kind: string) {
		this.kind = kind;
	}

	register(member: T): void {
		if (this.#members.has(member.id)) throw new DuplicateMemberError(this.kind, member.id);
		this.#members.set(member.id, member);
	}

	/** Registers unless the id is taken, so importing a member twice is not an error. */
	registerOnce(member: T): void {
		if (!this.#members.has(member.id)) this.#members.set(member.id, member);
	}

	get(id: string): T | undefined {
		return this.#members.get(id);
	}

	has(id: string): boolean {
		return this.#members.has(id);
	}

	require(id: string): T {
		const found = this.#members.get(id);
		if (!found) throw new MemberNotFoundError(this.kind, id, this.ids());
		return found;
	}

	list(): readonly T[] {
		return [...this.#members.values()];
	}

	ids(): readonly string[] {
		return [...this.#members.keys()];
	}

	unregister(id: string): boolean {
		return this.#members.delete(id);
	}

	clear(): void {
		this.#members.clear();
	}
}
