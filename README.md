# Groundstate

Reactive browser runtime that gives agents durable semantic state across page mutations, rerenders, and navigation.

Instead of treating every page load as a blank slate, Groundstate extracts semantic entities from the DOM, tracks them through a versioned state graph, and validates pre/postconditions so agents can plan through UI churn rather than retrying from scratch.

## How it works

1. **Extract** -- observe a page and pull structured entities (tables, forms, buttons, links) from raw DOM
2. **Graph** -- upsert entities into a versioned state graph that survives mutations, rerenders, and content replacement
3. **Validate** -- check pre/postconditions against the graph to know whether an action is still valid or needs replanning
4. **Trace** -- record every observation, mutation, action, and recovery for replay and evaluation

The core engine is Rust, exposed to Node.js via NAPI-rs. TypeScript packages provide the runtime, session management, and evaluation framework.

## Project structure

```
crates/                Rust workspace
  gs-types/            Shared types: entities, conditions, traces, actions
  gs-graph/            StateGraph -- entity upsert, versioning, invalidation
  gs-extract/          ExtractorPipeline -- entities from raw observations
  gs-validate/         Pre/postcondition evaluation against graph state
  gs-trace/            Execution trace recording
  gs-observe/          Page snapshot capture (DOM, a11y)
  gs-transport/        CDP transport layer
  gs-execute/          Action execution with plugin system
  gs-napi/             NAPI-rs bindings (Node.js native module)
  gs-demo/             Full vertical slice demo

packages/              TypeScript workspace (pnpm)
  napi/                @groundstate/napi -- npm wrapper for gs-napi
  core/                @groundstate/core -- runtime, session, entity bridge
  eval/                @groundstate/eval -- metrics, assertions, golden traces
  suite-b/             Semantic benchmark -- 29 tests across 3 mutation buckets
  agent-test/          Agent SDK integration tests
  inspector/           Next.js UI for inspecting runtime state

fixtures/              HTML test pages for benchmark scenarios
```

## Prerequisites

- **Node.js 22+** (pinned in `.node-version`)
- **pnpm 10+**
- **Rust stable** (pinned in `rust-toolchain.toml`, includes clippy + rustfmt)
- **Chrome** (for semantic benchmarks)

## Getting started

```sh
git clone https://github.com/tylergibbs1/groundstate.git
cd groundstate
pnpm install --frozen-lockfile
pnpm build                        # Rust -> NAPI -> TypeScript
pnpm test                         # unit tests (Rust + TS + eval)
```

Or with [just](https://github.com/casey/just):

```sh
just setup                        # install + full build
just test                         # all unit tests
just bench                        # semantic benchmark (needs Chrome)
just ci                           # full CI pipeline locally
```

## Semantic benchmark

The benchmark runs 29 test cases across three buckets of DOM mutation severity:

| Bucket | What it tests | Examples |
|--------|---------------|---------|
| **A -- Stable** | Extraction correctness on static pages | Invoice filtering, sort validation, search results, docs page, nested table isolation, noisy DOM, ARIA tab state, row action context |
| **B -- Benign churn** | Entity identity survives harmless mutations | Rerenders, row reorder, lazy load, pagination, column changes, ID regeneration, async updates, visibility filter, content-keyed shuffle, nested subtable expand, ARIA accordion toggle |
| **C -- Real disruption** | Detection, replanning, and recovery | Validation errors, auth timeout, disabled buttons, row removal, fieldset disabled propagation |

```sh
pnpm test:semantic                # headless
pnpm test:semantic -- --watch     # visible browser
pnpm test:semantic -- --verbose   # per-test metrics
```

After a run, open `packages/suite-b/artifacts/semantic-benchmark/report.html` for a visual report with screenshots and per-test postcondition results.

## Development

```sh
just check          # cargo check + clippy (no build artifacts)
just fmt            # cargo fmt
just test           # Rust + TS + eval tests
just bench          # semantic benchmark
just bench-watch    # benchmark with visible Chrome
just demo           # full vertical slice (launches Chrome)
just inspector      # Next.js inspector dev server
```

All scripts are also available via `pnpm` -- see `package.json`.

## License

MIT
