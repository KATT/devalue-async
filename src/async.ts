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

	/* eslint-disable perfectionist/sort-objects */
	const reducers: Record<string, (value: unknown) => unknown> = {
		...options.reducers,
		ReadableStream(v) {
			if (!(v instanceof ReadableStream)) {
				return false;
			}
			return registerAsync(async function* () {
				const reader = v.getReader();
				try {
					// eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
					while (true) {
						const next = await reader.read();

						if (next.done) {
							yield [
								ASYNC_ITERABLE_STATUS_RETURN,
								stringify(next.value, reducers),
							];
							break;
						}
						yield [
							ASYNC_ITERABLE_STATUS_YIELD,
							stringify(next.value, reducers),
						];
					}
				} catch (cause) {
					yield [ASYNC_ITERABLE_STATUS_ERROR, safeCause(cause)];
				} finally {
					reader.releaseLock();
					await reader.cancel();
				}
			});
		},
		AsyncIterable(v) {
			if (!isAsyncIterable(v)) {
				return false;
			}
			return registerAsync(async function* () {
				const iterator = v[Symbol.asyncIterator]();
				try {
					// eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
					while (true) {
						const next = await iterator.next();
						if (next.done) {
							yield [
								ASYNC_ITERABLE_STATUS_RETURN,
								stringify(next.value, reducers),
							];
							break;
						}
						yield [
							ASYNC_ITERABLE_STATUS_YIELD,
							stringify(next.value, reducers),
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
					yield [PROMISE_STATUS_FULFILLED, stringify(next, reducers)];
				} catch (cause) {
					yield [PROMISE_STATUS_REJECTED, safeCause(cause)];
				}
			});
		},
	};

	/* eslint-enable perfectionist/sort-objects */

	/** @param cause The error cause to safely stringify - prevents interrupting full stream when error is unregistered */
	function safeCause(cause: unknown) {
		try {
			return stringify(cause, reducers);
		} catch (err) {
			if (!options.coerceError) {
				throw err;
			}
			return stringify(options.coerceError(cause), reducers);
		}
	}

	yield stringify(value, reducers) + "\n";

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
	const iterator = lineAggregator(value)[Symbol.asyncIterator]();
	const controllerMap = new Map<
		ChunkIndex,
		ReturnType<typeof createController>
	>();

	function createController(id: ChunkIndex) {
		let deferred = createDeferred();
		type Chunk = [ChunkStatus, unknown] | Error;
		const buffer: Chunk[] = [];

		async function* generator() {
			try {
				// eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
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
	/* eslint-disable perfectionist/sort-objects */

	const revivers: Record<string, (value: unknown) => unknown> = {
		...opts.revivers,

		ReadableStream(idx) {
			const c = getController(idx as ChunkIndex);

			const iterable = c.generator();

			return new ReadableStream({
				async cancel() {
					await iterable.return();
				},
				async pull(controller) {
					const result = await iterable.next();

					if (result.done) {
						controller.close();
						return;
					}
					const [status, value] = result.value;
					switch (status) {
						case ASYNC_ITERABLE_STATUS_RETURN:
							controller.close();
							break;
						case ASYNC_ITERABLE_STATUS_YIELD:
							controller.enqueue(value);
							break;
						case ASYNC_ITERABLE_STATUS_ERROR:
							throw value;
						default:
							// eslint-disable-next-line @typescript-eslint/restrict-template-expressions
							throw new Error(`Unknown async iterable status: ${status}`);
					}
				},
			});
		},
		async *AsyncIterable(idx) {
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

	/* eslint-enable perfectionist/sort-objects */

	// will contain the head of the async iterable
	const head = await iterator.next();

	// eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
	const headValue: T = unflatten(
		JSON.parse(head.value as string) as unknown[],
		revivers,
	);

	if (!head.done) {
		(async () => {
			// eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
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

				getController(idx).push([status, unflatten(flattened, revivers)]);
			}
			// if we get here, we've finished the stream, let's go through all the enqueue map and enqueue a stream interrupt error
			// this will only happen if receiving a malformatted stream
			for (const [, enqueue] of controllerMap) {
				enqueue.push(new Error("Stream interrupted: malformed stream"));
			}
		})().catch((cause: unknown) => {
			// go through all the asyncMap and enqueue the error
			for (const [, enqueue] of controllerMap) {
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

async function* lineAggregator(value: AsyncIterable<string>) {
	let buffer = "";

	for await (const line of value) {
		buffer += line;
		const parts = buffer.split("\n");
		buffer = parts.pop() ?? "";
		for (const part of parts) {
			yield part;
		}
	}
}
