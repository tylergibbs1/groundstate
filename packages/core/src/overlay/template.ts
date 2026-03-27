/**
 * Overlay UI — Apple-esque design, layman-friendly content.
 *
 * Shows what the agent is doing, what it found, and a plain-English
 * activity log. No entity counts, graph versions, or trace types.
 * Frosted glass, SF Pro, tight geometry.
 */

const OVERLAY_CSS = `
* { margin: 0; padding: 0; box-sizing: border-box; }

:host {
  font-family: -apple-system, 'SF Pro Text', 'SF Pro Display', system-ui, sans-serif;
  font-size: 13px;
  color: #1d1d1f;
  line-height: 1.4;
  -webkit-font-smoothing: antialiased;
}

.gs {
  position: fixed;
  bottom: 16px;
  right: 16px;
  width: 300px;
  pointer-events: auto;
  border-radius: 14px;
  overflow: hidden;
  background: rgba(255, 255, 255, 0.72);
  backdrop-filter: blur(40px) saturate(1.8);
  -webkit-backdrop-filter: blur(40px) saturate(1.8);
  border: 0.5px solid rgba(0, 0, 0, 0.12);
  box-shadow:
    0 0 0 0.5px rgba(0, 0, 0, 0.04),
    0 4px 24px rgba(0, 0, 0, 0.08),
    0 1px 3px rgba(0, 0, 0, 0.06);
  transition: opacity 0.25s ease, transform 0.25s ease;
  user-select: none;
}

@media (prefers-color-scheme: dark) {
  :host { color: #f5f5f7; }
  .gs {
    background: rgba(30, 30, 30, 0.72);
    border-color: rgba(255, 255, 255, 0.1);
    box-shadow:
      0 0 0 0.5px rgba(255, 255, 255, 0.04),
      0 4px 24px rgba(0, 0, 0, 0.3),
      0 1px 3px rgba(0, 0, 0, 0.2);
  }
  .gs-activity-item { color: #a1a1a6; }
  .gs-status-label { color: #f5f5f7; }
  .gs-status-detail { color: #a1a1a6; }
  .gs-header { border-bottom-color: rgba(255, 255, 255, 0.06); }
  .gs-section { border-top-color: rgba(255, 255, 255, 0.06); }
  .gs-pill { background: rgba(255, 255, 255, 0.08); color: #a1a1a6; }
  .gs-collapse-btn { color: #a1a1a6; }
  .gs-collapse-btn:hover { background: rgba(255, 255, 255, 0.08); }
}

.gs.collapsed .gs-body { display: none; }

/* ── Header ── */
.gs-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 12px 14px 10px;
  cursor: grab;
  border-bottom: 0.5px solid rgba(0, 0, 0, 0.06);
}
.gs-header:active { cursor: grabbing; }

.gs-header-left {
  display: flex;
  align-items: center;
  gap: 8px;
}

.gs-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: #34c759;
  flex-shrink: 0;
  transition: background 0.3s ease;
}
.gs-dot.working {
  background: #007aff;
  animation: gs-breathe 1.8s ease-in-out infinite;
}
.gs-dot.error { background: #ff3b30; }

@keyframes gs-breathe {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.4; }
}

.gs-header-title {
  font-size: 13px;
  font-weight: 600;
  letter-spacing: -0.01em;
}

.gs-collapse-btn {
  background: none;
  border: none;
  color: #86868b;
  cursor: pointer;
  font-size: 16px;
  line-height: 1;
  padding: 2px 4px;
  border-radius: 6px;
  transition: background 0.15s;
}
.gs-collapse-btn:hover { background: rgba(0, 0, 0, 0.05); }

/* ── Body ── */
.gs-body { padding: 0; }

/* ── Status ── */
.gs-status {
  padding: 12px 14px;
}

.gs-status-label {
  font-size: 15px;
  font-weight: 600;
  letter-spacing: -0.02em;
  margin-bottom: 2px;
}

.gs-status-detail {
  font-size: 12px;
  color: #86868b;
}

/* ── Pills row ── */
.gs-pills {
  display: flex;
  gap: 6px;
  padding: 0 14px 12px;
  flex-wrap: wrap;
}

.gs-pill {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 3px 8px;
  border-radius: 100px;
  font-size: 11px;
  font-weight: 500;
  background: rgba(0, 0, 0, 0.04);
  color: #86868b;
}

.gs-pill-value {
  font-weight: 600;
  color: #1d1d1f;
}

@media (prefers-color-scheme: dark) {
  .gs-pill-value { color: #f5f5f7; }
}

/* ── Activity feed ── */
.gs-section {
  border-top: 0.5px solid rgba(0, 0, 0, 0.06);
  padding: 10px 14px 12px;
}

.gs-section-title {
  font-size: 11px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  color: #86868b;
  margin-bottom: 8px;
}

.gs-activity {
  display: flex;
  flex-direction: column;
  gap: 4px;
  max-height: 140px;
  overflow-y: auto;
  scrollbar-width: none;
}
.gs-activity::-webkit-scrollbar { display: none; }

.gs-activity-item {
  font-size: 12px;
  color: #6e6e73;
  line-height: 1.35;
  padding: 2px 0;
}

.gs-activity-item.latest {
  color: #1d1d1f;
  font-weight: 500;
}

@media (prefers-color-scheme: dark) {
  .gs-activity-item.latest { color: #f5f5f7; }
}

.gs-empty {
  font-size: 12px;
  color: #aeaeb2;
  font-style: italic;
}

/* ── Drag ── */
.gs.dragging {
  opacity: 0.9;
  transition: none;
}
`;

