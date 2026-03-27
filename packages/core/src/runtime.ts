import { NapiBridge, type NativeSessionLike } from "./bridge.js";
import { Session } from "./session.js";
import { ConnectionError } from "./errors.js";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, rmSync } from "node:fs";

const CHROME_PATHS = [
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary",
  "/Applications/Chromium.app/Contents/MacOS/Chromium",
  "/usr/bin/google-chrome",
  "/usr/bin/chromium-browser",
  "/usr/bin/chromium",
];

export interface RuntimeConfig {
  /** Path to Chrome/Chromium executable (auto-detected if omitted). */
  chromePath?: string;
  /** Enable headless mode (default: true). */
  headless?: boolean;
  /** Default timeout for operations in ms (default: 30000). */
  defaultTimeoutMs?: number;
}

export interface StartSessionOptions {
  /** URL to navigate to. */
  url: string;
  /** Chrome CDP WebSocket URL. If omitted, launches a new Chrome instance. */
  wsUrl?: string;
  /** Reuse a persistent browser profile for cookies and auth state. */
  authProfile?: string;
  /** Wait for the state graph to stabilize before resolving (default: true). */
  waitForStable?: boolean;
  /** Viewport dimensions. */
  viewport?: { width: number; height: number };
  /** Show a live state overlay in the browser (default: false, ignored in headless). */
  overlay?: boolean;
}

/**
 * Entry point for the Groundstate runtime.
 *
 * Creates browser sessions backed by the Rust core. Each session maintains
 * its own state graph, transport, and execution trace.
 *
 * @example
 * const runtime = new Runtime();
 * const session = await runtime.start({ url: "https://example.com" });
 * const tables = await session.query({ entity: "Table" });
 */
export class Runtime {
  private readonly config: Required<RuntimeConfig>;
  private sessions: Set<Session> = new Set();

  constructor(config: RuntimeConfig = {}) {
    this.config = {
      chromePath: config.chromePath ?? "",
      headless: config.headless ?? true,
      defaultTimeoutMs: config.defaultTimeoutMs ?? 30_000,
    };
  }

  /**
   * Start a new browser session.
   *
   * Connects to Chrome (or launches one), navigates to the URL, builds
   * the initial state graph, and returns a ready-to-use Session.
   */
  async start(options: StartSessionOptions): Promise<Session> {
    let wsUrl = options.wsUrl;
    let launched: LaunchedChrome | undefined;
    if (!wsUrl) {
      launched = await launchChrome({
        chromePath: this.config.chromePath,
        headless: this.config.headless,
        viewport: options.viewport,
        authProfile: options.authProfile,
      });
      wsUrl = launched.wsUrl;
    }

    const sessionConfig = {
      wsUrl,
      url: options.url,
      waitForStable: options.waitForStable ?? true,
    };

    // Load the native addon dynamically
    let NativeSession: { create(configJson: string): Promise<NativeSessionLike> };
    try {
      const binding = await loadNativeBinding();
      NativeSession = binding.NativeSession;
    } catch {
      throw new ConnectionError(
        "Failed to load @groundstate/napi native addon. " +
          "Make sure the native binary is built: pnpm build:native",
      );
    }

    const native = await NativeSession.create(JSON.stringify(sessionConfig));
    const bridge = new NapiBridge(native);
    const enableOverlay = (options.overlay ?? false) && !this.config.headless;
    const session = new Session(bridge, {
      onClose: async () => {
        this.sessions.delete(session);
        await launched?.close();
      },
      overlay: enableOverlay,
    });
    this.sessions.add(session);

    if (enableOverlay) {
      await session.overlay._autoEnable();
    }

    return session;
  }

  /** Close all active sessions. */
  async closeAll(): Promise<void> {
    await Promise.all([...this.sessions].map((s) => s.close()));
    this.sessions.clear();
  }
}

async function loadNativeBinding(): Promise<{
  NativeSession: { create(configJson: string): Promise<NativeSessionLike> };
}> {
  try {
    return (await import("@groundstate/napi")) as {
      NativeSession: { create(configJson: string): Promise<NativeSessionLike> };
    };
  } catch {
    return (await import("../../napi/index.js")) as {
      NativeSession: { create(configJson: string): Promise<NativeSessionLike> };
    };
  }
}

interface LaunchedChrome {
  wsUrl: string;
  close(): Promise<void>;
}

function resolveChromePath(preferred?: string): string {
  if (preferred && existsSync(preferred)) return preferred;

  const discovered = CHROME_PATHS.find((path) => existsSync(path));
  if (!discovered) {
    throw new ConnectionError(
      "Chrome not found. Provide RuntimeConfig.chromePath or install Chrome/Chromium.",
    );
  }
  return discovered;
}

async function launchChrome(options: {
  chromePath?: string;
  headless: boolean;
  viewport?: { width: number; height: number };
  authProfile?: string;
}): Promise<LaunchedChrome> {
  const port = 9200 + Math.floor(Math.random() * 700);
  const profileDir = options.authProfile
    ? resolveProfileDir(options.authProfile)
    : `/tmp/groundstate-runtime-${process.pid}-${Date.now()}`;
  const chromePath = resolveChromePath(options.chromePath);
  const width = options.viewport?.width ?? 1440;
  const height = options.viewport?.height ?? 960;

  const chrome = spawn(
    chromePath,
    [
      `--remote-debugging-port=${port}`,
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-extensions",
      "--disable-background-networking",
      `--window-size=${width},${height}`,
      `--user-data-dir=${profileDir}`,
      ...(options.headless ? ["--headless=new", "--disable-gpu"] : []),
    ],
    { stdio: "ignore" },
  );

  const wsUrl = await getPageWsUrl(port);

  return {
    wsUrl,
    async close() {
      chrome.kill();
      if (!options.authProfile) {
        // Give Chrome a moment to release file handles before cleanup.
        await sleep(200);
        try {
          rmSync(profileDir, { recursive: true, force: true });
        } catch {
          // Chrome may still hold locks — ignore cleanup failure.
        }
      }
    },
  };
}

function resolveProfileDir(authProfile: string): string {
  const safeName = authProfile.replace(/[^a-z0-9-_]/gi, "-").toLowerCase();
  const baseDir = process.env.GROUNDSTATE_PROFILES_DIR ?? "/tmp/groundstate-profiles";
  const profileDir = `${baseDir}/${safeName}`;
  return profileDir;
}

async function getPageWsUrl(port: number): Promise<string> {
  for (let i = 0; i < 30; i++) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/list`);
      const targets = (await response.json()) as Array<{
        type?: string;
        webSocketDebuggerUrl?: string;
      }>;
      const page = targets.find((target) => target.type === "page");
      if (page?.webSocketDebuggerUrl) return page.webSocketDebuggerUrl;
    } catch {
      // Chrome still booting.
    }
    await sleep(250);
  }

  const response = await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, {
    method: "PUT",
  });
  const target = (await response.json()) as { webSocketDebuggerUrl?: string };
  if (!target.webSocketDebuggerUrl) {
    throw new ConnectionError(`Failed to acquire Chrome debugging target on port ${port}.`);
  }
  return target.webSocketDebuggerUrl;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
