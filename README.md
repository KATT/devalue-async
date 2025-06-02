<h1 align="center">Devalue Async</h1>

<p align="center">Extension of the great <a href="https://github.com/Rich-Harris/devalue">devalue</a> package with ability to handle async values</p>

<p align="center">
	<!-- prettier-ignore-start -->
	<!-- ALL-CONTRIBUTORS-BADGE:START - Do not remove or modify this section -->
	<a href="#contributors" target="_blank"><img alt="👪 All Contributors: 1" src="https://img.shields.io/badge/%F0%9F%91%AA_all_contributors-1-21bb42.svg" /></a>
<!-- ALL-CONTRIBUTORS-BADGE:END -->
	<!-- prettier-ignore-end -->
	<a href="https://github.com/KATT/devalue-async/blob/main/.github/CODE_OF_CONDUCT.md" target="_blank"><img alt="🤝 Code of Conduct: Kept" src="https://img.shields.io/badge/%F0%9F%A4%9D_code_of_conduct-kept-21bb42" /></a>
	<a href="https://codecov.io/gh/KATT/devalue-async" target="_blank"><img alt="🧪 Coverage" src="https://img.shields.io/codecov/c/github/KATT/devalue-async?label=%F0%9F%A7%AA%20coverage" /></a>
	<a href="https://github.com/KATT/devalue-async/blob/main/LICENSE.md" target="_blank"><img alt="📝 License: MIT" src="https://img.shields.io/badge/%F0%9F%93%9D_license-MIT-21bb42.svg" /></a>
	<a href="http://npmjs.com/package/devalue-async" target="_blank"><img alt="📦 npm version" src="https://img.shields.io/npm/v/devalue-async?color=21bb42&label=%F0%9F%93%A6%20npm" /></a>
	<img alt="💪 TypeScript: Strict" src="https://img.shields.io/badge/%F0%9F%92%AA_typescript-strict-21bb42.svg" />
</p>

## About

