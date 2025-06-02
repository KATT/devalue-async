import { createDeferred } from "./createDeferred.js";

type ManagedIterator<TYield, TReturn> = ReturnType<
	typeof createManagedIterator<TYield, TReturn>
>;
type ManagedIteratorResult<TYield, TReturn> =
	| { error: unknown; status: "error" }
	| { status: "return"; value: TReturn }
	| { status: "yield"; value: TYield };
interface MergedAsyncIterables<TYield>
	extends AsyncIterable<TYield, void, unknown> {
	add(iterable: AsyncIterable<TYield>): void;
}

function createManagedIterator<TYield, TReturn>(
	iterable: AsyncIterable<TYield, TReturn>,
	onResult: (result: ManagedIteratorResult<TYield, TReturn>) => void,
) {
	const iterator = iterable[Symbol.asyncIterator]();
	let iterating = false;

	function cleanup() {
		iterating = false;
		onResult = () => {
			// noop
		};
	}

	function pull() {
		if (iterating) {
			return;
		}
		iterating = true;

		const next = iterator.next();
		next
			.then((result) => {
				if (result.done) {
					iterating = false;
					onResult({ status: "return", value: result.value });
					cleanup();
					return;
				}
				iterating = false;
				onResult({ status: "yield", value: result.value });
			})
			.catch((cause: unknown) => {
				onResult({ error: cause, status: "error" });
				cleanup();
			});
	}

	return {
		destroy: async () => {
			cleanup();
			await iterator.return?.();
		},
		pull,
	};
}

/**
 * Creates a new async iterable that merges multiple async iterables into a single stream.
 * Values from the input iterables are yielded in the order they resolve, similar to Promise.race().
 *
 * New iterables can be added dynamically using the returned {@link MergedAsyncIterables.add} method, even after iteration has started.
 *
 * If any of the input iterables throws an error, that error will be propagated through the merged stream.
 * Other iterables will not continue to be processed.
 * @template TYield The type of values yielded by the input iterables
 */
export function mergeAsyncIterables<TYield>(): MergedAsyncIterables<TYield> {
	let iterating = false;
	let flushSignal = createDeferred();

	/**
	 * used while {@link iterating} is `false`
	 */
	const iterables: AsyncIterable<TYield, void, unknown>[] = [];

	/**
	 * used while {@link iterating} is `true`
	 */
	const iterators = new Set<ManagedIterator<TYield, void>>();

	const buffer: [
		iterator: ManagedIterator<TYield, void>,
		result: Exclude<ManagedIteratorResult<TYield, void>, { status: "return" }>,
	][] = [];

	function initIterable(iterable: AsyncIterable<TYield, void, unknown>) {
		const iterator = createManagedIterator(iterable, (result) => {
			switch (result.status) {
				case "error":
					buffer.push([iterator, result]);
					iterators.delete(iterator);
					break;
				case "return":
					iterators.delete(iterator);
					break;
				case "yield":
					buffer.push([iterator, result]);
					break;
			}
			flushSignal.resolve();
		});
		iterators.add(iterator);
		iterator.pull();
	}

	return {
		add(iterable: AsyncIterable<TYield, void, unknown>) {
			if (iterating) {
				initIterable(iterable);
			} else {
				iterables.push(iterable);
			}
		},

		async *[Symbol.asyncIterator]() {
			if (iterating) {
				throw new Error("Cannot iterate twice");
			}
			iterating = true;

			try {
				let iterable;
				while ((iterable = iterables.shift())) {
					initIterable(iterable);
				}

				while (iterators.size > 0) {
					await flushSignal.promise;

					let chunk;
					while ((chunk = buffer.shift())) {
						const [iterator, result] = chunk;

						switch (result.status) {
							case "yield":
								yield result.value;
								iterator.pull();
								break;
							case "error":
								throw result.error;
						}
					}
					flushSignal = createDeferred();
				}
			} finally {
				iterating = false;

				const errors: unknown[] = [];
				await Promise.all(
					Array.from(iterators.values()).map(async (it) => {
						try {
							await it.destroy();
						} catch (cause) {
							errors.push(cause);
						}
					}),
				);
				buffer.length = 0;
				iterators.clear();
				flushSignal.resolve();

				if (errors.length > 0) {
					// eslint-disable-next-line no-unsafe-finally
					throw new AggregateError(errors);
				}
			}
		},
	};
}
