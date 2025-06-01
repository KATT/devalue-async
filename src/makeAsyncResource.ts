// @ts-expect-error - polyfilling symbol
Symbol.asyncDispose ??= Symbol();

/**
 * Takes a value and an async dispose function and returns a new object that implements the AsyncDisposable interface.
 * The returned object is the original value augmented with a Symbol.asyncDispose method.
 * @param thing The value to make async disposable
 * @param dispose Async function to call when disposing the resource
 * @returns The original value with Symbol.asyncDispose method added
 */
export function makeAsyncResource<T>(
	thing: T,
	dispose: () => Promise<void>,
): AsyncDisposable & T {
	const it = thing as Partial<AsyncDisposable> & T;

	const existing = it[Symbol.asyncDispose];

	it[Symbol.asyncDispose] = async () => {
		await dispose();
		await existing?.();
	};

	return it as AsyncDisposable & T;
}
