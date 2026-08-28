export async function bestEffort(step: Promise<unknown>, why: string): Promise<void> {
	void why;
	try {
		await step;
	} catch {}
}

export async function optionalResult<T>(probe: Promise<T>, why: string): Promise<T | undefined> {
	void why;
	try {
		return await probe;
	} catch {
		return undefined;
	}
}
