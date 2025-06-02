import http from "node:http";
import { AddressInfo } from "node:net";
import { expect, test } from "vitest";

import { stringifyAsync, unflattenAsync } from "./async.js";
import { aggregateAsyncIterable } from "./testUtils.js";

type Constructor<T extends object = object> = new (...args: any[]) => T;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

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
	const source = () => ({
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
	});
	type Source = ReturnType<typeof source>;
	const iterable = stringifyAsync(source());

	const result = await unflattenAsync<Source>(withDebug(iterable));

	expect(await result.promise).toEqual("resolved promise");

	const aggregate = await aggregateAsyncIterable(result.asyncIterable);

	expect(aggregate.ok).toBe(true);
	expect(aggregate.items).toEqual([-0, 1, 2]);
	expect(aggregate.return).toEqual("returned async iterable");
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

	const source = () => ({
		asyncIterable: (async function* () {
			yield 0;
			yield 1;
			throw new MyCustomError("error in async iterable");
		})(),
	});
	type Source = ReturnType<typeof source>;

	const iterable = stringifyAsync(source(), {
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

	const result = await unflattenAsync<Source>(iterable, {
		revivers: {
			MyCustomError: (value) => {
				return new MyCustomError(value as string);
			},
			UnregisteredError: (...args) => {
				return new UnregisteredError(...args);
			},
		},
	});

	const aggregate = await aggregateAsyncIterable(result.asyncIterable);

	expect(aggregate.ok).toBe(false);
	expect(aggregate.error).toBeInstanceOf(MyCustomError);
	expect(aggregate.items).toEqual([0, 1]);
	expect(aggregate.return).toBeUndefined();
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

	const source = () => ({
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
	});
	type Source = ReturnType<typeof source>;

	const iterable = stringifyAsync(source(), {
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

	const result = await unflattenAsync<Source>(withDebug(iterable), {
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
		const aggregate = await aggregateAsyncIterable(result.asyncIterable);

		expect(aggregate.ok).toBe(false);

		expect(aggregate.error).toBeInstanceOf(MyCustomError);

		expect(aggregate.items).toEqual([-0]);
	}
});

test("request/response-like readable streams", async () => {
	const source = () => ({
		asyncIterable: (async function* () {
			yield -0;
			yield 1;
			yield 2;
			return "returned async iterable";
		})(),
		promise: (async () => {
			return "resolved promise";
		})(),
	});
	type Source = ReturnType<typeof source>;
	const responseBodyStream = readableStreamFrom(
		stringifyAsync(source()),
	).pipeThrough(new TextEncoderStream());

	const result = await unflattenAsync<Source>(
		responseBodyStream.pipeThrough(new TextDecoderStream()),
	);

	expect(await result.promise).toEqual("resolved promise");

	const aggregate = await aggregateAsyncIterable(result.asyncIterable);

	expect(aggregate.ok).toBe(true);
	expect(aggregate.items).toEqual([-0, 1, 2]);
	expect(aggregate.return).toEqual("returned async iterable");
});

test("stringify and unflatten ReadableStream", async () => {
	const source = () => ({
		stream: new ReadableStream<string>({
			async pull(controller) {
				controller.enqueue("hello");
				controller.enqueue("world");
				controller.close();
			},
		}),
	});
	type Source = ReturnType<typeof source>;

	const iterable = stringifyAsync(source());
	const result = await unflattenAsync<Source>(withDebug(iterable));

	expect(result.stream).toBeInstanceOf(ReadableStream);

	const aggregate = await aggregateAsyncIterable(result.stream);

	expect(aggregate.ok).toBe(true);
	expect(aggregate.items).toEqual(["hello", "world"]);
	expect(aggregate.return).toBeUndefined();
});

function serverResource(
	handler: (req: http.IncomingMessage, res: http.ServerResponse) => void,
) {
	const server = http.createServer(handler);
	server.listen(0);
	const port = (server.address() as AddressInfo).port;

	const url = `http://localhost:${String(port)}`;

	return {
		[Symbol.dispose]() {
			server.close();
		},
		url,
	};
}

test("async over the wire", async () => {
	const source = () => ({
		asyncIterable: (async function* () {
			yield "hello";
			await sleep(1);
			yield "world";
		})(),
	});
	type Source = ReturnType<typeof source>;
	using server = serverResource((req, res) => {
		(async () => {
			for await (const chunk of stringifyAsync(source())) {
				res.write(chunk);
			}
			res.end();
		})().catch(console.error);
	});

	{
		const response = await fetch(server.url);

		expect(response.ok).toBe(true);

		const bodyTextStream = response.body!.pipeThrough(new TextDecoderStream());

		const chunks: string[] = [];
		for await (const chunk of bodyTextStream) {
			chunks.push(chunk);
		}

		const conc = chunks.join("").split("\n");

		expect(conc).toMatchInlineSnapshot(`
			[
			  "[{"asyncIterable":1},["AsyncIterable",2],1]",
			  "[1,0,["hello"]]",
			  "[1,0,["world"]]",
			  "[1,2,-1]",
			  "",
			]
		`);
	}
	{
		const response = await fetch(server.url);

		expect(response.ok).toBe(true);

		const bodyTextStream = response.body!.pipeThrough(new TextDecoderStream());

		const result = await unflattenAsync<Source>(bodyTextStream);

		const aggregate = await aggregateAsyncIterable(result.asyncIterable);

		expect(aggregate.ok).toBe(true);
		expect(aggregate.items).toEqual(["hello", "world"]);
		expect(aggregate.return).toBeUndefined();
	}
});

test("dedupe", async () => {
	const promise = Promise.resolve("1");

	const source = () => ({
		promise1: promise,
		promise2: promise,
	});
	type Source = ReturnType<typeof source>;

	const iterable = stringifyAsync(source());
	const result = await unflattenAsync<Source>(iterable);

	expect(result.promise1).toBe(result.promise2);
});

test.fails("todo(?) - referential integrity across chunks", async () => {
	const user = {
		id: 1,
	};

	const source = () => ({
		asyncIterable: (async function* () {
			yield user;
			yield user;
		})(),
	});
	type Source = ReturnType<typeof source>;

	const result = await unflattenAsync<Source>(stringifyAsync(source()));

	const aggregate = await aggregateAsyncIterable(result.asyncIterable);

	expect(aggregate.ok).toBe(true);

	expect(aggregate.return).toBeUndefined();

	expect(aggregate.items[0]).toBe(aggregate.items[1]);
});
