/**
 * Entity highlight overlay — Tesla/Vercel aesthetic.
 *
 * Injects a full-viewport SVG + DOM layer that draws bounding boxes
 * around detected entities, color-coded by kind. Includes:
 *   - Thin-line bounding boxes with subtle glow
 *   - Floating type labels (monospace, uppercase)
 *   - Scan-line animation during extraction
 *   - Pulse animation on state changes
 *   - Corner tick marks for a HUD feel
 *
 * All rendering lives inside a Shadow DOM container so it never
 * interferes with the host page's styles or layout.
 */

// ── Entity kind → color mapping (muted, cool-tone palette) ──

const KIND_COLORS: Record<string, string> = {
  table:        "#3b82f6", // blue
  tablerow:     "#3b82f6",
  form:         "#8b5cf6", // violet
  formfield:    "#8b5cf6",
  button:       "#06b6d4", // cyan
  link:         "#06b6d4",
  modal:        "#f59e0b", // amber
  dialog:       "#f59e0b",
  menu:         "#10b981", // emerald
  tab:          "#10b981",
  list:         "#6366f1", // indigo
  listitem:     "#6366f1",
  searchresult: "#ec4899", // pink
  pagination:   "#64748b", // slate
};

const DEFAULT_COLOR = "#94a3b8"; // slate-400

function colorForKind(kind: string): string {
  return KIND_COLORS[kind.toLowerCase()] ?? DEFAULT_COLOR;
}

// ── Highlight entity descriptor ──

export interface HighlightEntity {
  id: string;
  kind: string;
  selector: string;
  label?: string;
  confidence?: number;
}

// ── CSS for the highlight layer ──

