/**
 * WHY: `EventStream`'s reader answers `next()`, `return()` and `throw()` from a per-reader list of owed reads
 * instead of running an async generator. The generator it replaced handed an event pushed right after
 * `return()` to the finished reader, where it was lost, and left `return()` unanswered when the generator had
 * an overlapping read queued that it had not parked yet. Both are members of one class: a read or an event
 * whose fate depends on promise timing instead of on the order of the calls that produced it.
 *
 * Class closed: every interleaving of stream operations (push, terminal push, end, endWaiting, fail) and reader
 * operations (next, return, throw, a second reader's next) up to MAX_LENGTH, with event-loop drains anywhere
 * in the sequence. Each sequence runs against `EventStream` and against SpecStream, a synchronous model of
 * the contract with no promises in it. By every drain both must have answered the same reads the same way,
 * each reader's in call order, and hold the same queue and the same number of parked readers; after the
 * sequence, a fresh read on each reader must get the same answer. A new operation is a new row in OPERATIONS
 * and joins every sequence.
 *
 * Not caught: interleavings longer than MAX_LENGTH, more than two readers, and the order between two readers'
 * answers within one drain, which independent iterators do not promise each other.
 */
import { describe, expect, it } from "bun:test";
import { EventStream } from "@veyyon/ai/utils/event-stream";

const TERMINAL = "terminal";
const STREAM_FAILURE = "stream failed";
const READER_FAILURE = "reader threw";
const DONE = "done undefined";

type ReaderName = "A" | "B";

/** One reader in the model: the reads it owes in call order, and whether it finished. */
class SpecReader {
	readonly owed: string[] = [];
	finished = false;
	constructor(readonly name: ReaderName) {}
}

/**
 * The reader contract as plain synchronous state. A read is answered from the queue, then by the failure, then
 * by the end; a reader that cannot answer its oldest read parks once at the back of `parked`. An event goes to
 * the reader parked longest, or to the queue.
 */
class SpecStream {
	readonly answers: string[] = [];
	readonly queue: string[] = [];
	readonly parked: SpecReader[] = [];
	#ended = false;
	#failure: string | undefined;

