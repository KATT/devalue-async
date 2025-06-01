/* eslint-disable @typescript-eslint/no-unused-vars */
/* eslint-disable @typescript-eslint/no-unnecessary-condition */

import { stringify, unflatten } from "devalue";

import { createDeferred } from "./createDeferred.js";
import { mergeAsyncIterables } from "./mergeAsyncIterable.js";

type Branded<T, Brand> = T & { __brand: Brand };

function chunkStatus<T extends number>(value: T): Branded<T, "chunkStatus"> {
	return value as Branded<T, "chunkStatus">;
}

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

const PROMISE_STATUS_FULFILLED = chunkStatus(0);
const PROMISE_STATUS_REJECTED = chunkStatus(1);

const ASYNC_ITERABLE_STATUS_YIELD = chunkStatus(0);
const ASYNC_ITERABLE_STATUS_ERROR = chunkStatus(1);
const ASYNC_ITERABLE_STATUS_RETURN = chunkStatus(2);

type ChunkIndex = Branded<number, "chunkIndex">;
type ChunkStatus = Branded<number, "chunkStatus">;

export async function* stringifyAsync(
	value: unknown,
	options: {
		coerceError?: (cause: unknown) => unknown;
		reducers?: Record<string, (value: unknown) => unknown>;
	} = {},
) {
	let counter = 0;

	const mergedIterables =
		mergeAsyncIterables<[ChunkIndex, ChunkStatus, string]>();

	function registerAsync(
		callback: (idx: ChunkIndex) => AsyncIterable<[ChunkStatus, string]>,
	) {
		const idx = ++counter as ChunkIndex;

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
		...options.reducers,
		AsyncIterable(v) {
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
		Promise(v) {
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

export async function unflattenAsync<T>(
	value: AsyncIterable<string>,
	opts: {
		revivers?: Record<string, (value: unknown) => unknown>;
	} = {},
): Promise<T> {
	const iterator = value[Symbol.asyncIterator]();
	const controllerMap = new Map<
		ChunkIndex,
		ReturnType<typeof createController>
	>();

	function createController(id: ChunkIndex) {
		let deferred = createDeferred();
		type Chunk = [number, unknown] | Error;
		const buffer: Chunk[] = [];

		async function* generator() {
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
				controllerMap.delete(id);
			}
		}

		return {
			generator,
			push: (v: Chunk) => {
				buffer.push(v);
				deferred.resolve();
			},
		};
	}

	function getController(id: ChunkIndex) {
		const c = controllerMap.get(id);
		if (!c) {
			const queue = createController(id);
			controllerMap.set(id, queue);
			return queue;
		}
		return c;
	}

	const asyncRevivers: Record<string, (value: unknown) => unknown> = {
		...opts.revivers,
		async *AsyncIterable(idx) {
			assertNumber(idx);
			const c = getController(idx as ChunkIndex);

			for await (const item of c.generator()) {
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
		Promise(idx) {
			assertNumber(idx);
			const c = getController(idx as ChunkIndex);

			const promise = (async () => {
				for await (const item of c.generator()) {
					const [status, value] = item;
					switch (status) {
						case PROMISE_STATUS_FULFILLED:
							return value;
						case PROMISE_STATUS_REJECTED:
							throw value;
						default:
							// eslint-disable-next-line @typescript-eslint/restrict-template-expressions
							throw new Error(`Unknown promise status: ${status}`);
					}
				}
			})();

			promise.catch(() => {
				// prevent unhandled promise rejection warnings
			});

			return promise;
		},
	};

	// will contain the head of the async iterable
	const head = await iterator.next();

	// eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
	const headValue: T = unflatten(
		JSON.parse(head.value as string) as unknown[],
		asyncRevivers,
	);

	if (!head.done) {
		(async () => {
			while (true) {
				const result = await iterator.next();
				if (result.done) {
					break;
				}

				const [idx, status, flattened] = JSON.parse(result.value) as [
					ChunkIndex,
					ChunkStatus,
					unknown[],
				];

				assertNumber(idx);
				assertNumber(status);

				getController(idx).push([status, unflatten(flattened, asyncRevivers)]);
			}
			// if we get here, we've finished the stream, let's go through all the enqueue map and enqueue a stream interrupt error
			// this will only happen if receiving a malformatted stream
			for (const [_, enqueue] of controllerMap) {
				enqueue.push(new Error("Stream interrupted: malformed stream"));
			}
		})().catch((cause: unknown) => {
			// go through all the asyncMap and enqueue the error
			for (const [_, enqueue] of controllerMap) {
				enqueue.push(
					cause instanceof Error
						? cause
						: new Error("Stream interrupted", { cause }),
				);
			}
		});
	}

	return headValue;
}

function assertNumber(value: unknown): asserts value is number {
	if (typeof value !== "number") {
		throw new Error(`Expected number, got ${typeof value}`);
	}
}

/* eslint-enable @typescript-eslint/no-unused-vars */
/* eslint-enable @typescript-eslint/no-unnecessary-condition */
