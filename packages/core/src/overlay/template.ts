/**
 * Overlay UI — compact live inspector.
 *
 * Keeps the existing Groundstate data model, but shifts the visual treatment
 * closer to a modern scan/debug overlay: always-on, compact, fast, and calm.
 */

const OVERLAY_CSS = `
* { margin: 0; padding: 0; box-sizing: border-box; }

:host {
  font-family: 'Geist Mono', 'SF Mono', 'Fira Code', 'JetBrains Mono', ui-monospace, monospace;
  font-size: 12px;
  color: #e2e8f0;
  line-height: 1.5;
  -webkit-font-smoothing: antialiased;
}

.gs {
  position: fixed;
  top: 16px;
  right: 16px;
  width: 340px;
  pointer-events: auto;
  border-radius: 16px;
  overflow: hidden;
  user-select: none;
  background:
    linear-gradient(180deg, rgba(18, 24, 38, 0.92), rgba(8, 12, 22, 0.88)),
    radial-gradient(circle at top right, rgba(59, 130, 246, 0.14), transparent 42%);
  backdrop-filter: blur(30px) saturate(1.35);
  -webkit-backdrop-filter: blur(30px) saturate(1.35);
  border: 1px solid rgba(148, 163, 184, 0.16);
  box-shadow:
    0 0 0 1px rgba(15, 23, 42, 0.45),
    0 16px 48px rgba(2, 6, 23, 0.42),
    0 0 48px rgba(59, 130, 246, 0.08);
  transition: opacity 0.2s ease, transform 0.2s ease, box-shadow 0.2s ease;
}

.gs.collapsed .gs-body { display: none; }

.gs.dragging {
  opacity: 0.96;
  transform: scale(0.995);
  transition: none;
  box-shadow:
    0 0 0 1px rgba(59, 130, 246, 0.28),
    0 22px 56px rgba(2, 6, 23, 0.5),
    0 0 60px rgba(59, 130, 246, 0.12);
}

.gs-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 12px 14px;
  cursor: grab;
  border-bottom: 1px solid rgba(148, 163, 184, 0.12);
  background: linear-gradient(180deg, rgba(255,255,255,0.035), rgba(255,255,255,0.015));
}
.gs-header:active { cursor: grabbing; }

.gs-header-left {
  display: flex;
  align-items: center;
  gap: 10px;
  min-width: 0;
}

.gs-dot {
  width: 8px;
  height: 8px;
  border-radius: 999px;
  background: #22c55e;
  flex-shrink: 0;
  box-shadow: 0 0 0 4px rgba(34, 197, 94, 0.08), 0 0 10px rgba(34, 197, 94, 0.45);
  transition: background 0.2s ease, box-shadow 0.2s ease;
}
.gs-dot.working {
  background: #60a5fa;
  box-shadow: 0 0 0 4px rgba(96, 165, 250, 0.09), 0 0 14px rgba(59, 130, 246, 0.55);
  animation: gs-breathe 1.5s ease-in-out infinite;
}
.gs-dot.error {
  background: #f87171;
  box-shadow: 0 0 0 4px rgba(248, 113, 113, 0.08), 0 0 12px rgba(248, 113, 113, 0.4);
}

@keyframes gs-breathe {
  0%, 100% { transform: scale(1); opacity: 1; }
  50% { transform: scale(1.28); opacity: 0.5; }
}

.gs-header-title {
  font-size: 10px;
  font-weight: 700;
  letter-spacing: 0.14em;
  text-transform: uppercase;
  color: rgba(226, 232, 240, 0.7);
}

.gs-collapse-btn {
  min-width: 28px;
  height: 24px;
  background: rgba(255, 255, 255, 0.025);
  border: 1px solid rgba(148, 163, 184, 0.14);
  color: rgba(226, 232, 240, 0.55);
  cursor: pointer;
  font-size: 11px;
  font-family: inherit;
  line-height: 1;
  padding: 0 8px;
  border-radius: 999px;
  transition: all 0.15s ease;
}
.gs-collapse-btn:hover {
  background: rgba(59, 130, 246, 0.08);
  border-color: rgba(96, 165, 250, 0.24);
  color: rgba(241, 245, 249, 0.9);
}

.gs-body { padding: 0; }

.gs-status {
  padding: 14px 14px 12px;
}

.gs-status-label {
  font-size: 15px;
  font-weight: 700;
  color: #f8fafc;
  letter-spacing: -0.02em;
  margin-bottom: 3px;
}

.gs-status-detail {
  font-size: 11px;
  color: rgba(191, 219, 254, 0.72);
  letter-spacing: 0.04em;
  text-transform: uppercase;
}

.gs-pills {
  display: flex;
  gap: 6px;
  padding: 0 14px 12px;
  flex-wrap: wrap;
}

.gs-pill {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 4px 8px;
  border-radius: 999px;
  font-size: 10px;
  font-weight: 600;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  background: rgba(148, 163, 184, 0.08);
  border: 1px solid rgba(148, 163, 184, 0.12);
  color: rgba(226, 232, 240, 0.44);
}

.gs-pill-value {
  font-weight: 700;
  color: #f8fafc;
}

.gs-entities {
  padding: 0 14px 12px;
  display: flex;
  gap: 5px;
  flex-wrap: wrap;
}

.gs-entity-tag {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  padding: 3px 8px;
  border-radius: 999px;
  font-size: 10px;
  font-weight: 700;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  border: 1px solid color-mix(in srgb, var(--gs-tag-color, rgba(255,255,255,0.1)) 58%, transparent);
  color: var(--gs-tag-color, rgba(255,255,255,0.52));
  background: color-mix(in srgb, var(--gs-tag-color, rgba(255,255,255,0.04)) 9%, rgba(15,23,42,0.55));
}

.gs-entity-count {
  opacity: 0.72;
}

.gs-section {
  border-top: 1px solid rgba(148, 163, 184, 0.1);
  padding: 12px 14px 14px;
}

.gs-section-title {
  font-size: 10px;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 0.14em;
  color: rgba(148, 163, 184, 0.55);
  margin-bottom: 8px;
}

.gs-activity {
  display: flex;
  flex-direction: column;
  gap: 4px;
  max-height: 168px;
  overflow-y: auto;
  scrollbar-width: none;
}
.gs-activity::-webkit-scrollbar { display: none; }

.gs-activity-item {
  font-size: 11px;
  color: rgba(203, 213, 225, 0.54);
  line-height: 1.45;
  padding: 4px 6px;
  border-radius: 8px;
  font-variant-numeric: tabular-nums;
  background: rgba(15, 23, 42, 0.28);
}

.gs-activity-item.latest {
  color: #f8fafc;
  background: linear-gradient(90deg, rgba(59, 130, 246, 0.14), rgba(15, 23, 42, 0.35));
}

.gs-empty {
  font-size: 11px;
  color: rgba(148, 163, 184, 0.48);
}

.gs-footer {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 10px 14px;
  border-top: 1px solid rgba(148, 163, 184, 0.1);
  background: rgba(2, 6, 23, 0.22);
}

.gs-footer-label {
  font-size: 10px;
  color: rgba(148, 163, 184, 0.48);
  letter-spacing: 0.08em;
  text-transform: uppercase;
}

.gs-footer-version {
  font-size: 10px;
  color: rgba(96, 165, 250, 0.84);
  font-weight: 700;
  letter-spacing: 0.08em;
}

.gs-footer-version.flash {
  animation: gs-version-flash 0.45s ease-out;
}

@keyframes gs-version-flash {
  0% { color: rgba(191, 219, 254, 1); }
  100% { color: rgba(96, 165, 250, 0.84); }
}
`;

