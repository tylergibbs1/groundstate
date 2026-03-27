# Groundstate — reactive browser runtime
# Run `just` with no arguments to see all recipes.

default:
    @just --list --unsorted

# ── Setup ──────────────────────────────────────────────

# Install all dependencies and build the workspace
setup:
    pnpm install --frozen-lockfile
    just build

# ── Build ──────────────────────────────────────────────

# Build everything (Rust → NAPI → TypeScript)
build: build-rust build-ts

# Build Rust workspace
build-rust:
    cargo build --workspace

# Build TypeScript packages (depends on Rust build for NAPI bindings)
build-ts:
    cd packages/napi && pnpm build
    cd packages/core && pnpm build

# ── Test ───────────────────────────────────────────────

# Run all tests (Rust + TypeScript + eval)
test: test-rust test-ts test-eval

# Run Rust tests
test-rust:
    cargo test --workspace

# Run TypeScript unit tests
test-ts:
    cd packages/core && pnpm test

# Run eval framework tests
test-eval:
    cd packages/eval && pnpm test

# Run semantic benchmark suite (requires Chrome)
bench:
    cd packages/suite-b && pnpm test:semantic

# Run semantic benchmark with visible browser
bench-watch:
    cd packages/suite-b && pnpm test:semantic:watch

# Run semantic benchmark and open HTML report
bench-open:
    cd packages/suite-b && pnpm test:semantic:open

# Run everything CI runs
ci: check build test bench

# ── Lint & Format ─────────────────────────────────────

# Type-check and lint (no build artifacts produced)
check:
    cargo check --workspace
    cargo clippy --workspace -- -D warnings

# Format all code
fmt:
    cargo fmt --all

# Format + check
lint: fmt check

# ── Run ────────────────────────────────────────────────

# Run the Rust demo (launches Chrome, full vertical slice)
demo:
    cargo run -p gs-demo

# Run the agent SDK mock test (requires ANTHROPIC_API_KEY)
agent-test:
    cd packages/agent-test && npx tsx src/agent-mock.ts

# Run the inspector dev server
inspector:
    cd packages/inspector && pnpm dev
