/**
 * Minimal CDP client for Suite B tests.
 * Provides the transport layer without any Groundstate runtime —
 * tests exercise extraction/validation logic in TypeScript mirroring the Rust core.
 */

import WebSocket from "ws";
import { spawn, type ChildProcess } from "child_process";
import * as fs from "fs";
import { writeFileSync } from "node:fs";

const CHROME_PATHS = [
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary",
  "/usr/bin/google-chrome",
  "/usr/bin/chromium-browser",
];

export class CdpClient {
  private ws!: WebSocket;
  private nextId = 1;
  private pending = new Map<
    number,
    { resolve: (v: any) => void; reject: (e: Error) => void }
  >();

  async connect(wsUrl: string) {
    this.ws = new WebSocket(wsUrl);
    await new Promise<void>((resolve, reject) => {
      this.ws.once("open", resolve);
      this.ws.once("error", reject);
    });
    this.ws.on("message", (data) => {
      const msg = JSON.parse(data.toString());
      if (msg.id !== undefined && this.pending.has(msg.id)) {
        const p = this.pending.get(msg.id)!;
        this.pending.delete(msg.id);
        if (msg.error) p.reject(new Error(msg.error.message));
        else p.resolve(msg.result);
      }
    });
    await this.send("Page.enable", {});
    await this.send("DOM.enable", {});
    await this.send("Runtime.enable", {});
  }

