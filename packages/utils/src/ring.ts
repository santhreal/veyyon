export class RingBuffer<T> {
	#buf: (T | undefined)[];
	#head = 0;
	#size = 0;

	constructor(public readonly capacity: number) {
		this.#buf = new Array(capacity);
	}

	get length(): number {
		return this.#size;
	}

	get isFull(): boolean {
		return this.#size === this.capacity;
	}

	get isEmpty(): boolean {
		return this.#size === 0;
	}

	push(item: T): T | undefined {
		const idx = (this.#head + this.#size) % this.capacity;
		const overwritten = this.#size === this.capacity ? this.#buf[idx] : undefined;
		this.#buf[idx] = item;
		if (this.#size === this.capacity) {
			this.#head = (this.#head + 1) % this.capacity;
		} else {
			this.#size++;
		}
		return overwritten;
	}

	shift(): T | undefined {
		if (this.#size === 0) return undefined;
		const item = this.#buf[this.#head];
		this.#buf[this.#head] = undefined;
		this.#head = (this.#head + 1) % this.capacity;
		this.#size--;
		return item;
	}

	pop(): T | undefined {
		if (this.#size === 0) return undefined;
		const idx = (this.#head + this.#size - 1) % this.capacity;
		const item = this.#buf[idx];
		this.#buf[idx] = undefined;
		this.#size--;
		return item;
	}

	unshift(item: T): T | undefined {
		this.#head = (this.#head - 1 + this.capacity) % this.capacity;
		const overwritten = this.#size === this.capacity ? this.#buf[this.#head] : undefined;
		this.#buf[this.#head] = item;
		if (this.#size < this.capacity) this.#size++;
		return overwritten;
	}

	at(index: number): T | undefined {
		if (index < 0) index += this.#size;
		if (index < 0 || index >= this.#size) return undefined;
		return this.#buf[(this.#head + index) % this.capacity];
	}

	peek(): T | undefined {
		return this.at(0);
	}

	peekBack(): T | undefined {
		return this.at(this.#size - 1);
	}

	clear(): void {
		this.#buf.fill(undefined, 0, this.capacity);
		this.#head = 0;
		this.#size = 0;
	}

	*[Symbol.iterator](): Iterator<T> {
		for (let i = 0; i < this.#size; i++) {
			yield this.#buf[(this.#head + i) % this.capacity] as T;
		}
	}

	toArray(): T[] {
		if (this.#head + this.#size <= this.capacity) {
			return this.#buf.slice(this.#head, this.#head + this.#size) as T[];
		}
		const tail = this.#buf.slice(this.#head, this.capacity);
		const head = this.#buf.slice(0, (this.#head + this.#size) % this.capacity);
		return tail.concat(head) as T[];
	}
}
