import type { Bridge } from "../bridge.js";
import type { TraceEntry } from "../trace.js";
import {
  buildOverlayScript,
  buildUpdateScript,
  buildDestroyScript,
  type OverlayViewState,
} from "./template.js";

export type {
  OverlayViewState as OverlayState,
  OverlayViewState,
};

// Keep legacy re-exports for backwards compat
export type OverlayAction = { type: string; name: string; result?: string };
export type OverlayEntityGroup = { kind: string; count: number; status: string };
export type OverlayTraceEntry = { type: string; summary: string; offsetMs?: number };

/**
 * Reactive overlay manager — trace-driven, layman-friendly.
 *
 * Reads the trace log (single source of truth), translates each event
 * into plain English, and pushes a simple view to the browser overlay.
 */
export class OverlayManager {
  private readonly bridge: Bridge;
  private injected = false;
  private destroyed = false;
  private pushing = false;

  private cursor = 0;
  private activity: string[] = [];
  private label = "Starting up\u2026";
  private detail = "";
  private dotClass: OverlayViewState["dotClass"] = "";
  private actionCount = 0;
  private pageCount = 0;
  private errorCount = 0;

  private static readonly MAX_ACTIVITY = 20;

  constructor(bridge: Bridge) {
    this.bridge = bridge;
  }

  async inject(): Promise<void> {
    if (this.destroyed || !this.bridge.evaluateJs) return;
    await this.bridge.evaluateJs(buildOverlayScript());
    this.injected = true;
  }

  async destroy(): Promise<void> {
    if (!this.injected || this.destroyed) return;
    this.destroyed = true;
    if (!this.bridge.evaluateJs) return;
    try {
      await this.bridge.evaluateJs(buildDestroyScript());
    } catch { /* page may have navigated */ }
  }

  async sync(): Promise<void> {
    if (this.destroyed || !this.injected || this.pushing) return;
    if (!this.bridge.evaluateJs) return;

    this.pushing = true;
    try {
      await this.advanceFromTrace();
      const state = this.buildView();
      await this.reinjectIfNeeded();
      await this.bridge.evaluateJs(buildUpdateScript(state));
    } catch { /* non-fatal */ }
    finally { this.pushing = false; }
  }

  get isInjected(): boolean {
    return this.injected && !this.destroyed;
  }

  // ── Derive view from trace ──

  private async advanceFromTrace(): Promise<void> {
    if (!this.bridge.getTraceSince) return;
    let entries: unknown[];
    try { entries = await this.bridge.getTraceSince(this.cursor); }
    catch { return; }

    for (const raw of entries) {
      const entry = raw as TraceEntry;
      this.cursor = entry.seq;
      this.processEntry(entry);
    }

    if (this.activity.length > OverlayManager.MAX_ACTIVITY) {
      this.activity = this.activity.slice(-OverlayManager.MAX_ACTIVITY);
    }
  }

  private processEntry(entry: TraceEntry): void {
    switch (entry.type) {
      case "navigation": {
        this.pageCount++;
        const host = hostFromUrl(entry.url);
        this.label = "Browsing page\u2026";
        this.detail = host;
        this.dotClass = "working";
        this.activity.push(`Navigated to ${host}`);
        break;
      }
      case "observation": {
        this.label = "Reading page\u2026";
        this.dotClass = "working";
        if (entry.entityCount > 0) {
          this.activity.push(`Found ${entry.entityCount} elements on page`);
        }
        break;
      }
      case "extraction": {
        if (entry.count > 0) {
          this.label = `Found ${entry.count} items`;
          this.dotClass = "";
        }
        break;
      }
      case "snapshot": {
        if (entry.changed) {
          if (entry.addedCount > 0 && entry.removedCount > 0) {
            this.activity.push(`Page updated: +${entry.addedCount} new, -${entry.removedCount} removed`);
          } else if (entry.addedCount > 0) {
            this.activity.push(`Discovered ${entry.addedCount} new elements`);
          }
        }
        this.label = `${entry.entityCount} elements on page`;
        this.dotClass = "";
        break;
      }
      case "execution": {
        this.actionCount++;
        const name = entry.step.action.name;
        const ok = entry.result.status === "success";
        if (ok) {
          this.label = `Done: ${name}`;
          this.dotClass = "";
          this.activity.push(`\u2713 ${name}`);
        } else {
          this.label = `Failed: ${name}`;
          this.dotClass = "error";
          this.errorCount++;
          const reason = entry.result.error?.message ?? "unknown error";
          this.activity.push(`\u2717 ${name} \u2014 ${reason}`);
        }
        break;
      }
      case "query": {
        if (entry.resultCount > 0) {
          this.activity.push(`Queried ${entry.entityType}: ${entry.resultCount} found`);
        }
        break;
      }
      case "error": {
        this.errorCount++;
        this.dotClass = "error";
        this.label = "Something went wrong";
        this.detail = entry.message;
        this.activity.push(`Error: ${entry.message}`);
        break;
      }
      case "state_change": {
        if (entry.invalidatedCount > 0) {
          this.activity.push(`${entry.invalidatedCount} elements need refresh`);
        }
        break;
      }
    }
  }

  private buildView(): OverlayViewState {
    const pills: { label: string; value: string }[] = [];
    if (this.pageCount > 0) pills.push({ label: "pages", value: String(this.pageCount) });
    if (this.actionCount > 0) pills.push({ label: "actions", value: String(this.actionCount) });
    if (this.errorCount > 0) pills.push({ label: "errors", value: String(this.errorCount) });

    return {
      dotClass: this.dotClass,
      label: this.label,
      detail: this.detail,
      pills,
      activity: this.activity.slice(-12),
    };
  }

  private async reinjectIfNeeded(): Promise<void> {
    if (this.destroyed || !this.bridge.evaluateJs) return;
    try {
      const exists = await this.bridge.evaluateJs(
        `(function() { return !!document.getElementById('__gs_overlay_root'); })()`
      );
      if (!exists) {
        this.injected = false;
        await this.inject();
      }
    } catch {
      this.injected = false;
      await this.inject();
    }
  }
}

// ── Helpers ──

function hostFromUrl(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return url.length > 40 ? url.slice(0, 37) + "\u2026" : url;
  }
}