  send(method: string, params: any = {}): Promise<any> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error(`CDP timeout: ${method}`));
        }
      }, 15000);
    });
  }

  async navigate(url: string) {
    await this.send("Page.navigate", { url });
    await sleep(1200);
  }

  async evalJS<T = any>(expression: string): Promise<T> {
    const { result } = await this.send("Runtime.evaluate", {
      expression,
      returnByValue: true,
      awaitPromise: true,
    });
    return result?.value as T;
  }

  async click(selector: string) {
    await this.evalJS(
      `document.querySelector(${JSON.stringify(selector)})?.click()`,
    );
    await sleep(350);
  }

  async fill(selector: string, value: string) {
    await this.evalJS(
      `(() => {
        const el = document.querySelector(${JSON.stringify(selector)});
        if (!el) return false;
        el.focus?.();
        el.value = ${JSON.stringify(value)};
        el.dispatchEvent(new Event("input", { bubbles: true }));
        el.dispatchEvent(new Event("change", { bubbles: true }));
        return true;
      })()`,
    );
    await sleep(150);
  }

  async text(selector: string): Promise<string | null> {
    return this.evalJS(
      `document.querySelector(${JSON.stringify(selector)})?.textContent?.trim() ?? null`,
    );
  }

  async exists(selector: string): Promise<boolean> {
    return this.evalJS(
      `Boolean(document.querySelector(${JSON.stringify(selector)}))`,
    );
  }

  async isDisabled(selector: string): Promise<boolean> {
    return this.evalJS(
      `Boolean(document.querySelector(${JSON.stringify(selector)})?.disabled)`,
    );
  }

  async browserVersion(): Promise<string> {
    const result = await this.send("Browser.getVersion", {});
    return String(result.product ?? "");
  }

  async screenshot(): Promise<Buffer> {
    const result = await this.send("Page.captureScreenshot", { format: "png" });
    return Buffer.from(String(result.data ?? ""), "base64");
  }

  async saveScreenshot(filePath: string): Promise<void> {
    writeFileSync(filePath, await this.screenshot());
  }

  async waitFor(
    predicateExpression: string,
    opts: { timeoutMs?: number; intervalMs?: number } = {},
  ): Promise<void> {
    const timeoutMs = opts.timeoutMs ?? 5000;
    const intervalMs = opts.intervalMs ?? 100;
    const started = Date.now();

    while (Date.now() - started <= timeoutMs) {
      const passed = await this.evalJS<boolean>(predicateExpression);
      if (passed) return;
      await sleep(intervalMs);
    }

    throw new Error(`waitFor timeout: ${predicateExpression}`);
  }

  async extractEntities(): Promise<any[]> {
    return this.evalJS(`
      (() => {
        const normalize = (value) => (value ?? '').replace(/\\s+/g, ' ').trim();
        const sanitize = (value) =>
          normalize(value)
            .toLowerCase()
            .replace(/[^a-z0-9]+/g, '-')
            .replace(/^-+|-+$/g, '');
        const cssEscape = (value) => {
          if (globalThis.CSS?.escape) return globalThis.CSS.escape(String(value));
          return String(value).replace(/\\\\/g, '\\\\\\\\').replace(/"/g, '\\\\"');
        };
        const selectorFor = (element) => {
          if (element.id) return '#' + cssEscape(element.id);
          if (element.getAttribute('name')) {
            return element.tagName.toLowerCase() + '[name="' + cssEscape(element.getAttribute('name')) + '"]';
          }
          if (element.tagName.toLowerCase() === 'a' && element.getAttribute('href')) {
            return 'a[href="' + cssEscape(element.getAttribute('href')) + '"]';
          }
          let current = element;
          const parts = [];
          while (current && current.nodeType === Node.ELEMENT_NODE && parts.length < 5) {
            let part = current.tagName.toLowerCase();
            if (current.parentElement) {
              const siblings = Array.from(current.parentElement.children).filter((child) => child.tagName === current.tagName);
              if (siblings.length > 1) {
                part += ':nth-of-type(' + (siblings.indexOf(current) + 1) + ')';
              }
            }
            parts.unshift(part);
            current = current.parentElement;
          }
          return parts.join(' > ');
        };
        const entity = (id, kind, source, confidence, props = {}) => ({
          id,
          _ref: '@e:' + id,
          _entity: kind,
          _source: source,
          _confidence: confidence,
          ...props,
        });
        const looksLikeContentLink = (element, text, href) => {
          const hrefLower = String(href).toLowerCase();
          if (text.length < 18) return false;
          if (!/\\s/.test(text) && text.includes('.')) return false;
          if (!href || href.startsWith('#')) return false;
          if (hrefLower.startsWith('javascript:') || hrefLower.startsWith('mailto:') || hrefLower.startsWith('tel:')) return false;
          if (element.closest('nav, header, footer, aside')) return false;
          return true;
        };
        const rowIdentity = (el, fallback) => {
          const attrs = [
            'data-row-id',
            'data-id',
            'data-order-id',
            'data-employee-id',
            'data-item-id',
            'data-key',
          ];
          for (const attr of attrs) {
            const value = el.getAttribute(attr);
            if (value) return value;
          }
          return fallback;
        };

        const entities = [];
        const ownThead = (tbl) => tbl.querySelector(':scope > thead') || null;
        const ownTbody = (tbl) => tbl.querySelector(':scope > tbody') || tbl;
        const ownHeaders = (tbl) => {
          const thead = ownThead(tbl);
          const ths = thead
            ? [...thead.querySelectorAll(':scope > tr > th')]
            : [...(tbl.querySelector(':scope > tr')?.querySelectorAll(':scope > th') || [])];
          return ths;
        };
        const isVisible = (el) => {
          if (!el) return false;
          const style = window.getComputedStyle(el);
          return style.display !== 'none' && style.visibility !== 'hidden' && style.opacity !== '0';
        };
        const ownRows = (tbl) => {
          const tbody = tbl.querySelector(':scope > tbody');
          const candidates = tbody
            ? [...tbody.querySelectorAll(':scope > tr')]
            : [...tbl.querySelectorAll(':scope > tr')].filter(tr => tr.querySelector(':scope > td'));
          return candidates.filter(tr => isVisible(tr));
        };
        document.querySelectorAll('table').forEach((table, ti) => {
          const id = table.id || 'table-' + ti;
          const headerEls = ownHeaders(table);
          const headers = headerEls.map(th => th.textContent.trim());
          const sortedTh = headerEls.find(
            th => th.classList.contains('sorted-asc') || th.classList.contains('sorted-desc')
          );
          const dataRows = ownRows(table).filter(
            tr => tr.querySelector(':scope > td')
          );
          entities.push(entity(
            id, 'Table', '#' + id, 0.9,
            {
            headers, row_count: dataRows.length,
            sorted_by: sortedTh ? sortedTh.textContent.trim() : null,
            sort_direction: sortedTh ? (sortedTh.classList.contains('sorted-asc') ? 'asc' : 'desc') : null,
            }
          ));
          dataRows.forEach((tr, ri) => {
            const cells = [...tr.querySelectorAll(':scope > td')].map(td => td.textContent.trim());
            const row = entity(
              id+'-row-'+rowIdentity(tr, ri),
              'TableRow',
              '#'+id+' tbody tr:nth-child('+(ri+1)+')',
              0.85,
              {
              _cells: cells
              }
            );
            headers.forEach((h, i) => { row[h] = cells[i] || ''; });
            entities.push(row);
          });
        });
        // Forms
        document.querySelectorAll('form').forEach((form, fi) => {
          const id = form.id || 'form-' + fi;
          const fields = [...form.querySelectorAll('input, select, textarea')].map(el => ({
            name: el.getAttribute('name') || el.id || '',
            type: el.getAttribute('type') || el.tagName.toLowerCase(),
            value: el.value,
            hasError: el.classList.contains('error') || el.getAttribute('aria-invalid') === 'true',
          }));
          entities.push(entity(id, 'Form', '#' + id, 0.85, { fields }));
        });
        // Modals
        document.querySelectorAll('[role="dialog"], .modal, dialog').forEach((el, mi) => {
          const style = window.getComputedStyle(el);
          const visible = style.display !== 'none' && style.visibility !== 'hidden' && style.opacity !== '0' && !!(el.offsetWidth || el.offsetHeight || el.getClientRects().length);
          if (!visible) return;
          entities.push(entity(
            'modal-' + mi,
            'Modal',
            selectorFor(el),
            0.9,
            { text: el.textContent?.trim().slice(0, 200) || '', visible: true }
          ));
        });
        // Buttons
        document.querySelectorAll('button:not(th button)').forEach((btn, bi) => {
          entities.push(entity(
            btn.id || ('btn-' + bi),
            'Button',
            selectorFor(btn),
            0.8,
            {
              label: normalize(btn.textContent || btn.value || btn.getAttribute('aria-label')),
              disabled: btn.disabled,
            }
          ));
        });
        // Links and search-like results
        document.querySelectorAll('a[href]').forEach((link, li) => {
          const href = link.getAttribute('href') || '';
          const text = normalize(link.textContent || link.getAttribute('title'));
          if (!text) return;
          const id = link.id || ('link-' + sanitize(href + '-' + text + '-' + li));
          const source = selectorFor(link);
          entities.push(entity(id, 'Link', source, 0.92, {
            href,
            text,
            title: link.getAttribute('title'),
          }));
          if (looksLikeContentLink(link, text, href)) {
            entities.push(entity(
              'result-' + sanitize(href + '-' + text + '-' + li),
              'SearchResult',
              source,
              0.84,
              { href, title: text, position: li + 1 }
            ));
          }
        });
        // Lists and list items
        document.querySelectorAll('ul, ol, [role="list"]').forEach((list, listIndex) => {
          const items = Array.from(list.querySelectorAll(':scope > li, :scope > [role="listitem"]'));
          const listId = list.id || ('list-' + listIndex);
          entities.push(entity(listId, 'List', selectorFor(list), 0.86, {
            item_count: items.length,
            ordered: list.tagName.toLowerCase() === 'ol',
          }));
          items.forEach((item, itemIndex) => {
            const text = normalize(item.textContent);
            if (!text) return;
            const primaryLink = item.querySelector('a[href]');
            const primaryHref = primaryLink?.getAttribute('href') || null;
            const primaryText = normalize(primaryLink?.textContent) || null;
            entities.push(entity(
              listId + '-item-' + itemIndex + '-' + sanitize(text || String(itemIndex)),
              'ListItem',
              selectorFor(item),
              0.8,
              {
                text,
                index: itemIndex + 1,
                primary_href: primaryHref,
                primary_text: primaryText,
              }
            ));
          });
        });
        return entities;
      })()
    `);
  }

  close() {
    this.ws?.close();
  }
}

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export function findChrome(): string {
  const found = CHROME_PATHS.find((p) => fs.existsSync(p));
  if (!found) throw new Error("Chrome not found");
  return found;
}

