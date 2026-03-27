# Groundstate build orchestration

default: check

# Check everything compiles
check:
    cargo check --workspace
    cargo clippy --workspace -- -D warnings

# Build the full stack
build: build-rust build-ts

# Build Rust workspace
build-rust:
    cargo build --workspace

# Build TypeScript packages (requires Rust build first)
build-ts: build-rust
    cd packages/napi && pnpm build
    cd packages/core && pnpm build

# Run all tests
test: test-rust test-ts

# Run Rust tests
test-rust:
    cargo test --workspace

# Run TypeScript tests
test-ts:
    cd packages/core && pnpm test

# Format Rust code
fmt:
    cargo fmt --all

# Run the Rust demo (launches Chrome, full vertical slice)
demo:
    cargo run -p gs-demo

# Run the Agent SDK mock test (requires ANTHROPIC_API_KEY)
agent-test:
    cd packages/agent-test && npx tsx src/agent-mock.ts

# Format and check
lint: fmt check
