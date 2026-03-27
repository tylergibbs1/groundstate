use std::path::PathBuf;
use std::process::{Command, Stdio};
use std::time::Duration;

use gs_execute::{execute_action, SessionState};
use gs_extract::actions::ActionDeriver;
use gs_transport::cdp::CdpTransport;
use gs_transport::BrowserTransport;
use gs_types::*;

const CHROME_PATHS: &[&str] = &[
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
    "/usr/bin/google-chrome",
    "/usr/bin/chromium-browser",
    "/usr/bin/chromium",
];

fn find_chrome() -> Option<PathBuf> {
    CHROME_PATHS
        .iter()
        .map(PathBuf::from)
        .find(|p| p.exists())
}

fn find_fixture() -> PathBuf {
    let mut path = std::env::current_dir().unwrap();
    // Walk up until we find the fixtures directory
    loop {
        let candidate = path.join("fixtures/invoices.html");
        if candidate.exists() {
            return candidate;
        }
        if !path.pop() {
            panic!("Could not find fixtures/invoices.html — run from the repo root");
        }
    }
}

#[tokio::main]
async fn main() {
    println!("╔══════════════════════════════════════════════╗");
    println!("║  Groundstate — Reactive Browser Runtime Demo ║");
    println!("╚══════════════════════════════════════════════╝");
    println!();

    // 1. Find Chrome
    let chrome_path = find_chrome().expect(
        "Chrome not found. Install Google Chrome or set CHROME_PATH env var.",
    );
    println!("→ Chrome: {}", chrome_path.display());

    // 2. Parse flags
    let args: Vec<String> = std::env::args().collect();
    let headless = !args.iter().any(|a| a == "--visible" || a == "--no-headless");

    // 3. Find fixture HTML
    let fixture_path = find_fixture();
    let file_url = format!("file://{}", fixture_path.display());
    println!("→ Fixture: {file_url}");

    // 4. Launch Chrome with remote debugging
    let debug_port = 9222;
    let mode = if headless { "headless" } else { "visible" };
    println!("→ Launching Chrome ({mode}, port {debug_port})...");

    let mut chrome_args = vec![
        format!("--remote-debugging-port={debug_port}"),
        "--no-first-run".to_string(),
        "--no-default-browser-check".to_string(),
        "--disable-extensions".to_string(),
        "--disable-background-networking".to_string(),
        format!("--user-data-dir=/tmp/gs-demo-{}", std::process::id()),
    ];
    if headless {
        chrome_args.insert(0, "--headless=new".to_string());
        chrome_args.push("--disable-gpu".to_string());
    } else {
        chrome_args.push("--window-size=1280,900".to_string());
    }

    let mut chrome = Command::new(&chrome_path)
        .args(&chrome_args)
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .expect("Failed to launch Chrome");

    // Give Chrome a moment to start (visible mode needs a bit longer)
    let startup_wait = if headless { 2 } else { 3 };
    tokio::time::sleep(Duration::from_secs(startup_wait)).await;

    // 4. Get the WebSocket debugger URL
    let ws_url = get_ws_url(debug_port).await;
    println!("→ Connected: {ws_url}");
    println!();

    // Run the demo — catch panics so we always kill Chrome
    let result = run_demo(&ws_url, &file_url).await;

    // 5. Kill Chrome
    let _ = chrome.kill();
    let _ = chrome.wait();

    // Clean up temp profile
    let _ = std::fs::remove_dir_all(format!("/tmp/gs-demo-{}", std::process::id()));

    if let Err(e) = result {
        eprintln!("\n✗ Demo failed: {e}");
        std::process::exit(1);
    }
}

async fn get_ws_url(port: u16) -> String {
    let client = reqwest::Client::new();

    // Wait for Chrome to be ready
    for _ in 0..20 {
        if client
            .get(format!("http://127.0.0.1:{port}/json/version"))
            .send()
            .await
            .is_ok()
        {
            break;
        }
        tokio::time::sleep(Duration::from_millis(250)).await;
    }

    // We need a PAGE target, not the browser target.
    // First try /json/list for existing page targets.
    if let Ok(resp) = client
        .get(format!("http://127.0.0.1:{port}/json/list"))
        .send()
        .await
        && let Ok(json) = resp.json::<Vec<serde_json::Value>>().await
    {
        // Find a page-type target
        if let Some(target) = json.iter().find(|t| t["type"].as_str() == Some("page"))
            && let Some(url) = target["webSocketDebuggerUrl"].as_str()
        {
            return url.to_string();
        }
    }

    // No page target found — create one via /json/new
    if let Ok(resp) = client
        .put(format!("http://127.0.0.1:{port}/json/new?about:blank"))
        .send()
        .await
        && let Ok(json) = resp.json::<serde_json::Value>().await
        && let Some(url) = json["webSocketDebuggerUrl"].as_str()
    {
        return url.to_string();
    }

    panic!("Could not get page WebSocket URL from Chrome on port {port}");
}