const HIGHLIGHT_CSS = `
* { margin: 0; padding: 0; box-sizing: border-box; }

:host {
  font-family: 'Geist Mono', 'SF Mono', 'Fira Code', 'JetBrains Mono', ui-monospace, monospace;
  -webkit-font-smoothing: antialiased;
}

.gs-hl-viewport {
  position: fixed;
  top: 0;
  left: 0;
  width: 100vw;
  height: 100vh;
  pointer-events: none;
  z-index: 2147483646;
  overflow: hidden;
}

/* ── Entity bounding box ── */
.gs-hl-box {
  position: absolute;
  pointer-events: none;
  transition: top 0.3s cubic-bezier(0.16, 1, 0.3, 1),
              left 0.3s cubic-bezier(0.16, 1, 0.3, 1),
              width 0.3s cubic-bezier(0.16, 1, 0.3, 1),
              height 0.3s cubic-bezier(0.16, 1, 0.3, 1);
}

/* Frosted fill behind detected element */
.gs-hl-fill {
  position: absolute;
  inset: 0;
  background: var(--gs-color);
  opacity: 0.04;
  border-radius: 4px;
}

.gs-hl-border {
  position: absolute;
  inset: 0;
  border: 1.5px solid var(--gs-color);
  opacity: 0.5;
  border-radius: 4px;
  transition: opacity 0.3s ease;
}

/* Glow — slightly stronger for presence */
.gs-hl-glow {
  position: absolute;
  inset: -2px;
  border: 1.5px solid var(--gs-color);
  border-radius: 6px;
  opacity: 0.12;
  filter: blur(6px);
}

/* Corner ticks — bigger, bolder HUD brackets */
.gs-hl-tick {
  position: absolute;
  width: 12px;
  height: 12px;
  opacity: 0.8;
}
.gs-hl-tick::before,
.gs-hl-tick::after {
  content: '';
  position: absolute;
  background: var(--gs-color);
}
.gs-hl-tick.tl { top: -2px; left: -2px; }
.gs-hl-tick.tl::before { top: 0; left: 0; width: 12px; height: 1.5px; }
.gs-hl-tick.tl::after  { top: 0; left: 0; width: 1.5px; height: 12px; }

.gs-hl-tick.tr { top: -2px; right: -2px; }
.gs-hl-tick.tr::before { top: 0; right: 0; width: 12px; height: 1.5px; }
.gs-hl-tick.tr::after  { top: 0; right: 0; width: 1.5px; height: 12px; }

.gs-hl-tick.bl { bottom: -2px; left: -2px; }
.gs-hl-tick.bl::before { bottom: 0; left: 0; width: 12px; height: 1.5px; }
.gs-hl-tick.bl::after  { bottom: 0; left: 0; width: 1.5px; height: 12px; }

.gs-hl-tick.br { bottom: -2px; right: -2px; }
.gs-hl-tick.br::before { bottom: 0; right: 0; width: 12px; height: 1.5px; }
.gs-hl-tick.br::after  { bottom: 0; right: 0; width: 1.5px; height: 12px; }

/* Type label — frosted glass chip */
.gs-hl-label {
  position: absolute;
  top: -22px;
  left: 0;
  font-size: 9px;
  font-weight: 600;
  letter-spacing: 0.1em;
  text-transform: uppercase;
  color: var(--gs-color);
  background: rgba(0, 0, 0, 0.82);
  backdrop-filter: blur(12px) saturate(1.6);
  -webkit-backdrop-filter: blur(12px) saturate(1.6);
  padding: 2px 8px;
  border-radius: 4px;
  white-space: nowrap;
  line-height: 1.5;
  border: 1px solid color-mix(in srgb, var(--gs-color) 30%, transparent);
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.3);
}

/* Animated border trace on first detect — draws around the box */
.gs-hl-trace {
  position: absolute;
  inset: 0;
  border-radius: 4px;
  overflow: hidden;
}
.gs-hl-trace::before {
  content: '';
  position: absolute;
  inset: -50%;
  background: conic-gradient(
    from 0deg,
    transparent 0%,
    var(--gs-color) 10%,
    transparent 20%
  );
  animation: gs-trace-spin 2s linear infinite;
  opacity: 0;
}
.gs-hl-box.entering .gs-hl-trace::before {
  opacity: 0.4;
  animation: gs-trace-spin 1s linear 1;
}
.gs-hl-trace::after {
  content: '';
  position: absolute;
  inset: 1.5px;
  border-radius: 3px;
  background: transparent;
}

@keyframes gs-trace-spin {
  to { transform: rotate(360deg); }
}

/* Confidence bar (thin accent line at bottom) */
.gs-hl-conf {
  position: absolute;
  bottom: -1px;
  left: 0;
  height: 2px;
  background: linear-gradient(90deg, var(--gs-color), transparent);
  opacity: 0.5;
  border-radius: 1px;
  transition: width 0.3s ease;
}

/* ── Scan line ── */
.gs-hl-scan {
  position: absolute;
  left: 0;
  width: 100%;
  height: 2px;
  background: linear-gradient(
    90deg,
    transparent 0%,
    rgba(59, 130, 246, 0.6) 20%,
    rgba(59, 130, 246, 0.9) 50%,
    rgba(59, 130, 246, 0.6) 80%,
    transparent 100%
  );
  box-shadow: 0 0 20px rgba(59, 130, 246, 0.4), 0 0 60px rgba(59, 130, 246, 0.15);
  opacity: 0;
  pointer-events: none;
  will-change: transform, opacity;
}

.gs-hl-scan.active {
  animation: gs-scan 1.8s cubic-bezier(0.16, 1, 0.3, 1) forwards;
}

@keyframes gs-scan {
  0%   { top: 0; opacity: 0; }
  5%   { opacity: 1; }
  90%  { opacity: 1; }
  100% { top: 100%; opacity: 0; }
}

/* ── Pulse on state change ── */
.gs-hl-box.pulse .gs-hl-border {
  animation: gs-pulse 0.6s ease-out;
}

.gs-hl-box.pulse .gs-hl-glow {
  animation: gs-pulse-glow 0.6s ease-out;
}

@keyframes gs-pulse {
  0%   { opacity: 1; transform: scale(1); }
  50%  { opacity: 1; transform: scale(1.02); }
  100% { opacity: 0.6; transform: scale(1); }
}

@keyframes gs-pulse-glow {
  0%   { opacity: 0.4; filter: blur(8px); }
  50%  { opacity: 0.6; filter: blur(12px); }
  100% { opacity: 0.15; filter: blur(4px); }
}

/* ── Fade in/out ── */
.gs-hl-box.entering {
  animation: gs-fade-in 0.35s cubic-bezier(0.16, 1, 0.3, 1) forwards;
}

.gs-hl-box.exiting {
  animation: gs-fade-out 0.25s ease-out forwards;
}

@keyframes gs-fade-in {
  from { opacity: 0; transform: scale(0.97); }
  to   { opacity: 1; transform: scale(1); }
}

@keyframes gs-fade-out {
  from { opacity: 1; transform: scale(1); }
  to   { opacity: 0; transform: scale(0.97); }
}

/* ── Grid background (very subtle) ── */
.gs-hl-grid {
  position: fixed;
  top: 0;
  left: 0;
  width: 100vw;
  height: 100vh;
  pointer-events: none;
  opacity: 0;
  transition: opacity 0.5s ease;
  background-image:
    linear-gradient(rgba(59, 130, 246, 0.03) 1px, transparent 1px),
    linear-gradient(90deg, rgba(59, 130, 246, 0.03) 1px, transparent 1px);
  background-size: 40px 40px;
}

.gs-hl-grid.visible {
  opacity: 1;
}
`;