	#answer(reader: SpecReader, call: string, outcome: string): void {
		this.answers.push(`${reader.name} ${call} ${outcome}`);
	}
	#take(reader: SpecReader): string | undefined {
		if (reader.finished) return DONE;
		if (this.queue.length > 0) return `value ${this.queue.shift()}`;
		if (this.#failure !== undefined) {
			reader.finished = true;
			return `rejected ${this.#failure}`;
		}
		if (this.#ended) {
			reader.finished = true;
			return DONE;
		}
		return undefined;
	}
	#serve(reader: SpecReader): void {
		while (reader.owed.length > 0) {
			const outcome = this.#take(reader);
			if (outcome === undefined) {
				this.parked.push(reader);
				return;
			}
			this.#answer(reader, reader.owed.shift()!, outcome);
		}
	}
	#wakeAll(outcome: string): void {
		while (this.parked.length > 0) {
			const reader = this.parked.shift()!;
			reader.finished = true;
			this.#answer(reader, reader.owed.shift()!, outcome);
			this.#serve(reader);
		}
	}
	#leave(reader: SpecReader): void {
		reader.finished = true;
		const index = this.parked.indexOf(reader);
		if (index !== -1) this.parked.splice(index, 1);
	}

	push(event: string): void {
		if (this.#ended) return;
		if (event === TERMINAL) this.#ended = true;
		const reader = this.parked.shift();
		if (!reader) {
			this.queue.push(event);
			return;
		}
		this.#answer(reader, reader.owed.shift()!, `value ${event}`);
		this.#serve(reader);
	}
	end(): void {
		this.#ended = true;
		this.#wakeAll(DONE);
	}
	/** Finishes every parked reader without ending the stream. */
	endWaiting(): void {
		this.#wakeAll(DONE);
	}
	fail(): void {
		if (this.#ended) return;
		this.#ended = true;
		this.#failure = STREAM_FAILURE;
		this.#wakeAll(`rejected ${STREAM_FAILURE}`);
	}
	next(reader: SpecReader, call: string): void {
		reader.owed.push(call);
		if (reader.owed.length === 1) this.#serve(reader);
	}
	return(reader: SpecReader, call: string): void {
		this.#leave(reader);
		this.#serve(reader);
		this.#answer(reader, call, DONE);
	}
	throw(reader: SpecReader, call: string): void {
		this.#leave(reader);
		const oldest = reader.owed.shift();
		if (oldest !== undefined) this.#answer(reader, oldest, `rejected ${READER_FAILURE}`);
		this.#serve(reader);
		this.#answer(reader, call, `rejected ${READER_FAILURE}`);
	}
}

/** What one operation does to the model and to the real stream. */
interface Subject {
	push(event: string): void;
	end(): void;
	endWaiting(): void;
	fail(): void;
	next(reader: ReaderName, call: string): void;
	return(reader: ReaderName, call: string): void;
	throw(reader: ReaderName, call: string): void;
	/** Answers so far, then the queue and the parked-reader count, as one comparable line set. */
	snapshot(): Promise<string[]>;
}

function specSubject(): Subject {
	const stream = new SpecStream();
	const readers: Record<ReaderName, SpecReader> = { A: new SpecReader("A"), B: new SpecReader("B") };
	let reported = 0;
	return {
		push: event => stream.push(event),
		end: () => stream.end(),
		endWaiting: () => stream.endWaiting(),
		fail: () => stream.fail(),
		next: (reader, call) => stream.next(readers[reader], call),
		return: (reader, call) => stream.return(readers[reader], call),
		throw: (reader, call) => stream.throw(readers[reader], call),
		snapshot: async () => {
			const segment = stream.answers.slice(reported);
			reported = stream.answers.length;
			return [...byReader(segment), `| queue=[${stream.queue.join(",")}] parked=${stream.parked.length}`];
		},
	};
}

function streamSubject(): Subject {
	const stream = new EventStream<string, string>(
		event => event === TERMINAL,
		event => event,
	);
	const readers = new Map<ReaderName, AsyncIterableIterator<string>>();
	const reader = (name: ReaderName): AsyncIterableIterator<string> => {
		let opened = readers.get(name);
		if (!opened) {
			opened = stream[Symbol.asyncIterator]();
			readers.set(name, opened);
		}
		return opened;
	};
	const answers: string[] = [];
	const record = (name: ReaderName, call: string, read: Promise<IteratorResult<string, unknown>>): void => {
		read.then(
			result => answers.push(`${name} ${call} ${result.done ? "done" : "value"} ${String(result.value)}`),
			(err: unknown) => answers.push(`${name} ${call} rejected ${err instanceof Error ? err.message : String(err)}`),
		);
	};
	let reported = 0;
	return {
		push: event => stream.push(event),
		end: () => stream.end(),
		endWaiting: () => stream.endWaiting(),
		fail: () => stream.fail(new Error(STREAM_FAILURE)),
		next: (name, call) => record(name, call, reader(name).next()),
		return: (name, call) => record(name, call, reader(name).return!()),
		throw: (name, call) => record(name, call, reader(name).throw!(new Error(READER_FAILURE))),
		snapshot: async () => {
			const { promise, resolve } = Promise.withResolvers<void>();
			setImmediate(resolve);
			await promise;
			const segment = answers.slice(reported);
			reported = answers.length;
			return [...byReader(segment), `| queue=[${stream.queue.join(",")}] parked=${stream.waiting.length}`];
		},
	};
}

/** Groups one drain's answers by reader, each reader's kept in the order they arrived. */
function byReader(answers: readonly string[]): string[] {
	return answers.toSorted((a, b) => a.charCodeAt(0) - b.charCodeAt(0));
}

/** A run of one sequence on one subject: call ids are numbered by the order of the calls. */
class Run {
	readonly log: string[] = [];
	#calls = 0;
	#pushed = 0;
	constructor(readonly subject: Subject) {}
	call(label: string): string {
		this.#calls += 1;
		return `${label}#${this.#calls}`;
	}
	event(): string {
		this.#pushed += 1;
		return `e${this.#pushed}`;
	}
	async drain(): Promise<void> {
		this.log.push(...(await this.subject.snapshot()));
	}
}

const OPERATIONS: Record<string, (run: Run) => void | Promise<void>> = {
	push: run => run.subject.push(run.event()),
	pushTerminal: run => run.subject.push(TERMINAL),
	end: run => run.subject.end(),
	endWaiting: run => run.subject.endWaiting(),
	fail: run => run.subject.fail(),
	next: run => run.subject.next("A", run.call("next")),
	return: run => run.subject.return("A", run.call("return")),
	throw: run => run.subject.throw("A", run.call("throw")),
	nextB: run => run.subject.next("B", run.call("next")),
	drain: run => run.drain(),
};
const MAX_LENGTH = 5;

async function play(subject: Subject, sequence: readonly string[]): Promise<string[]> {
	const run = new Run(subject);
	// Only a drain yields to the event loop, so the operations between two drains run back to back.
	for (const operation of sequence) {
		const draining = OPERATIONS[operation](run);
		if (draining) await draining;
	}
	await run.drain();
	// A fresh read on each reader after the sequence: it is answered, or both leave it waiting.
	subject.next("A", run.call("final"));
	subject.next("B", run.call("final"));
	await run.drain();
	return run.log;
}

function* sequences(length: number): Generator<string[]> {
	const names = Object.keys(OPERATIONS);
	const indices = new Array<number>(length).fill(0);
	while (true) {
		yield indices.map(index => names[index]);
		let position = length - 1;
		while (position >= 0 && indices[position] === names.length - 1) indices[position--] = 0;
		if (position < 0) return;
		indices[position] += 1;
	}
}

describe("an EventStream reader answers every read once, in call order, and loses no event", () => {
	for (let length = 1; length <= MAX_LENGTH; length++) {
		it(`matches the contract model on every sequence of ${length} operations`, async () => {
			const divergent: string[] = [];
			let count = 0;
			for (const sequence of sequences(length)) {
				count += 1;
				const expected = await play(specSubject(), sequence);
				const actual = await play(streamSubject(), sequence);
				if (JSON.stringify(actual) !== JSON.stringify(expected)) {
					divergent.push(
						`${sequence.join(" ")}\n  expected ${expected.join(" / ")}\n  actual   ${actual.join(" / ")}`,
					);
					if (divergent.length >= 5) break;
				}
			}
			expect(divergent).toEqual([]);
			expect(count).toBe(Object.keys(OPERATIONS).length ** length);
		}, 120_000);
	}

	it("keeps an event pushed right after a reader returned for the next reader", async () => {
		const stream = new EventStream<string, string>(
			event => event === TERMINAL,
			event => event,
		);
		const abandoned = stream[Symbol.asyncIterator]();
		const pending = abandoned.next();
		await abandoned.return!();
		stream.push("e1");
		expect(await pending).toEqual({ value: undefined, done: true });
		expect(await stream[Symbol.asyncIterator]().next()).toEqual({ value: "e1", done: false });
	});

	it("answers return() while a second overlapping read is still owed", async () => {
		const stream = new EventStream<string, string>(
			event => event === TERMINAL,
			event => event,
		);
		stream.push("e1");
		const reader = stream[Symbol.asyncIterator]();
		const first = reader.next();
		const second = reader.next();
		const closing = reader.return!();
		expect(await Promise.all([first, second, closing])).toEqual([
			{ value: "e1", done: false },
			{ value: undefined, done: true },
			{ value: undefined, done: true },
		]);
		expect(stream.waiting).toHaveLength(0);
	});
});
