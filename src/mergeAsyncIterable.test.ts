import { expect, test } from "vitest";

import { createDeferred } from "./createDeferred.js";
import { mergeAsyncIterables } from "./mergeAsyncIterable.js";
import { aggregateAsyncIterable } from "./testUtils.js";

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

	const aggregate = await aggregateAsyncIterable(merged);

	expect(aggregate.ok).toBe(true);
	expect(aggregate.items).toEqual(["a", 1, "b", 2, "c", 3]);
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
	const aggregatePromise = aggregateAsyncIterable(
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

	expect(aggregate.ok).toBe(true);
	expect(aggregate.items).toEqual([
		//
		"a",
		"b",
		1,
		"c",
		2,
		3,
	]);
	expect(aggregate.return).toBeUndefined();
});
