import { expect, test } from "vitest";

import { createDeferred } from "./createDeferred.js";
import { mergeAsyncIterables } from "./mergeAsyncIterable.js";

async function asyncIterableToArray<T>(iterable: AsyncIterable<T>) {
	const results: T[] = [];

	for await (const value of iterable) {
		results.push(value);
	}

	return results;
}

test("basic", async () => {
	type Type = number | string;
	const merged = mergeAsyncIterables<Type>();

	merged.add(
		(async function* () {
			yield "a";
			yield "b";
			yield "c";
		})(),
	);
	merged.add(
		(async function* () {
			yield 1;
			yield 2;
			yield 3;
		})(),
	);

	const aggregate = await asyncIterableToArray(merged);

	expect(aggregate).toEqual(["a", 1, "b", 2, "c", 3]);
});

test("while iterating", async () => {
	type Type = number | string;
	const merged = mergeAsyncIterables<Type>();

	merged.add(
		(async function* () {
			yield "a";
			yield "b";
			yield "c";
		})(),
	);

	const deferred = createDeferred();
	const aggregatePromise = asyncIterableToArray(
		(async function* () {
			for await (const value of merged) {
				if (value === "b") {
					deferred.resolve();
				}
				yield value;
			}
		})(),
	);

	await deferred.promise;

	merged.add(
		(async function* () {
			yield 1;
			yield 2;
			yield 3;
		})(),
	);

	const aggregate = await aggregatePromise;

	expect(aggregate).toEqual([
		//
		"a",
		"b",
		1,
		"c",
		2,
		3,
	]);
});