const OVERLAY_HTML = `
<div class="gs-header" data-gs-drag>
  <div class="gs-header-left">
    <div class="gs-dot" data-gs-dot></div>
    <span class="gs-header-title">groundstate scan</span>
  </div>
  <button class="gs-collapse-btn" data-gs-toggle>−</button>
</div>
<div class="gs-body">
  <div class="gs-status">
    <div class="gs-status-label" data-gs-label>Initializing…</div>
    <div class="gs-status-detail" data-gs-detail></div>
  </div>
  <div class="gs-pills" data-gs-pills></div>
  <div class="gs-entities" data-gs-entities></div>
  <div class="gs-section">
    <div class="gs-section-title">Activity</div>
    <div class="gs-activity" data-gs-feed>
      <div class="gs-empty">Waiting for first event…</div>
    </div>
  </div>
</div>
<div class="gs-footer">
  <span class="gs-footer-label">graph</span>
  <span class="gs-footer-version" data-gs-version>v0</span>
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
    toggle.textContent = container.classList.contains('collapsed') ? '+' : '−';
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

  var kindColors = {
    table: '#3b82f6', tablerow: '#3b82f6',
    form: '#8b5cf6', formfield: '#8b5cf6',
    button: '#06b6d4', link: '#06b6d4',
    modal: '#f59e0b', dialog: '#f59e0b',
    menu: '#10b981', tab: '#10b981',
    list: '#6366f1', listitem: '#6366f1',
    searchresult: '#ec4899', pagination: '#64748b'
  };

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

      var entities = shadow.querySelector('[data-gs-entities]');
      if (state.entitySummary && state.entitySummary.length > 0) {
        entities.innerHTML = state.entitySummary.map(function(e) {
          var color = kindColors[e.kind.toLowerCase()] || '#94a3b8';
          return '<span class="gs-entity-tag" style="--gs-tag-color:' + color + '">' +
            esc(e.kind) + ' <span class="gs-entity-count">' + e.count + '</span></span>';
        }).join('');
        entities.style.display = '';
      } else {
        entities.style.display = 'none';
      }

      var feed = shadow.querySelector('[data-gs-feed]');
      if (state.activity && state.activity.length > 0) {
        feed.innerHTML = state.activity.map(function(item, i) {
          var cls = i === state.activity.length - 1 ? 'gs-activity-item latest' : 'gs-activity-item';
          return '<div class="' + cls + '">' + esc(item) + '</div>';
        }).join('');
        feed.scrollTop = feed.scrollHeight;
      }

      var ver = shadow.querySelector('[data-gs-version]');
      if (state.graphVersion != null) {
        var newText = 'v' + state.graphVersion;
        if (ver.textContent !== newText) {
          ver.textContent = newText;
          ver.classList.remove('flash');
          void ver.offsetWidth;
          ver.classList.add('flash');
        }
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

export interface OverlayViewState {
  dotClass: "" | "working" | "error";
  label: string;
  detail: string;
  pills: { label: string; value: string }[];
  activity: string[];
  entitySummary?: { kind: string; count: number }[];
  graphVersion?: number;
}

export type OverlayState = OverlayViewState;
export type OverlayAction = { type: string; name: string; result?: string };
export type OverlayEntityGroup = { kind: string; count: number; status: string };
export type OverlayTraceEntry = { type: string; summary: string; offsetMs?: number };
