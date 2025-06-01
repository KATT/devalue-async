/* eslint-disable @typescript-eslint/no-unused-vars */
/* eslint-disable @typescript-eslint/no-unnecessary-condition */
/* eslint-disable @typescript-eslint/no-explicit-any */

import { stringify, unflatten } from "devalue";

import { createDeferred } from "./createDeferred.js";
import { mergeAsyncIterables } from "./mergeAsyncIterable.js";

function isAsyncIterable(value: unknown): value is AsyncIterable<unknown> {
	return (
		typeof value === "object" && value !== null && Symbol.asyncIterator in value
	);
}

function isPromise(value: unknown): value is Promise<unknown> {
	return (
		typeof value === "object" &&
		value !== null &&
		"then" in value &&
		typeof value.then === "function"
	);
}

const PROMISE_STATUS_FULFILLED = 0;
const PROMISE_STATUS_REJECTED = 1;

const ASYNC_ITERABLE_STATUS_YIELD = 0;
const ASYNC_ITERABLE_STATUS_ERROR = 1;
const ASYNC_ITERABLE_STATUS_RETURN = 2;

export async function parseAsync<T>(
	value: AsyncIterable<string>,
	opts: {
		revivers?: Record<string, (value: any) => any>;
	} = {},
): Promise<T> {
	const iterator = value[Symbol.asyncIterator]();
	const enqueueMap = new Map<number, (v: [number, unknown] | Error) => void>();

	/**
	 * @param id
	 * @returns
	 */
	async function* registerAsync(id: number): AsyncIterable<[number, unknown]> {
		const buffer: ([number, unknown] | Error)[] = [];

		let deferred = createDeferred();

		enqueueMap.set(id, (v) => {
			buffer.push(v);
			deferred.resolve();
		});
		try {
			while (true) {
				await deferred.promise;
				deferred = createDeferred();

				while (buffer.length) {
					// eslint-disable-next-line @typescript-eslint/no-non-null-assertion
					const value = buffer.shift()!;
					if (value instanceof Error) {
						throw value;
					}
					yield value;
				}
			}
		} finally {
			enqueueMap.delete(id);
		}
	}

	const asyncRevivers: Record<string, (value: any) => any> = {
		...opts.revivers,
		async *AsyncIterable(idx) {
			assertNumber(idx);
			const iterable = registerAsync(idx);

			for await (const item of iterable) {
				const [status, value] = item;
				switch (status) {
					case ASYNC_ITERABLE_STATUS_RETURN:
						return value;
					case ASYNC_ITERABLE_STATUS_YIELD:
						yield value;
						break;
					case ASYNC_ITERABLE_STATUS_ERROR:
						throw value;
				}
			}
		},
		Promise: async (idx) => {
			assertNumber(idx);
			const iterable = registerAsync(idx);

			for await (const item of iterable) {
				const [status, value] = item;
				switch (status) {
					case PROMISE_STATUS_FULFILLED:
						return value;
					case PROMISE_STATUS_REJECTED:
						throw value;
					default:
						throw new Error(`Unknown promise status: ${status}`);
				}
			}
		},
	};

	// will contain the head of the async iterable
	const head = await iterator.next();
	const headValue: T = unflatten(
		JSON.parse(head.value as string),
		asyncRevivers,
	);

	if (!head.done) {
		(async () => {
			while (true) {
				const result = await iterator.next();
				if (result.done) {
					break;
				}

				const [idx, status, flattened] = JSON.parse(result.value);

				assertNumber(idx);
				assertNumber(status);

				enqueueMap.get(idx)?.([status, unflatten(flattened, asyncRevivers)]);
			}
			// if we get here, we've finished the stream, let's go through all the enqueue map and enqueue a stream interrupt error
			// this will only happen if receiving a malformatted stream
			for (const [_, enqueue] of enqueueMap) {
				enqueue(new Error("Stream interrupted: malformed stream"));
			}
		})().catch((cause: unknown) => {
			// go through all the asyncMap and enqueue the error
			for (const [_, enqueue] of enqueueMap) {
				enqueue(
					cause instanceof Error
						? cause
						: new Error(
								"Stream interrupted",
								// @ts-ignore this is fine
								{ cause },
							),
				);
			}
		});
	}

	return headValue;
}

export async function* stringifyAsync(
	value: unknown,
	options: {
		coerceError?: (cause: unknown) => unknown;
		revivers?: Record<string, (value: any) => any>;
	} = {},
) {
	let counter = 0;

	const mergedIterables = mergeAsyncIterables<[number, number, string]>();

	function registerAsync(
		callback: (idx: number) => AsyncIterable<[number, string]>,
	) {
		const idx = ++counter;

		const iterable = callback(idx);

		mergedIterables.add(
			(async function* () {
				for await (const item of iterable) {
					yield [idx, ...item];
				}
			})(),
		);

		return idx;
	}

	const revivers: Record<string, (value: unknown) => unknown> = {
		...options.revivers,
		AsyncIterable: (v) => {
			if (!isAsyncIterable(v)) {
				return false;
			}
			return registerAsync(async function* () {
				const iterator = v[Symbol.asyncIterator]();
				try {
					while (true) {
						const next = await iterator.next();
						if (next.done) {
							yield [
								ASYNC_ITERABLE_STATUS_RETURN,
								stringify(next.value, revivers),
							];
							break;
						}
						yield [
							ASYNC_ITERABLE_STATUS_YIELD,
							stringify(next.value, revivers),
						];
					}
				} catch (cause) {
					yield [ASYNC_ITERABLE_STATUS_ERROR, safeCause(cause)];
				} finally {
					await iterator.return?.();
				}
			});
		},
		Promise: (v) => {
			if (!isPromise(v)) {
				return false;
			}
			v.catch(() => {
				// prevent unhandled promise rejection
			});
			return registerAsync(async function* () {
				try {
					const next = await v;
					yield [PROMISE_STATUS_FULFILLED, stringify(next, revivers)];
				} catch (cause) {
					yield [PROMISE_STATUS_REJECTED, safeCause(cause)];
				}
			});
		},
	};

	/** @param cause The error cause to safely stringify - prevents interrupting full stream when error is unregistered */
	function safeCause(cause: unknown) {
		try {
			return stringify(cause, revivers);
		} catch (err) {
			if (!options.coerceError) {
				throw err;
			}
			return stringify(options.coerceError(cause), revivers);
		}
	}

	yield stringify(value, revivers) + "\n";

	for await (const item of mergedIterables) {
		yield "[" + item.join(",") + "]\n";
	}
}

function assertNumber(value: unknown): asserts value is number {
	if (typeof value !== "number") {
		throw new Error(`Expected number, got ${typeof value}`);
	}
}

/* eslint-enable @typescript-eslint/no-explicit-any */
/* eslint-enable @typescript-eslint/no-unused-vars */
/* eslint-enable @typescript-eslint/no-unnecessary-condition */
