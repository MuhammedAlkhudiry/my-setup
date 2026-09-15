---
name: react
description: React implementation and review preferences.
---

Follow established project patterns when they give more specific guidance.

- Order component code as hooks grouped by purpose, calculated values, handlers, conditional returns, then JSX.
- Use a query library for server data; never fetch directly inside components.
- Treat the query cache as the source of truth; do not mirror it in local state.
- Select only the required store state, using shallow equality where appropriate.
- Access global stores through hooks rather than passing their state through props.
- Keep props few and prefer complete objects over passing their fields separately.
- Use lazy loading only when there is a specific reason to load code separately or later.

## React Native

- Assume React Native projects target native platforms only; support web only when the project explicitly declares it as a target.
- Keep mobile JavaScript compatible with the project's Hermes runtime.
