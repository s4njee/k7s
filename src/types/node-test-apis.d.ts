/**
 * Minimal ambient declarations for the handful of Node APIs used by *tests*.
 *
 * Deliberately not `@types/node`. The frontend is browser code — tsconfig's `lib`
 * is ES2022 + DOM on purpose — and installing the full Node surface would mean
 * application code could reach for `fs`, `process`, or `Buffer` and still
 * typecheck clean. Declaring only what's actually used keeps that boundary
 * enforced by the compiler rather than by convention.
 *
 * Currently used by src/lib/theme.test.ts, which reads tokens.css as text to
 * check the two palettes against each other. Vitest stubs CSS imports to an empty
 * string (`test.css` is off), so `?raw` isn't an option and the file has to be
 * read from disk.
 */

declare module "node:fs" {
  export function readFileSync(path: string, encoding: "utf8"): string;
}

declare module "node:path" {
  export function resolve(...parts: string[]): string;
}
