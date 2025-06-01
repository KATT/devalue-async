import { expect, test } from "vitest";

import { stringifyAsync, unflattenAsync } from "./async.js";

type Constructor<T extends object = object> = new (...args: any[]) => T;

async function* asyncIterableFrom<T>(
	stream: ReadableStream<T>,
): AsyncIterable<T> {
	const reader = stream.getReader();

	try {
		// eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
		while (true) {
			const res = await reader.read();

			if (res.done) {
				return res.value;
			}

			yield res.value;
		}
	} finally {
		reader.releaseLock();
		await reader.cancel();
	}
}
function readableStreamFrom<T>(iterable: AsyncIterable<T>) {
	const iterator = iterable[Symbol.asyncIterator]();

	return new ReadableStream<T>({
		async cancel() {
			await iterator.return?.();
		},

		async pull(controller) {
			const result = await iterator.next();

			if (result.done) {
				controller.close();
				return;
			}

			controller.enqueue(result.value);
		},
	});
}

async function waitError<TError extends Error = Error>(
	fnOrPromise: (() => unknown) | Promise<unknown>,
	errorConstructor?: Constructor<TError>,
): Promise<TError> {
	try {
		if (typeof fnOrPromise === "function") {
			await fnOrPromise();
		} else {
			await fnOrPromise;
		}
	} catch (cause) {
		expect(cause).toBeInstanceOf(errorConstructor ?? Error);
		return cause as TError;
	}
	throw new Error("Function did not throw");
}

async function* withDebug<T>(iterable: AsyncIterable<T>) {
	for await (const value of iterable) {
		yield value;
		// console.log("yielding", value);
	}
}

test("stringify and unflatten async", async () => {
	const source = {
		asyncIterable: (async function* () {
			await new Promise((resolve) => setTimeout(resolve, 0));
			yield -0;
			yield 1;
			yield 2;
			return "returned async iterable";
		})(),
		promise: (async () => {
			await new Promise((resolve) => setTimeout(resolve, 0));
			return "resolved promise";
		})(),
	};
	const iterable = stringifyAsync(source);

	const result = await unflattenAsync<typeof source>(withDebug(iterable));

	expect(await result.promise).toEqual("resolved promise");

	const aggregate = [];
	const iterator = result.asyncIterable[Symbol.asyncIterator]();
	// eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
	while (true) {
		const next = await iterator.next();
		if (next.done) {
			expect(next.value).toEqual("returned async iterable");
			break;
		}
		aggregate.push(next.value);
	}

	expect(aggregate).toEqual([-0, 1, 2]);
});

test("stringify and parse async values with errors - simple", async () => {
	class MyCustomError extends Error {
		constructor(message: string) {
			super(message);
			this.name = "MyCustomError";
		}
	}

	class UnregisteredError extends Error {
		constructor(cause: unknown) {
			const message = cause instanceof Error ? cause.message : String(cause);
			super(message, { cause });
			this.name = "UnregisteredError";
		}
	}

	const source = {
		asyncIterable: (async function* () {
			yield 0;
			yield 1;
			throw new MyCustomError("error in async iterable");
		})(),
	};

	const iterable = stringifyAsync(source, {
		coerceError: (error) => {
			return new UnregisteredError(error);
		},
		reducers: {
			MyCustomError: (value) => {
				if (value instanceof MyCustomError) {
					return value.message;
				}
				return false;
			},
			UnregisteredError: (value) => {
				if (value instanceof UnregisteredError) {
					return [value.message];
				}
				return false;
			},
		},
	});

	const result = await unflattenAsync<typeof source>(iterable, {
		revivers: {
			MyCustomError: (value) => {
				return new MyCustomError(value as string);
			},
			UnregisteredError: (...args) => {
				return new UnregisteredError(...args);
			},
		},
	});

	const aggregate: number[] = [];

	// wait 10ms
	await new Promise((resolve) => setTimeout(resolve, 10));

	const err = await waitError(
		(async () => {
			for await (const value of result.asyncIterable) {
				aggregate.push(value);
			}
		})(),
		MyCustomError,
	);
	expect(err.message).toEqual("error in async iterable");
	expect(aggregate).toEqual([0, 1]);
});

