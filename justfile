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

# Run generalization benchmark suite (cross-fixture anti-overfitting checks)
bench-generalization:
    cd packages/suite-b && pnpm test:generalization

# Run generalization benchmark with visible browser
bench-generalization-watch:
    cd packages/suite-b && pnpm test:generalization:watch

# Run generalization benchmark and open HTML report
bench-generalization-open:
    cd packages/suite-b && pnpm test:generalization:open

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

# Launch live browser demo with overlay on a real URL (default: Hacker News)
demo-live url="https://news.ycombinator.com" goal="Extract all story titles, find the top 3 by points, and click into the highest-scored story.":
    cd packages/agent-test && npx tsx src/groundstate-anthropic.ts --visible --url={{url}} --goal="{{goal}}"

# Build everything then launch live demo
demo-live-full url="https://news.ycombinator.com" goal="Extract all story titles, find the top 3 by points, and click into the highest-scored story.":
    just build
    just demo-live "{{url}}" "{{goal}}"

# Run the agent SDK mock test (requires ANTHROPIC_API_KEY)
agent-test:
    cd packages/agent-test && npx tsx src/agent-mock.ts

# Run Groundstate vs Stagehand live browsing benchmark
vs-stagehand:
    cd packages/vs-stagehand && pnpm start

# Run the inspector dev server
inspector:
    cd packages/inspector && pnpm dev