export async function launchChrome(
  port: number,
  opts: { headless?: boolean; windowSize?: { width: number; height: number } } = {},
): Promise<ChildProcess> {
  const chrome = findChrome();
  const headless = opts.headless ?? true;
  const width = opts.windowSize?.width ?? 1440;
  const height = opts.windowSize?.height ?? 960;
  const proc = spawn(
    chrome,
    [
      `--remote-debugging-port=${port}`,
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-extensions",
      "--disable-background-networking",
      `--window-size=${width},${height}`,
      `--user-data-dir=/tmp/gs-suite-b-${process.pid}`,
      ...(headless ? ["--headless=new", "--disable-gpu"] : []),
    ],
    { stdio: "ignore" },
  );
  await sleep(headless ? 2000 : 3000);
  return proc;
}

export async function getPageWsUrl(port: number): Promise<string> {
  for (let i = 0; i < 20; i++) {
    try {
      const resp = await fetch(`http://127.0.0.1:${port}/json/list`);
      const targets = (await resp.json()) as any[];
      const page = targets.find((t: any) => t.type === "page");
      if (page?.webSocketDebuggerUrl) return page.webSocketDebuggerUrl;
    } catch {}
    await sleep(250);
  }
  const resp = await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, {
    method: "PUT",
  });
  const target = (await resp.json()) as any;
  return target.webSocketDebuggerUrl;
}