test("stringify and parse async values with errors", async () => {
	class MyCustomError extends Error {
		constructor(message: string) {
			super(message);
			this.name = "MyCustomError";
		}
	}

	class UnregisteredError extends Error {
		constructor(cause: unknown) {
			const message = cause instanceof Error ? cause.message : String(cause);
			super(message, { cause });
			this.name = "UnregisteredError";
		}
	}

	const source = {
		asyncIterable: (async function* () {
			await new Promise((resolve) => setTimeout(resolve, 0));
			yield -0;
			throw new MyCustomError("error in async iterable");
		})(),
		promise: (async () => {
			await new Promise((resolve) => setTimeout(resolve, 0));
			throw new MyCustomError("error in promise");
		})(),
		unknownErrorDoesNotBlockStream: (async () => {
			await new Promise((resolve) => setTimeout(resolve, 0));
			throw new Error("unknown error"); // <-- this is not handled by the reviver, but coerceError is provided
		})(),
	};

	const iterable = stringifyAsync(source, {
		coerceError: (error) => {
			return new UnregisteredError(error);
		},
		reducers: {
			MyCustomError: (value) => {
				if (value instanceof MyCustomError) {
					return value.message;
				}
				return false;
			},
			UnregisteredError: (value) => {
				if (value instanceof UnregisteredError) {
					return [value.message];
				}
				return false;
			},
		},
	});

	const result = await unflattenAsync<typeof source>(withDebug(iterable), {
		revivers: {
			MyCustomError: (value) => {
				return new MyCustomError(value as string);
			},
			UnregisteredError: (...args) => {
				return new UnregisteredError(...args);
			},
		},
	});

	{
		const err = await waitError(
			result.unknownErrorDoesNotBlockStream,
			UnregisteredError,
		);
		expect(err).toMatchInlineSnapshot(`[UnregisteredError: unknown error]`);
	}
	{
		const err = await waitError(result.promise, MyCustomError);
		expect(err).toMatchInlineSnapshot(`[MyCustomError: error in promise]`);
	}
	{
		const aggregate: number[] = [];

		await waitError(async () => {
			for await (const value of result.asyncIterable) {
				aggregate.push(value);
			}
		}, MyCustomError);

		expect(aggregate).toEqual([-0]);
	}
});

test("request/response-like readable streams", async () => {
	const source = {
		asyncIterable: (async function* () {
			yield -0;
			yield 1;
			yield 2;
			return "returned async iterable";
		})(),
		promise: (async () => {
			return "resolved promise";
		})(),
	};
	const responseBodyStream = readableStreamFrom(
		stringifyAsync(source),
	).pipeThrough(new TextEncoderStream());

	const result = await unflattenAsync<typeof source>(
		(async function* () {
			const iterable = asyncIterableFrom(
				responseBodyStream.pipeThrough(new TextDecoderStream()),
			);

			let lineAggregate = "";
			for await (const chunk of iterable) {
				lineAggregate += chunk;
				const parts = lineAggregate.split("\n");
				lineAggregate = parts.pop() ?? "";
				for (const part of parts) {
					yield part;
				}
			}
		})(),
	);

	expect(await result.promise).toEqual("resolved promise");

	const aggregate = [];
	const iterator = result.asyncIterable[Symbol.asyncIterator]();
	// eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
	while (true) {
		const next = await iterator.next();
		if (next.done) {
			expect(next.value).toEqual("returned async iterable");
			break;
		}
		aggregate.push(next.value);
	}

	expect(aggregate).toEqual([-0, 1, 2]);
});

test("stringify and unflatten ReadableStream", async () => {
	const source = {
		stream: new ReadableStream<string>({
			async pull(controller) {
				controller.enqueue("hello");
				controller.enqueue("world");
				controller.close();
			},
		}),
	};

	const iterable = stringifyAsync(source);
	const result = await unflattenAsync<typeof source>(withDebug(iterable));

	expect(result.stream).toBeInstanceOf(ReadableStream);

	const reader = result.stream.getReader();
	const chunks: string[] = [];

	// eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
	while (true) {
		const res = await reader.read();

		if (res.done) {
			expect(res.value).toBeUndefined();
			break;
		}
		chunks.push(res.value);
	}

	expect(chunks).toEqual(["hello", "world"]);
});
