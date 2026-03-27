# Groundstate

Reactive browser runtime — durable semantic state for browser agents.

## Architecture

```
crates/              Rust workspace (core engine)
  gs-types/          Shared types: entities, conditions, traces, actions
  gs-graph/          StateGraph — entity upsert, versioning, invalidation
  gs-extract/        ExtractorPipeline — entities from raw observations
  gs-validate/       Pre/postcondition evaluation against graph state
  gs-trace/          Execution trace recording
  gs-observe/        Page snapshot capture (DOM, a11y)
  gs-transport/      CDP transport layer
  gs-execute/        Action execution with plugin system
  gs-napi/           NAPI-rs bindings → Node.js native module
  gs-demo/           Full vertical slice demo (launches Chrome)

packages/            TypeScript workspace (pnpm)
  napi/              @groundstate/napi — wraps gs-napi as npm package
  core/              @groundstate/core — runtime, session, entities, bridge
  eval/              @groundstate/eval — metrics, assertions, golden traces
  suite-b/           Integration tests — CDP harness + semantic benchmark
  agent-test/        Agent SDK integration (requires ANTHROPIC_API_KEY)
  inspector/         Next.js UI for inspecting runtime state (separate app)

fixtures/            HTML test fixtures for benchmark scenarios
```

## Build order

Rust → NAPI native module → TypeScript packages. This is a hard dependency chain.

```
just setup           # install deps + full build
just build           # rebuild everything
just build-rust      # Rust only
just build-ts        # NAPI + TS only (requires Rust build)
```

## Test commands

```
just test            # Rust + TS unit tests + eval tests
just bench           # Semantic benchmark (requires Chrome)
just bench-watch     # Benchmark with visible browser
just ci              # Full CI pipeline locally
```

## Prerequisites

- Node.js 22+ (see .node-version)
- pnpm 10+
- Rust stable (see rust-toolchain.toml — includes clippy + rustfmt)
- Chrome (for suite-b semantic benchmarks)

## Conventions

- `cargo clippy -- -D warnings` must pass (zero warnings policy)
- `cargo fmt --all` before committing Rust changes
- TypeScript uses strict mode with `noUncheckedIndexedAccess`
- Tests live next to source in Rust (`_tests.rs` suffix), in `test/` dirs in TS packages
- Vitest for TS tests, `cargo test` for Rust