const OVERLAY_HTML = `
<div class="gs-header" data-gs-drag>
  <div class="gs-header-left">
    <div class="gs-dot" data-gs-dot></div>
    <span class="gs-header-title">groundstate</span>
  </div>
  <button class="gs-collapse-btn" data-gs-toggle title="Toggle">\u2303</button>
</div>
<div class="gs-body">
  <div class="gs-status">
    <div class="gs-status-label" data-gs-label>Starting up\u2026</div>
    <div class="gs-status-detail" data-gs-detail></div>
  </div>
  <div class="gs-pills" data-gs-pills></div>
  <div class="gs-section">
    <div class="gs-section-title">Activity</div>
    <div class="gs-activity" data-gs-feed>
      <div class="gs-empty">Waiting for first action\u2026</div>
    </div>
  </div>
</div>
`;

export function buildOverlayScript(): string {
  const cssJson = JSON.stringify(OVERLAY_CSS);
  const htmlJson = JSON.stringify(OVERLAY_HTML);

  return `(function() {
  if (document.getElementById('__gs_overlay_root')) return;

  var host = document.createElement('div');
  host.id = '__gs_overlay_root';
  host.style.cssText = 'position:fixed;top:0;left:0;width:0;height:0;z-index:2147483647;pointer-events:none;';
  document.documentElement.appendChild(host);
  var shadow = host.attachShadow({ mode: 'open' });

  var style = document.createElement('style');
  style.textContent = ${cssJson};
  shadow.appendChild(style);

  var container = document.createElement('div');
  container.className = 'gs';
  container.innerHTML = ${htmlJson};
  shadow.appendChild(container);

  var toggle = shadow.querySelector('[data-gs-toggle]');
  toggle.addEventListener('click', function() {
    container.classList.toggle('collapsed');
  });

  var header = shadow.querySelector('[data-gs-drag]');
  var dragX = 0, dragY = 0, startX = 0, startY = 0;
  header.addEventListener('mousedown', function(e) {
    e.preventDefault();
    startX = e.clientX - dragX;
    startY = e.clientY - dragY;
    container.classList.add('dragging');
    function onMove(ev) {
      dragX = ev.clientX - startX;
      dragY = ev.clientY - startY;
      container.style.transform = 'translate(' + dragX + 'px,' + dragY + 'px)';
    }
    function onUp() {
      container.classList.remove('dragging');
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
    }
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  });

  function esc(s) {
    return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
  }

  window.__gs_overlay = {
    update: function(state) {
      var dot = shadow.querySelector('[data-gs-dot]');
      dot.className = 'gs-dot' + (state.dotClass ? ' ' + state.dotClass : '');

      shadow.querySelector('[data-gs-label]').textContent = state.label || '';
      shadow.querySelector('[data-gs-detail]').textContent = state.detail || '';

      var pills = shadow.querySelector('[data-gs-pills]');
      if (state.pills && state.pills.length > 0) {
        pills.innerHTML = state.pills.map(function(p) {
          return '<span class="gs-pill">' + esc(p.label) + ' <span class="gs-pill-value">' + esc(p.value) + '</span></span>';
        }).join('');
        pills.style.display = '';
      } else {
        pills.style.display = 'none';
      }

      var feed = shadow.querySelector('[data-gs-feed]');
      if (state.activity && state.activity.length > 0) {
        feed.innerHTML = state.activity.map(function(item, i) {
          var cls = i === state.activity.length - 1 ? 'gs-activity-item latest' : 'gs-activity-item';
          return '<div class="' + cls + '">' + esc(item) + '</div>';
        }).join('');
        feed.scrollTop = feed.scrollHeight;
      }
    },

    destroy: function() {
      host.remove();
      delete window.__gs_overlay;
    }
  };
})()`;
}

export function buildUpdateScript(state: OverlayViewState): string {
  const json = JSON.stringify(state);
  return `(function() { if (window.__gs_overlay) window.__gs_overlay.update(${json}); })()`;
}

export function buildDestroyScript(): string {
  return `(function() { if (window.__gs_overlay) window.__gs_overlay.destroy(); })()`;
}

// ── View state pushed to the browser ──

export interface OverlayViewState {
  /** Dot color class: "" (green/idle), "working" (blue/pulse), "error" (red) */
  dotClass: "" | "working" | "error";
  /** Main status line, e.g. "Browsing page…" or "Found 3 results" */
  label: string;
  /** Secondary detail, e.g. "sfbay.craigslist.org" */
  detail: string;
  /** Small pills, e.g. [{label:"pages",value:"2"}, {label:"actions",value:"5"}] */
  pills: { label: string; value: string }[];
  /** Human-readable activity feed, newest last */
  activity: string[];
}

// Keep legacy type exports for index.ts re-exports
export type OverlayState = OverlayViewState;
export type OverlayAction = { type: string; name: string; result?: string };
export type OverlayEntityGroup = { kind: string; count: number; status: string };
export type OverlayTraceEntry = { type: string; summary: string; offsetMs?: number };