Wrapper around [devalue](https://github.com/Rich-Harris/devalue) with ability to serialize and deserialize async values.

- **Promises** (both resolved and rejected)
- **Async Iterables** (async generators, async iterators)
- **ReadableStreams** (Web Streams API)
- **All the goodness of devalue**: cyclical references, `undefined`, `Infinity`, `NaN`, `-0`, regular expressions, dates, `Map` and `Set`, `BigInt`, custom types, etc.

## Installation

```shell
npm install devalue devalue-async
```

## Usage

There are two main functions: `stringifyAsync` and `parseAsync`.

### Basic Example

```ts
import { parseAsync, stringifyAsync } from "devalue-async";

const source = {
	asyncIterable: (async function* () {
		yield 1;
		yield 2;
		yield 3;
		return "done!";
	})(),
	promise: Promise.resolve("Hello world"),
};

// Stringify to an async iterable of strings
const serialized = stringifyAsync(source);

// Reconstruct the original structure
const result = await parseAsync<typeof source>(serialized);

console.log(await result.promise); // 'Hello world'

// Iterate through the async iterable
for await (const value of result.asyncIterable) {
	console.log(value); // 1, 2, 3
}
```

### Working with ReadableStreams

```ts
import { parseAsync, stringifyAsync } from "devalue-async";

const source = {
	stream: new ReadableStream({
		start(controller) {
			controller.enqueue("chunk 1");
			controller.enqueue("chunk 2");
			controller.close();
		},
	}),
};

const serialized = stringifyAsync(source);
const result = await parseAsync<typeof source>(serialized);

const reader = result.stream.getReader();
while (true) {
	const res = await reader.read();
	if (res.done) {
		break;
	}
	console.log(res.value); // 'chunk 1', 'chunk 2'
}
```

### Error Handling

Devalue Async can handle errors in async operations:

```ts
import { parseAsync, stringifyAsync } from "devalue-async";

class CustomError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "CustomError";
	}
}

const source = {
	asyncIterable: (async function* () {
		yield 1;
		yield 2;
		throw new CustomError("Async error");
	})(),
	promise: Promise.reject(new CustomError("Something went wrong")),
};

const serialized = stringifyAsync(source, {
	reducers: {
		CustomError: (error) => error instanceof CustomError && error.message,
	},
});

const result = await parseAsync<typeof source>(serialized, {
	revivers: {
		CustomError: (message) => new CustomError(message),
	},
});

try {
	await result.promise;
} catch (error) {
	console.log(error instanceof CustomError); // true
	console.log(error.message); // 'Something went wrong'
}
```

### Coercing Unknown Errors

When dealing with errors that don't have registered reducers, use `coerceError`:

```ts
class GenericError extends Error {
	constructor(cause: unknown) {
		super("Generic error occurred", { cause });
		console.error("Encountered a unregistered error:", cause);
		this.name = "GenericError";
	}
}

const source = {
	asyncIterable: (async function* () {
		yield 1;
		yield 2;
		throw new Error("Generic error");
	})(),
};

const serialized = stringifyAsync(source, {
	coerceError: (error) => new GenericError(error),
	reducers: {
		GenericError: (error) => {
			if (error instanceof GenericError) {
				// Don't stringify the error
				return null;
			}
			return false;
		},
	},
});

const result = await parseAsync<typeof source>(serialized, {
	revivers: {
		GenericError: () => new Error("Unknown error"),
	},
});
```

### Streaming Over HTTP

```ts
// Server
export type ApiResponse = ReturnType<typeof getData>;

function getApiResponse() {
	return {
		metrics: getMetricsStream(), // ReadableStream
		notifications: getNotificationStream(), // async iterable
		user: getUserData(), // promise
	};
}

app.get("/api/data", async (req, res) => {
	const data = getApiResponse();

	res.setHeader("Content-Type", "text/plain");
	for await (const chunk of stringifyAsync(data)) {
		res.write(chunk);
	}
	res.end();
});
```

```ts
// Client
import type { ApiResponse } from "./server";

const response = await fetch("/api/data");
const responseBody = response.body!.pipeThrough(new TextDecoderStream());

const result = await parseAsync<ApiResponse>(responseBody);

console.log(result.user);
for await (const notification of result.notifications) {
	console.log(notification);
}
```

### Custom Types

Like devalue, you can handle custom types with reducers and revivers:

```ts
class Vector {
	constructor(
		public x: number,
		public y: number,
	) {}
}

const source = {
	vectors: (async function* () {
		yield new Vector(1, 2);
		yield new Vector(3, 4);
	})(),
};
const iterable = stringifyAsync(source, {
	reducers: {
		Vector: (value) => value instanceof Vector && [value.x, value.y],
	},
});

const result = await parseAsync<typeof source>(iterable, {
	revivers: {
		Vector: (value) => {
			const [x, y] = value as [number, number];
			return new Vector(x, y);
		},
	},
});

for await (const vector of result.vectors) {
	console.log(vector); // Vector { x: 1, y: 2 }, Vector { x: 3, y: 4 }
}
```

## API Reference

### `stringifyAsync(value, options?)`

Serializes a value containing async elements to an async iterable of strings.

**Parameters:**

- `value`: The value to serialize
- `options.reducers?`: Record of custom type reducers (same as devalue)
- `options.coerceError?`: Function to handle unregistered errors

**Returns:** `AsyncIterable<string>`

### `parseAsync(iterable, options?)`

Reconstructs a value from a serialized async iterable.

**Parameters:**

- `iterable`: `AsyncIterable<string>` from `stringifyAsync`
- `options.revivers?`: Record of custom type revivers (same as devalue)

**Returns:** `Promise<T>`

## Development

See [`.github/CONTRIBUTING.md`](./.github/CONTRIBUTING.md), then [`.github/DEVELOPMENT.md`](./.github/DEVELOPMENT.md).
Thanks! 💖

## Contributors

<!-- spellchecker: disable -->
<!-- ALL-CONTRIBUTORS-LIST:START - Do not remove or modify this section -->
<!-- prettier-ignore-start -->
<!-- markdownlint-disable -->
<table>
  <tbody>
    <tr>
      <td align="center" valign="top" width="14.28%"><a href="https://katt.dev"><img src="https://avatars.githubusercontent.com/u/459267?v=4?s=100" width="100px;" alt="Alex / KATT"/><br /><sub><b>Alex / KATT</b></sub></a><br /><a href="https://github.com/JoshuaKGoldberg/create-typescript-app/commits?author=KATT" title="Code">💻</a>  <a href="https://github.com/JoshuaKGoldberg/create-typescript-app/commits?author=KATT" title="Documentation">📖</a> <a href="#ideas-KATT" title="Ideas, Planning, & Feedback">🤔</a> <a href="#infra-KATT" title="Infrastructure (Hosting, Build-Tools, etc)">🚇</a> <a href="#maintenance-KATT" title="Maintenance">🚧</a>  <a href="#tool-KATT" title="Tools">🔧</a></td>
    </tr>
  </tbody>
</table>

<!-- markdownlint-restore -->
<!-- prettier-ignore-end -->

<!-- ALL-CONTRIBUTORS-LIST:END -->
<!-- spellchecker: enable -->

<!-- You can remove this notice if you don't want it 🙂 no worries! -->

> 💝 This package was templated with [`create-typescript-app`](https://github.com/JoshuaKGoldberg/create-typescript-app) using the [Bingo framework](https://create.bingo).
