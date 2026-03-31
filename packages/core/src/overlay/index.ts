import type { Bridge } from "../bridge.js";
import type { TraceEntry } from "../trace.js";
import type { GraphDiff, EntitySnapshot } from "../reactive.js";
import {
  buildOverlayScript,
  buildUpdateScript,
  buildDestroyScript,
  type OverlayViewState,
} from "./template.js";
import {
  buildHighlightScript,
  buildHighlightUpdateScript,
  buildHighlightScanScript,
  buildHighlightPulseScript,
  buildHighlightClearScript,
  buildHighlightDestroyScript,
  type HighlightEntity,
} from "./highlight.js";

export type {
  OverlayViewState as OverlayState,
  OverlayViewState,
  HighlightEntity,
};

// Keep legacy re-exports for backwards compat
export type OverlayAction = { type: string; name: string; result?: string };
export type OverlayEntityGroup = { kind: string; count: number; status: string };
export type OverlayTraceEntry = { type: string; summary: string; offsetMs?: number };

/**
 * Reactive overlay manager — trace-driven, with entity highlights.
 *
 * Reads the trace log (single source of truth), translates each event
 * into plain English, and pushes a simple view to the browser overlay.
 * Also manages the entity highlight layer — bounding boxes, scan
 * animations, and pulse effects.
 */
export class OverlayManager {
  private readonly bridge: Bridge;
  private injected = false;
  private highlightInjected = false;
  private destroyed = false;
  private pushing = false;

  private cursor = 0;
  private activity: string[] = [];
  private label = "Initializing\u2026";
  private detail = "";
  private dotClass: OverlayViewState["dotClass"] = "";
  private actionCount = 0;
  private pageCount = 0;
  private errorCount = 0;
  private graphVersion = 0;

  /** Tracked entities for the highlight layer. */
  private entities: Map<string, HighlightEntity> = new Map();
  /** Entity kind counts for the HUD summary row. */
  private entityCounts: Map<string, number> = new Map();

  private static readonly MAX_ACTIVITY = 20;

  constructor(bridge: Bridge) {
    this.bridge = bridge;
  }

  async inject(): Promise<void> {
    if (this.destroyed || !this.bridge.evaluateJs) return;
    await this.bridge.evaluateJs(buildOverlayScript());
    this.injected = true;
    await this.bridge.evaluateJs(buildHighlightScript());
    this.highlightInjected = true;
  }

  async destroy(): Promise<void> {
    if (!this.injected || this.destroyed) return;
    this.destroyed = true;
    if (!this.bridge.evaluateJs) return;
    try {
      await this.bridge.evaluateJs(buildDestroyScript());
      await this.bridge.evaluateJs(buildHighlightDestroyScript());
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
      await this.pushHighlights();
    } catch { /* non-fatal */ }
    finally { this.pushing = false; }
  }

