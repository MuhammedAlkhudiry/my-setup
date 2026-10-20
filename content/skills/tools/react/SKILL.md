---
name: react
description: Use before editing or reviewing React or React Native code.
---

Follow consistent project patterns over these defaults.

- Order components: hooks grouped by purpose → calculated values → handlers → early returns → JSX.
- Load client-side server data through the project's query library. Use its cache directly; do not copy it into local state.
- Read global state in the consuming component through a selector, not props. Select only needed fields; use `useShallow` for object/array results.
- Pass objects as single props instead of separate fields.
- With React Compiler, avoid habitual `useMemo`, `useCallback`, and `memo`.
- If defined, run `react:doctor` after React changes. Fix findings; suppress only with `react-doctor-disable-next-line` explaining why the fix
  would be wrong.

## TanStack Query

- Generate and commit API types and fetch functions from OpenAPI; enforce drift checks in CI. Do not use generated hooks or keys.
- Keep `queryOptions`/`mutationOptions` factories with hierarchical keys in `<feature>.queries.ts`. Components and cache reads use these factories,
  never inline keys.
- Declare invalidations in `meta.invalidates`; handle them in one global `MutationCache` handler.
- Take server-rendered page data, such as Inertia data, from page props.

## React Native

- Target native platforms unless the project declares web support.
- Check Hermes support before using newer JavaScript or `Intl` APIs.
