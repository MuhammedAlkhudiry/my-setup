---
name: react
description: Use when writing or reviewing React or React Native code, for component order, server data, store access, and props preferences.
---

When the project already uses a consistent pattern, follow it instead.

- Order component code: hooks grouped by purpose, calculated values, handlers, early returns, then JSX.
- In client components, load server data through the project's query library, not direct fetches. Treat its cache as the source of truth; do not
  copy it into local state.
- Read global store state through a selector hook in the component that needs it, not through props. Select only the fields it uses; use
  `useShallow` when the selector returns an object or array.
- Pass a complete object as one prop instead of passing its fields separately.
- When the project uses React Compiler, do not add `useMemo`, `useCallback`, or `memo` by habit.
- When the project defines a `react:doctor` task, run it after React changes and fix what it reports before finishing. Suppress a finding
  only with an inline `react-doctor-disable-next-line` comment that states why the fix would be wrong.

## TanStack Query

- Generate API types and fetch functions from the backend's OpenAPI spec and commit them; CI fails when they drift. Do not use generated
  hooks or keys.
- Keep each feature's queries and mutations in `<feature>.queries.ts` as `queryOptions` and `mutationOptions` factories with hierarchical
  keys. Components and cache reads use the factories, never inline keys.
- Declare what a mutation invalidates in `meta.invalidates`, and handle it in one global `MutationCache` handler.
- In server-rendered pages, such as Inertia, take page data from page props.

## React Native

- Target native platforms only, unless the project declares web as a target.
- Before using newer JavaScript or `Intl` APIs, check that Hermes supports them.