async fn run_demo(ws_url: &str, file_url: &str) -> Result<(), Box<dyn std::error::Error>> {
    // ── Step 1: Connect via CDP ──
    print_step(1, "Connecting to Chrome via CDP");
    let mut transport = CdpTransport::new(ws_url);
    transport.connect().await?;
    println!("  ✓ Connected");

    // ── Step 2: Navigate ──
    print_step(2, "Navigating to invoice portal");
    let nav = transport.navigate(file_url).await?;
    println!("  ✓ Navigated to {}", nav.url);

    // ── Step 3: Build state graph ──
    print_step(3, "Building state graph from DOM");
    let mut state = SessionState::new("demo-session");
    state.tracer.record_navigation(file_url, Some(200));

    let observation = state.observer.observe(&mut transport).await?;
    let entity_ids = state
        .pipeline
        .extract_and_upsert(&observation, &mut state.graph);

    println!(
        "  ✓ Extracted {} entities (graph version {})",
        entity_ids.len(),
        state.graph.version()
    );

    // ── Step 4: Query table entities ──
    print_step(4, "Querying for table entities");
    let tables = state.graph.query(&EntityKind::Table, None);
    println!("  ✓ Found {} table(s)", tables.len());

    for table in &tables {
        let headers = table
            .properties
            .get("headers")
            .and_then(|h| h.as_array())
            .map(|a| {
                a.iter()
                    .filter_map(|v| v.as_str())
                    .collect::<Vec<_>>()
                    .join(", ")
            })
            .unwrap_or_default();
        let row_count = table.properties.get("row_count").and_then(|v| v.as_u64()).unwrap_or(0);
        println!("    Table: [{headers}] — {row_count} rows");
    }

    let rows = state.graph.query(&EntityKind::TableRow, None);
    println!("  ✓ Found {} row(s)", rows.len());

    // Query with filter: unpaid invoices > 10000
    let unpaid_large = state.graph.query(&EntityKind::TableRow, Some(&|e: &SemanticEntity| {
        e.properties.get("Status").and_then(|v| v.as_str()) == Some("Unpaid")
            && e.properties
                .get("Amount")
                .and_then(|v| v.as_str())
                .and_then(|s| s.parse::<f64>().ok())
                .unwrap_or(0.0)
                > 10000.0
    }));
    println!(
        "  ✓ Unpaid invoices > $10,000: {} match(es)",
        unpaid_large.len()
    );
    for row in &unpaid_large {
        let vendor = row.properties.get("Vendor").and_then(|v| v.as_str()).unwrap_or("?");
        let amount = row.properties.get("Amount").and_then(|v| v.as_str()).unwrap_or("?");
        println!("    → {vendor}: ${amount}");
    }

    // ── Step 5: Derive actions ──
    print_step(5, "Deriving available actions");
    let table = tables.first().expect("no table found");
    let table_actions = ActionDeriver::derive_actions(table, &state.graph);
    println!("  ✓ {} action(s) available:", table_actions.len());
    for action in &table_actions {
        println!("    • {} (confidence: {:.0}%)", action.name, action.confidence * 100.0);
    }

    // ── Step 6: Execute an action (sort by Amount) ──
    let sort_action = table_actions
        .iter()
        .find(|a| a.name.contains("Amount"))
        .expect("no Sort by Amount action");

    print_step(6, &format!("Executing: {}", sort_action.name));

    let step = ExecutionStep {
        id: "step-1".into(),
        action: sort_action.clone(),
        params: None,
        description: format!("Execute: {}", sort_action.name),
    };

    let result = execute_action(sort_action, &step, &mut state, &mut transport).await;
    println!("  ✓ Status: {:?}", result.status);
    println!("  ✓ Duration: {}ms", result.duration_ms);
    if let Some(err) = &result.error {
        println!("  ⚠ Error: {} (recoverable: {})", err.message, err.recoverable);
    }
    for pc in &result.postconditions {
        let icon = if pc.passed { "✓" } else { "✗" };
        println!("  {icon} Postcondition: {}", pc.condition.description);
    }

    // ── Step 7: Verify state after action ──
    print_step(7, "Verifying state after action");
    let rows_after = state.graph.query(&EntityKind::TableRow, None);
    println!("  ✓ {} rows in graph after re-extraction", rows_after.len());
    println!(
        "  ✓ Graph version: {} (was incremented by execution)",
        state.graph.version()
    );

    // ── Step 8: Inspect trace ──
    print_step(8, "Execution trace");
    let trace = state.tracer.to_trace_data();
    println!("  Session: {}", trace.session_id);
    println!("  Duration: {}ms", trace.duration_ms);
    println!("  Events:");
    for event in &trace.entries {
        let (icon, desc) = match event {
            TraceEvent::Navigation { url, seq, .. } => ("🌐", format!("[{seq}] Navigate → {url}")),
            TraceEvent::Extraction {
                entity_type,
                count,
                seq,
                ..
            } => ("📦", format!("[{seq}] Extract {count} {entity_type} entities")),
            TraceEvent::Execution { step, result, seq, .. } => {
                let status = match result.status {
                    ExecutionStatus::Success => "✓",
                    ExecutionStatus::Failed => "✗",
                    ExecutionStatus::Skipped => "⊘",
                };
                ("⚡", format!("[{seq}] {status} {}", step.description))
            }
            TraceEvent::Observation {
                entity_count, seq, ..
            } => ("👁", format!("[{seq}] Observe {entity_count} entities")),
            TraceEvent::Query {
                entity_type,
                result_count,
                seq,
                ..
            } => ("🔍", format!("[{seq}] Query {entity_type} → {result_count} results")),
            TraceEvent::StateChange {
                description, seq, ..
            } => ("Δ ", format!("[{seq}] {description}")),
            TraceEvent::Error {
                code, message, seq, ..
            } => ("❌", format!("[{seq}] {code}: {message}")),
            TraceEvent::Snapshot {
                label,
                changed,
                added_count,
                removed_count,
                seq,
                ..
            } => (
                "🧭",
                format!(
                    "[{seq}] Snapshot {label} changed={changed} +{added_count} -{removed_count}"
                ),
            ),
        };
        println!("    {icon} {desc}");
    }

    // Disconnect
    transport.disconnect().await?;

    println!();
    println!("══════════════════════════════════════════════");
    println!("  Demo complete. Full vertical slice executed.");
    println!("══════════════════════════════════════════════");

    Ok(())
}

fn print_step(n: u8, label: &str) {
    println!("── Step {n}: {label} ──");
}