  /**
   * Feed a graph diff into the overlay to update entity highlights.
   * Call this from the session's onGraphChange handler.
   */
  async applyDiff(diff: GraphDiff): Promise<void> {
    if (this.destroyed || !this.highlightInjected) return;

    this.graphVersion = diff.graph_version;

    // Track upserted entities
    for (const snap of diff.upserted) {
      this.trackEntity(snap);
    }

    // Remove removed entities
    for (const id of diff.removed) {
      const existing = this.entities.get(id);
      if (existing) {
        const kind = existing.kind.toLowerCase();
        const count = this.entityCounts.get(kind) ?? 0;
        if (count > 1) this.entityCounts.set(kind, count - 1);
        else this.entityCounts.delete(kind);
      }
      this.entities.delete(id);
    }

    // Pulse invalidated entities
    if (diff.invalidated.length > 0 && this.bridge.evaluateJs) {
      try {
        await this.bridge.evaluateJs(buildHighlightPulseScript(diff.invalidated));
      } catch { /* non-fatal */ }
    }
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

  // Trace entries arrive as raw JSON from Rust (snake_case) but the TS types
  // use camelCase.  Read both forms so the overlay works regardless.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private processEntry(entry: TraceEntry): void {
    const raw = entry as any;
    switch (entry.type) {
      case "navigation": {
        this.pageCount++;
        const host = hostFromUrl(entry.url);
        this.label = "Navigating\u2026";
        this.detail = host;
        this.dotClass = "working";
        this.activity.push(`\u2192 ${host}`);
        // Clear highlights on navigation — new page, new elements
        this.entities.clear();
        this.entityCounts.clear();
        break;
      }
      case "observation": {
        this.label = "Observing page\u2026";
        this.dotClass = "working";
        const obsCount: number = raw.entityCount ?? raw.entity_count ?? 0;
        if (obsCount > 0) {
          this.activity.push(`Scanned ${obsCount} elements`);
        }
        // Trigger scan animation
        this.triggerScan();
        break;
      }
      case "extraction": {
        const extCount: number = raw.count ?? 0;
        const extType: string = raw.entityType ?? raw.entity_type ?? "";
        if (extCount > 0) {
          this.label = `${extCount} ${extType}`;
          this.dotClass = "";
        }
        break;
      }
      case "snapshot": {
        const addedCount: number = raw.addedCount ?? raw.added_count ?? 0;
        const removedCount: number = raw.removedCount ?? raw.removed_count ?? 0;
        const entityCount: number = raw.entityCount ?? raw.entity_count ?? 0;
        const changed: boolean = raw.changed ?? false;
        if (changed) {
          if (addedCount > 0 && removedCount > 0) {
            this.activity.push(`\u0394 +${addedCount} \u2212${removedCount}`);
          } else if (addedCount > 0) {
            this.activity.push(`+ ${addedCount} new elements`);
          }
        }
        this.label = `${entityCount} elements`;
        this.dotClass = "";
        break;
      }
      case "execution": {
        this.actionCount++;
        const name = entry.step.action.name;
        const ok = entry.result.status === "success";
        if (ok) {
          this.label = name;
          this.dotClass = "";
          this.activity.push(`\u2713 ${name}`);
        } else {
          this.label = `Failed: ${name}`;
          this.dotClass = "error";
          this.errorCount++;
          const reason = entry.result.error?.message ?? "unknown";
          this.activity.push(`\u2717 ${name} \u2014 ${reason}`);
        }
        break;
      }
      case "query": {
        const qCount: number = raw.resultCount ?? raw.result_count ?? 0;
        const qType: string = raw.entityType ?? raw.entity_type ?? "";
        if (qCount > 0) {
          this.activity.push(`? ${qType}: ${qCount}`);
        }
        break;
      }
      case "error": {
        this.errorCount++;
        this.dotClass = "error";
        this.label = "Error";
        this.detail = entry.message;
        this.activity.push(`! ${entry.message}`);
        break;
      }
      case "state_change": {
        const invCount: number = raw.invalidatedCount ?? raw.invalidated_count ?? 0;
        if (invCount > 0) {
          this.activity.push(`~ ${invCount} invalidated`);
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

    const entitySummary: { kind: string; count: number }[] = [];
    for (const [kind, count] of this.entityCounts) {
      entitySummary.push({ kind, count });
    }
    entitySummary.sort((a, b) => b.count - a.count);

    return {
      dotClass: this.dotClass,
      label: this.label,
      detail: this.detail,
      pills,
      activity: this.activity.slice(-12),
      entitySummary,
      graphVersion: this.graphVersion,
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
        this.highlightInjected = false;
        await this.inject();
      }
    } catch {
      this.injected = false;
      this.highlightInjected = false;
      await this.inject();
    }
  }

  // ── Highlight management ──

  private trackEntity(snap: EntitySnapshot): void {
    const selector = (snap.properties as Record<string, unknown>)?._source as string | undefined;
    if (!selector) return;

    const kind = snap.kind.toLowerCase();
    const confidence = (snap.properties as Record<string, unknown>)?._confidence as number | undefined;

    if (!this.entities.has(snap.id)) {
      this.entityCounts.set(kind, (this.entityCounts.get(kind) ?? 0) + 1);
    }

    this.entities.set(snap.id, {
      id: snap.id,
      kind,
      selector,
      label: kind,
      confidence: confidence ?? undefined,
    });
  }

  private async pushHighlights(): Promise<void> {
    if (!this.highlightInjected || !this.bridge.evaluateJs) return;

    if (this.entities.size === 0) {
      try {
        await this.bridge.evaluateJs(buildHighlightClearScript());
      } catch { /* non-fatal */ }
      return;
    }

    const entities = Array.from(this.entities.values());
    try {
      await this.bridge.evaluateJs(buildHighlightUpdateScript(entities));
    } catch { /* non-fatal */ }
  }

  private async triggerScan(): Promise<void> {
    if (!this.highlightInjected || !this.bridge.evaluateJs) return;
    try {
      await this.bridge.evaluateJs(buildHighlightScanScript());
    } catch { /* non-fatal */ }
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
