/**
 * Entity highlight overlay.
 *
 * Visual direction borrows from scan-style developer overlays:
 * persistent boxes, soft glow, restrained labels, and continuous attachment
 * to the viewport as the page scrolls or reflows.
 */

const KIND_COLORS: Record<string, string> = {
  table: "#60a5fa",
  tablerow: "#3b82f6",
  form: "#a78bfa",
  formfield: "#8b5cf6",
  button: "#22d3ee",
  link: "#06b6d4",
  modal: "#f59e0b",
  dialog: "#fb923c",
  menu: "#34d399",
  tab: "#10b981",
  list: "#818cf8",
  listitem: "#6366f1",
  searchresult: "#f472b6",
  pagination: "#94a3b8",
};

const DEFAULT_COLOR = "#94a3b8";

function colorForKind(kind: string): string {
  return KIND_COLORS[kind.toLowerCase()] ?? DEFAULT_COLOR;
}

export interface HighlightEntity {
  id: string;
  kind: string;
  selector: string;
  label?: string;
  confidence?: number;
  showLabel?: boolean;
  renderMode?: "frame" | "heatmap";
  emphasis?: "normal" | "strong";
}

const HIGHLIGHT_CSS = `
* { margin: 0; padding: 0; box-sizing: border-box; }

:host {
  font-family: 'Geist Mono', 'SF Mono', 'Fira Code', 'JetBrains Mono', ui-monospace, monospace;
  -webkit-font-smoothing: antialiased;
}

.gs-hl-viewport {
  position: fixed;
  inset: 0;
  pointer-events: none;
  z-index: 2147483646;
  overflow: hidden;
}

.gs-hl-grid {
  position: absolute;
  inset: 0;
  opacity: 0;
  transition: opacity 0.25s ease;
  background-image:
    linear-gradient(rgba(96, 165, 250, 0.035) 1px, transparent 1px),
    linear-gradient(90deg, rgba(96, 165, 250, 0.035) 1px, transparent 1px);
  background-size: 32px 32px;
}

.gs-hl-grid.visible {
  opacity: 1;
}

.gs-hl-scan {
  position: absolute;
  left: 0;
  width: 100%;
  height: 96px;
  opacity: 0;
  background:
    linear-gradient(180deg, transparent 0%, rgba(96, 165, 250, 0.06) 46%, rgba(96, 165, 250, 0.14) 50%, rgba(96, 165, 250, 0.06) 54%, transparent 100%);
  filter: blur(6px);
}

.gs-hl-scan.active {
  animation: gs-scan 1.15s cubic-bezier(0.16, 1, 0.3, 1) forwards;
}

@keyframes gs-scan {
  0% { transform: translateY(-8%); opacity: 0; }
  10% { opacity: 1; }
  90% { opacity: 1; }
  100% { transform: translateY(108vh); opacity: 0; }
}

.gs-hl-box {
  position: absolute;
  pointer-events: none;
  opacity: 1;
  transform: translateZ(0);
  transition:
    top 0.12s linear,
    left 0.12s linear,
    width 0.12s linear,
    height 0.12s linear,
    opacity 0.2s ease;
}

.gs-hl-box.entering {
  animation: gs-fade-in 0.24s cubic-bezier(0.16, 1, 0.3, 1) forwards;
}

.gs-hl-box.exiting {
  animation: gs-fade-out 0.16s ease-out forwards;
}

@keyframes gs-fade-in {
  from { opacity: 0; transform: scale(0.985); }
  to { opacity: 1; transform: scale(1); }
}

@keyframes gs-fade-out {
  from { opacity: 1; transform: scale(1); }
  to { opacity: 0; transform: scale(0.985); }
}

.gs-hl-fill {
  position: absolute;
  inset: 0;
  border-radius: 8px;
  background: color-mix(in srgb, var(--gs-color) 12%, transparent);
  opacity: 0.18;
}

.gs-hl-border {
  position: absolute;
  inset: 0;
  border-radius: 8px;
  border: 1px solid color-mix(in srgb, var(--gs-color) 88%, white 6%);
  box-shadow:
    inset 0 0 0 1px color-mix(in srgb, var(--gs-color) 30%, transparent),
    0 0 0 1px color-mix(in srgb, var(--gs-color) 16%, transparent);
  opacity: 0.94;
}

.gs-hl-box.strong .gs-hl-fill {
  background: color-mix(in srgb, var(--gs-color) 18%, transparent);
  opacity: 0.28;
}

.gs-hl-box.strong .gs-hl-border {
  border-width: 2px;
  box-shadow:
    inset 0 0 0 1px color-mix(in srgb, var(--gs-color) 38%, transparent),
    0 0 0 1px color-mix(in srgb, var(--gs-color) 20%, transparent),
    0 0 18px color-mix(in srgb, var(--gs-color) 18%, transparent);
  opacity: 1;
}

.gs-hl-box.strong .gs-hl-glow {
  opacity: 0.22;
  filter: blur(12px);
}

.gs-hl-glow {
  position: absolute;
  inset: -4px;
  border-radius: 10px;
  background: color-mix(in srgb, var(--gs-color) 24%, transparent);
  opacity: 0.14;
  filter: blur(10px);
}

.gs-hl-edge {
  position: absolute;
  inset: 0;
  border-radius: 8px;
  overflow: hidden;
}

.gs-hl-edge::before {
  content: '';
  position: absolute;
  inset: -40%;
  opacity: 0;
  background: conic-gradient(from 0deg, transparent 0%, transparent 78%, color-mix(in srgb, var(--gs-color) 82%, white 18%) 88%, transparent 100%);
}

.gs-hl-box.entering .gs-hl-edge::before {
  opacity: 0.65;
  animation: gs-edge-spin 0.9s linear 1;
}

@keyframes gs-edge-spin {
  to { transform: rotate(360deg); }
}

.gs-hl-corners {
  position: absolute;
  inset: 0;
}

.gs-hl-corner {
  position: absolute;
  width: 10px;
  height: 10px;
  border-color: var(--gs-color);
  opacity: 0.85;
}

.gs-hl-corner.tl { top: -1px; left: -1px; border-top: 2px solid; border-left: 2px solid; border-top-left-radius: 8px; }
.gs-hl-corner.tr { top: -1px; right: -1px; border-top: 2px solid; border-right: 2px solid; border-top-right-radius: 8px; }
.gs-hl-corner.bl { bottom: -1px; left: -1px; border-bottom: 2px solid; border-left: 2px solid; border-bottom-left-radius: 8px; }
.gs-hl-corner.br { bottom: -1px; right: -1px; border-bottom: 2px solid; border-right: 2px solid; border-bottom-right-radius: 8px; }

.gs-hl-label {
  position: absolute;
  left: 0;
  top: -26px;
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 4px 8px;
  max-width: min(240px, calc(100vw - 48px));
  border-radius: 999px;
  background: rgba(2, 6, 23, 0.8);
  border: 1px solid color-mix(in srgb, var(--gs-color) 28%, rgba(148,163,184,0.2));
  backdrop-filter: blur(14px) saturate(1.2);
  -webkit-backdrop-filter: blur(14px) saturate(1.2);
  color: #e2e8f0;
  font-size: 10px;
  font-weight: 700;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  box-shadow: 0 8px 16px rgba(2, 6, 23, 0.18);
  opacity: 0;
  transform: translateY(2px);
  transition: opacity 0.16s ease, transform 0.16s ease;
}

.gs-hl-box.labeled .gs-hl-label,
.gs-hl-box.focus .gs-hl-label {
  opacity: 1;
  transform: translateY(0);
}

.gs-hl-box.compact .gs-hl-label {
  display: none;
}

.gs-hl-box.below .gs-hl-label {
  top: auto;
  bottom: -26px;
}

.gs-hl-label-kind {
  color: var(--gs-color);
}

.gs-hl-label-meta {
  color: rgba(148, 163, 184, 0.82);
}

.gs-hl-conf {
  position: absolute;
  left: 0;
  bottom: -2px;
  height: 2px;
  border-radius: 999px;
  background: linear-gradient(90deg, color-mix(in srgb, var(--gs-color) 95%, white 5%), transparent);
  opacity: 0.72;
}

.gs-hl-box.pulse .gs-hl-border {
  animation: gs-pulse-border 0.42s ease-out;
}

.gs-hl-box.pulse .gs-hl-glow {
  animation: gs-pulse-glow 0.42s ease-out;
}

.gs-hl-box.heatmap .gs-hl-border,
.gs-hl-box.heatmap .gs-hl-edge,
.gs-hl-box.heatmap .gs-hl-corners,
.gs-hl-box.heatmap .gs-hl-conf {
  display: none;
}

.gs-hl-box.heatmap .gs-hl-fill {
  border-radius: 6px;
  background:
    linear-gradient(90deg, color-mix(in srgb, var(--gs-color) 22%, transparent), color-mix(in srgb, var(--gs-color) 10%, transparent));
  opacity: 0.22;
}

.gs-hl-box.heatmap .gs-hl-glow {
  inset: -1px;
  border-radius: 6px;
  opacity: 0.08;
  filter: blur(6px);
}

.gs-hl-box.heatmap.compact .gs-hl-fill {
  opacity: 0.16;
}

@keyframes gs-pulse-border {
  0% { transform: scale(1); opacity: 1; }
  50% { transform: scale(1.016); opacity: 1; }
  100% { transform: scale(1); opacity: 0.94; }
}

@keyframes gs-pulse-glow {
  0% { opacity: 0.14; filter: blur(10px); }
  50% { opacity: 0.32; filter: blur(16px); }
  100% { opacity: 0.14; filter: blur(10px); }
}
`;

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
  var entityMap = {};
  var raf = 0;

  function esc(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  function getRect(selector) {
    try {
      var el = document.querySelector(selector);
      if (!el) return null;
      var r = el.getBoundingClientRect();
      if (r.width <= 0 || r.height <= 0) return null;
      return { top: r.top, left: r.left, width: r.width, height: r.height };
    } catch (e) {
      return null;
    }
  }

  function metaText(entity) {
    if (entity.confidence == null) return '';
    return Math.round(entity.confidence * 100) + '%';
  }

  function createBox(entity) {
    var color = entity.color || '#94a3b8';
    var box = document.createElement('div');
    box.className = 'gs-hl-box entering';
    box.style.setProperty('--gs-color', color);
    box.dataset.entityId = entity.id;
    if (entity.showLabel) box.classList.add('labeled');
    if (entity.renderMode === 'heatmap') box.classList.add('heatmap');
    if (entity.emphasis === 'strong') box.classList.add('strong');

    box.innerHTML =
      '<div class="gs-hl-fill"></div>' +
      '<div class="gs-hl-glow"></div>' +
      '<div class="gs-hl-border"></div>' +
      '<div class="gs-hl-edge"></div>' +
      '<div class="gs-hl-corners">' +
        '<div class="gs-hl-corner tl"></div>' +
        '<div class="gs-hl-corner tr"></div>' +
        '<div class="gs-hl-corner bl"></div>' +
        '<div class="gs-hl-corner br"></div>' +
      '</div>' +
      '<div class="gs-hl-label"><span class="gs-hl-label-kind">' + esc(entity.label || entity.kind) + '</span>' +
      (metaText(entity) ? '<span class="gs-hl-label-meta">' + esc(metaText(entity)) + '</span>' : '') +
      '</div>' +
      (entity.confidence != null
        ? '<div class="gs-hl-conf" style="width:' + (entity.confidence * 100) + '%"></div>'
        : '');

    viewport.appendChild(box);
    setTimeout(function() { box.classList.remove('entering'); }, 240);
    return box;
  }

  function positionBox(box, rect) {
    box.style.top = rect.top + 'px';
    box.style.left = rect.left + 'px';
    box.style.width = rect.width + 'px';
    box.style.height = rect.height + 'px';

    box.classList.toggle('compact', rect.width < 84 || rect.height < 26);
    box.classList.toggle('below', rect.top < 32);
  }

  function scheduleReposition() {
    if (raf) return;
    raf = requestAnimationFrame(function() {
      raf = 0;
      reposition();
    });
  }

  function reposition() {
    var ids = Object.keys(boxes);
    for (var i = 0; i < ids.length; i++) {
      var id = ids[i];
      var entity = entityMap[id];
      if (!entity) continue;
      var rect = getRect(entity.selector);
      if (!rect) {
        boxes[id].style.opacity = '0';
        continue;
      }
      boxes[id].style.opacity = '';
      positionBox(boxes[id], rect);
    }
  }

  window.addEventListener('scroll', scheduleReposition, true);
  window.addEventListener('resize', scheduleReposition, true);

  window.__gs_highlight = {
    update: function(entities) {
      var seen = {};
      for (var i = 0; i < entities.length; i++) {
        var entity = entities[i];
        seen[entity.id] = true;
        entityMap[entity.id] = entity;
        var rect = getRect(entity.selector);
        if (!rect) continue;

        if (!boxes[entity.id]) {
          boxes[entity.id] = createBox(entity);
        } else {
          boxes[entity.id].classList.toggle('labeled', Boolean(entity.showLabel));
          boxes[entity.id].classList.toggle('heatmap', entity.renderMode === 'heatmap');
          boxes[entity.id].classList.toggle('strong', entity.emphasis === 'strong');
        }
        positionBox(boxes[entity.id], rect);
      }

      var ids = Object.keys(boxes);
      for (var j = 0; j < ids.length; j++) {
        var id = ids[j];
        if (!seen[id]) {
          var old = boxes[id];
          old.classList.add('exiting');
          delete boxes[id];
          delete entityMap[id];
          setTimeout((function(el) { return function() { el.remove(); }; })(old), 160);
        }
      }

      scheduleReposition();
    },

    reposition: function() {
      scheduleReposition();
    },

    scan: function() {
      grid.classList.add('visible');
      scan.classList.remove('active');
      void scan.offsetWidth;
      scan.classList.add('active');
      setTimeout(function() {
        scan.classList.remove('active');
        grid.classList.remove('visible');
      }, 1250);
    },

    pulse: function(entityIds) {
      for (var i = 0; i < entityIds.length; i++) {
        var box = boxes[entityIds[i]];
        if (!box) continue;
        box.classList.remove('pulse');
        box.classList.add('focus');
        void box.offsetWidth;
        box.classList.add('pulse');
        setTimeout((function(node) { return function() { node.classList.remove('pulse'); node.classList.remove('focus'); }; })(box), 900);
      }
    },

    clear: function() {
      var ids = Object.keys(boxes);
      for (var i = 0; i < ids.length; i++) {
        boxes[ids[i]].remove();
      }
      boxes = {};
      entityMap = {};
    },

    destroy: function() {
      if (raf) cancelAnimationFrame(raf);
      window.removeEventListener('scroll', scheduleReposition, true);
      window.removeEventListener('resize', scheduleReposition, true);
      host.remove();
      delete window.__gs_highlight;
    }
  };
})()`;
}

export function buildHighlightUpdateScript(entities: HighlightEntity[]): string {
  const mapped = entities.map((entity) => ({
    id: entity.id,
    kind: entity.kind,
    selector: entity.selector,
    label: entity.label ?? entity.kind,
    color: colorForKind(entity.kind),
    confidence: entity.confidence ?? null,
    showLabel: entity.showLabel ?? false,
    renderMode: entity.renderMode ?? "frame",
    emphasis: entity.emphasis ?? "normal",
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
