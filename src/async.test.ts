/* eslint-disable @typescript-eslint/no-unnecessary-condition */
import { expect, test } from "vitest";

import { parseAsync, stringifyAsync } from "./async.js";

test("stringify and parse async values", async () => {
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

	async function* withDebug<T>(iterable: AsyncIterable<T>) {
		for await (const value of iterable) {
			yield value;
			// console.log('yielding', value)
		}
	}

	const result = await parseAsync<typeof source>(withDebug(iterable));

	expect(await result.promise).toBe("resolved promise");

	const aggregate = [];
	const iterator = result.asyncIterable[Symbol.asyncIterator]();
	while (true) {
		const next = await iterator.next();
		if (next.done) {
			expect(next.value).toBe("returned async iterable");
			break;
		}
		aggregate.push(next.value);
	}

	expect(aggregate).toEqual([-0, 1, 2]);
});

/* eslint-enable @typescript-eslint/no-unnecessary-condition */