// ── Build the injection script ──

export function buildHighlightScript(): string {
  const cssJson = JSON.stringify(HIGHLIGHT_CSS);

  return `(function() {
  if (document.getElementById('__gs_highlight_root')) return;

  var host = document.createElement('div');
  host.id = '__gs_highlight_root';
  host.style.cssText = 'position:fixed;top:0;left:0;width:0;height:0;z-index:2147483646;pointer-events:none;';
  document.documentElement.appendChild(host);
  var shadow = host.attachShadow({ mode: 'open' });

  var style = document.createElement('style');
  style.textContent = ${cssJson};
  shadow.appendChild(style);

  var viewport = document.createElement('div');
  viewport.className = 'gs-hl-viewport';
  shadow.appendChild(viewport);

  var grid = document.createElement('div');
  grid.className = 'gs-hl-grid';
  viewport.appendChild(grid);

  var scan = document.createElement('div');
  scan.className = 'gs-hl-scan';
  viewport.appendChild(scan);

  var boxes = {};

  function esc(s) {
    return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
  }

  function getRect(selector) {
    try {
      var el = document.querySelector(selector);
      if (!el) return null;
      var r = el.getBoundingClientRect();
      if (r.width === 0 && r.height === 0) return null;
      return { top: r.top, left: r.left, width: r.width, height: r.height };
    } catch(e) { return null; }
  }

  function createBox(entity) {
    var color = entity.color || '#94a3b8';
    var box = document.createElement('div');
    box.className = 'gs-hl-box entering';
    box.style.setProperty('--gs-color', color);
    box.dataset.entityId = entity.id;

    box.innerHTML =
      '<div class="gs-hl-fill"></div>' +
      '<div class="gs-hl-glow"></div>' +
      '<div class="gs-hl-border"></div>' +
      '<div class="gs-hl-trace"></div>' +
      '<div class="gs-hl-tick tl"></div>' +
      '<div class="gs-hl-tick tr"></div>' +
      '<div class="gs-hl-tick bl"></div>' +
      '<div class="gs-hl-tick br"></div>' +
      (entity.label
        ? '<div class="gs-hl-label">' + esc(entity.label) +
          (entity.confidence != null
            ? ' <span style="opacity:0.4;margin-left:4px">' + Math.round(entity.confidence * 100) + '%</span>'
            : '') +
          '</div>'
        : '') +
      (entity.confidence != null
        ? '<div class="gs-hl-conf" style="width:' + (entity.confidence * 100) + '%"></div>'
        : '');

    viewport.appendChild(box);
    setTimeout(function() { box.classList.remove('entering'); }, 350);
    return box;
  }

  function positionBox(box, rect) {
    box.style.top = rect.top + 'px';
    box.style.left = rect.left + 'px';
    box.style.width = rect.width + 'px';
    box.style.height = rect.height + 'px';
  }

  window.__gs_highlight = {
    update: function(entities) {
      var seen = {};
      for (var i = 0; i < entities.length; i++) {
        var e = entities[i];
        seen[e.id] = true;
        var rect = getRect(e.selector);
        if (!rect) continue;

        if (boxes[e.id]) {
          positionBox(boxes[e.id], rect);
        } else {
          var box = createBox(e);
          positionBox(box, rect);
          boxes[e.id] = box;
        }
      }

      var ids = Object.keys(boxes);
      for (var j = 0; j < ids.length; j++) {
        if (!seen[ids[j]]) {
          var old = boxes[ids[j]];
          old.classList.add('exiting');
          delete boxes[ids[j]];
          setTimeout((function(el) { return function() { el.remove(); }; })(old), 250);
        }
      }
    },

    reposition: function() {
      var ids = Object.keys(boxes);
      for (var i = 0; i < ids.length; i++) {
        var box = boxes[ids[i]];
        var selector = box.dataset.entityId;
        // find the entity in the last update to get the selector
        // fallback: just leave it in place
      }
    },

    scan: function() {
      grid.classList.add('visible');
      scan.classList.remove('active');
      void scan.offsetWidth;
      scan.classList.add('active');
      setTimeout(function() {
        scan.classList.remove('active');
        grid.classList.remove('visible');
      }, 2000);
    },

    pulse: function(entityIds) {
      for (var i = 0; i < entityIds.length; i++) {
        var box = boxes[entityIds[i]];
        if (box) {
          box.classList.remove('pulse');
          void box.offsetWidth;
          box.classList.add('pulse');
          setTimeout((function(b) { return function() { b.classList.remove('pulse'); }; })(box), 600);
        }
      }
    },

    showGrid: function(show) {
      if (show) grid.classList.add('visible');
      else grid.classList.remove('visible');
    },

    clear: function() {
      var ids = Object.keys(boxes);
      for (var i = 0; i < ids.length; i++) {
        boxes[ids[i]].remove();
      }
      boxes = {};
    },

    destroy: function() {
      host.remove();
      delete window.__gs_highlight;
    }
  };
})()`;
}

export function buildHighlightUpdateScript(entities: HighlightEntity[]): string {
  const mapped = entities.map((e) => ({
    id: e.id,
    selector: e.selector,
    label: e.label ?? e.kind,
    color: colorForKind(e.kind),
    confidence: e.confidence ?? null,
  }));
  const json = JSON.stringify(mapped);
  return `(function() { if (window.__gs_highlight) window.__gs_highlight.update(${json}); })()`;
}

export function buildHighlightScanScript(): string {
  return `(function() { if (window.__gs_highlight) window.__gs_highlight.scan(); })()`;
}

export function buildHighlightPulseScript(entityIds: string[]): string {
  const json = JSON.stringify(entityIds);
  return `(function() { if (window.__gs_highlight) window.__gs_highlight.pulse(${json}); })()`;
}

export function buildHighlightClearScript(): string {
  return `(function() { if (window.__gs_highlight) window.__gs_highlight.clear(); })()`;
}

export function buildHighlightDestroyScript(): string {
  return `(function() { if (window.__gs_highlight) window.__gs_highlight.destroy(); })()`;
}
