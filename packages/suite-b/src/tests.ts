/**
 * Suite B: Transport realism tests.
 *
 * Real browser. Fixed deterministic scripts. No model.
 * Tests that the runtime's extraction, action derivation, and state
 * tracking work correctly against real DOM behavior.
 */

import { type TestCase } from "./harness.js";
import { assert, assertEqual } from "./harness.js";
import { sleep } from "./cdp.js";

// ── Invoice portal (base fixture) ──

export const invoiceExtraction: TestCase = {
  name: "Invoice table: extract entities from live DOM",
  fixture: "invoices.html",
  run: async (cdp) => {
    const entities = await cdp.extractEntities();
    const tables = entities.filter((e) => e._entity === "Table");
    const rows = entities.filter((e) => e._entity === "TableRow");

    assert(tables.length === 1, `expected 1 table, got ${tables.length}`);
    assert(rows.length === 6, `expected 6 rows, got ${rows.length}`);

    const table = tables[0]!;
    assertEqual(
      table.headers,
      ["Vendor", "Amount", "Status", "Due Date"],
      "table headers",
    );
    assert(table.row_count === 6, `expected row_count 6, got ${table.row_count}`);

    // Verify row data is correctly extracted
    const acme = rows.find((r) => r.Vendor === "Acme Corp");
    assert(acme !== undefined, "Acme Corp row not found");
    assertEqual(acme.Amount, "15000", "Acme amount");
    assertEqual(acme.Status, "Unpaid", "Acme status");
  },
};

export const invoiceSort: TestCase = {
  name: "Invoice table: sort click changes DOM order and sort state",
  fixture: "invoices.html",
  run: async (cdp) => {
    // Before sort: no sort indicator
    const before = await cdp.extractEntities();
    const tableBefore = before.find((e) => e._entity === "Table")!;
    assert(tableBefore.sorted_by === null, "should not be sorted initially");

    // Click Amount header
    await cdp.click("#invoices th:nth-child(2)");

    // After sort: sort indicator present, rows reordered
    const after = await cdp.extractEntities();
    const tableAfter = after.find((e) => e._entity === "Table")!;
    assert(tableAfter.sorted_by === "Amount", `expected sorted_by Amount, got ${tableAfter.sorted_by}`);
    assert(tableAfter.sort_direction === "asc", `expected asc, got ${tableAfter.sort_direction}`);

    // Verify row order
    const rows = after.filter((e) => e._entity === "TableRow");
    const amounts = rows.map((r) => parseFloat(r.Amount));
    for (let i = 1; i < amounts.length; i++) {
      assert(
        amounts[i]! >= amounts[i - 1]!,
        `rows not sorted: ${amounts[i - 1]} > ${amounts[i]} at index ${i}`,
      );
    }
  },
};

export const invoiceQueryFilter: TestCase = {
  name: "Invoice table: filter unpaid > 10k matches 3 rows",
  fixture: "invoices.html",
  run: async (cdp) => {
    const entities = await cdp.extractEntities();
    const rows = entities.filter((e) => e._entity === "TableRow");

    const unpaidLarge = rows.filter(
      (r) => r.Status === "Unpaid" && parseFloat(r.Amount) > 10000,
    );

    assert(
      unpaidLarge.length === 3,
      `expected 3 unpaid > 10k, got ${unpaidLarge.length}`,
    );

    const vendors = unpaidLarge.map((r) => r.Vendor).sort();
    assertEqual(
      vendors,
      ["Acme Corp", "Initech", "Stark Industries"],
      "unpaid vendors",
    );
  },
};

export const invoiceEntityIdentity: TestCase = {
  name: "Invoice table: entity IDs are stable across re-extraction",
  fixture: "invoices.html",
  run: async (cdp) => {
    const first = await cdp.extractEntities();
    const second = await cdp.extractEntities();

    // Same number of entities
    assertEqual(first.length, second.length, "entity count");

    // Same IDs in same order
    const ids1 = first.map((e) => e.id);
    const ids2 = second.map((e) => e.id);
    assertEqual(ids1, ids2, "entity IDs");
  },
};

// ── Rerender fixture ──

export const rerenderReconciliation: TestCase = {
  name: "Rerender: entities survive full DOM replacement",
  fixture: "rerender.html",
  run: async (cdp) => {
    // Extract before rerender
    const before = await cdp.extractEntities();
    const rowsBefore = before.filter((e) => e._entity === "TableRow");
    assert(rowsBefore.length > 0, "should have rows before rerender");

    // Trigger rerender (replaces innerHTML)
    await cdp.click("#trigger-btn");
    await sleep(500);

    // Extract after rerender
    const after = await cdp.extractEntities();
    const rowsAfter = after.filter((e) => e._entity === "TableRow");

    // Same number of rows
    assertEqual(rowsBefore.length, rowsAfter.length, "row count after rerender");

    // Same data content (even though DOM nodes are new)
    for (let i = 0; i < rowsBefore.length; i++) {
      assertEqual(
        rowsBefore[i]!._cells,
        rowsAfter[i]!._cells,
        `row ${i} cells after rerender`,
      );
    }
  },
};

// ── Modal interrupt fixture ──

export const modalDetection: TestCase = {
  name: "Modal: detected when opened, gone when closed",
  fixture: "modal-interrupt.html",
  run: async (cdp) => {
    // No modal initially
    const before = await cdp.extractEntities();
    const modalsBefore = before.filter((e) => e._entity === "Modal");
    assert(modalsBefore.length === 0, "no modal initially");

    // Click first delete button to trigger modal
    await cdp.click("tbody tr:first-child .btn-delete");
    await sleep(300);

    // Modal should be detected
    const during = await cdp.extractEntities();
    const modalsDuring = during.filter((e) => e._entity === "Modal");
    assert(modalsDuring.length === 1, `expected 1 modal, got ${modalsDuring.length}`);
    assert(
      modalsDuring[0]!.text.includes("Are you sure"),
      "modal should contain confirmation text",
    );

    // Close the modal
    await cdp.click("#modal-cancel");
    await sleep(300);

    // Modal gone
    const after = await cdp.extractEntities();
    const modalsAfter = after.filter((e) => e._entity === "Modal");
    assert(modalsAfter.length === 0, "modal should be gone after cancel");
  },
};

// ── Lazy load fixture ──

export const lazyLoadNewEntities: TestCase = {
  name: "Lazy load: new rows added without disrupting existing",
  fixture: "lazy-rows.html",
  run: async (cdp) => {
    // Initial state
    const before = await cdp.extractEntities();
    const rowsBefore = before.filter((e) => e._entity === "TableRow");
    const initialCount = rowsBefore.length;
    assert(initialCount === 3, `expected 3 initial rows, got ${initialCount}`);

    // Click load more
    await cdp.click("#load-btn");
    await sleep(800); // wait for simulated delay

    const after = await cdp.extractEntities();
    const rowsAfter = after.filter((e) => e._entity === "TableRow");
    assert(
      rowsAfter.length > initialCount,
      `expected more rows after load, got ${rowsAfter.length}`,
    );

    // Original rows still present with same data
    for (let i = 0; i < initialCount; i++) {
      assertEqual(
        rowsBefore[i]!._cells,
        rowsAfter[i]!._cells,
        `original row ${i} data preserved`,
      );
    }
  },
};

// ── Pagination fixture ──

export const paginationPageChange: TestCase = {
  name: "Pagination: page change replaces rows entirely",
  fixture: "pagination.html",
  run: async (cdp) => {
    // Page 1
    const page1 = await cdp.extractEntities();
    const rows1 = page1.filter((e) => e._entity === "TableRow");
    assert(rows1.length === 5, `expected 5 rows on page 1, got ${rows1.length}`);

    // Go to page 2
    await cdp.click(".page-btn[data-page='2']");
    await sleep(300);

    const page2 = await cdp.extractEntities();
    const rows2 = page2.filter((e) => e._entity === "TableRow");
    assert(rows2.length === 5, `expected 5 rows on page 2, got ${rows2.length}`);

    // Different data on page 2
    const data1 = rows1.map((r) => r._cells?.[0]).sort();
    const data2 = rows2.map((r) => r._cells?.[0]).sort();
    assert(
      JSON.stringify(data1) !== JSON.stringify(data2),
      "page 2 should have different data than page 1",
    );
  },
};

// ── Validation error fixture ──

export const validationErrorDetection: TestCase = {
  name: "Validation: form errors detected after empty submit",
  fixture: "validation-error.html",
  run: async (cdp) => {
    // Submit empty form
    await cdp.click("button[type='submit']");
    await sleep(300);

    const entities = await cdp.extractEntities();
    const forms = entities.filter((e) => e._entity === "Form");
    assert(forms.length === 1, `expected 1 form, got ${forms.length}`);

    const form = forms[0]!;
    const errorFields = form.fields.filter((f: any) => f.hasError);
    assert(
      errorFields.length > 0,
      "should detect validation errors on empty submit",
    );
  },
};

export const validationSuccessClearsErrors: TestCase = {
  name: "Validation: valid submit clears errors and shows success state",
  fixture: "validation-error.html",
  run: async (cdp) => {
    await cdp.fill("#name", "Jane Doe");
    await cdp.fill("#email", "jane@example.com");
    await cdp.fill("#amount", "100.50");
    await cdp.click('button[type="submit"]');
    await sleep(300);

    const entities = await cdp.extractEntities();
    const forms = entities.filter((e) => e._entity === "Form");
    assert(forms.length === 1, `expected 1 form, got ${forms.length}`);

    const form = forms[0]!;
    const errorFields = form.fields.filter((f: any) => f.hasError);
    assert(errorFields.length === 0, "no fields should remain in error state");

    const bannerText = await cdp.text("#banner");
    assert(
      bannerText?.includes("Submitted successfully"),
      "success banner should be shown after valid submit",
    );
  },
};

// ── Relabel fixture ──

export const buttonRelabel: TestCase = {
  name: "Relabel: button text changes after click, entity still detectable",
  fixture: "relabel.html",
  run: async (cdp) => {
    // Before click
    const before = await cdp.extractEntities();
    const btnsBefore = before.filter(
      (e) => e._entity === "Button" && e.label?.includes("Download"),
    );
    assert(btnsBefore.length > 0, "should have Download buttons");

    // Click first download button
    const firstBtn = btnsBefore[0]!;
    await cdp.click(`.btn-download`);
    await sleep(1700); // wait for label transition

    // After click
    const after = await cdp.extractEntities();
    const btnsAfter = after.filter((e) => e._entity === "Button");

    // There should be a button with changed label
    const changed = btnsAfter.find(
      (b) =>
        b.label?.includes("Downloaded") || b.label?.includes("Downloading"),
    );
    assert(
      changed !== undefined,
      "should detect relabeled button after click",
    );
  },
};

export const relabelSortPreservesActionableButtons: TestCase = {
  name: "Relabel: sorting rerenders rows but preserves actionable download buttons",
  fixture: "relabel.html",
  run: async (cdp) => {
    await cdp.click('.btn-sort[data-sort="revenue"]');
    await sleep(300);

    const entities = await cdp.extractEntities();
    const buttons = entities.filter((e) => e._entity === "Button");
    const downloadButtons = buttons.filter((button) => button.label === "Download");
    const rows = entities.filter((e) => e._entity === "TableRow");
    const names = rows.map((row) => row._cells?.[0] ?? null);

    assert(rows.length === 4, `expected 4 rows after sort, got ${rows.length}`);
    assert(
      downloadButtons.length === 4,
      `expected 4 actionable download buttons after rerender, got ${downloadButtons.length}`,
    );
    assertEqual(
      names,
      [
        "Q2 North Region",
        "Q1 North Region",
        "Q2 South Region",
        "Q1 South Region",
      ],
      "row order after revenue sort",
    );
  },
};

// ── Disabled button fixture ──

export const disabledButtonLockAndRecovery: TestCase = {
  name: "Disabled action: lock disables target button, unlock re-enables and deploy works",
  fixture: "disabled-button.html",
  run: async (cdp) => {
    const targetSelector = 'button.deploy-btn[data-row-id="svc-payments"]';

    assert(!(await cdp.isDisabled(targetSelector)), "target deploy button should start enabled");

    await cdp.click("#lock-target");
    await sleep(100);
    assert(await cdp.isDisabled(targetSelector), "target deploy button should be disabled while locked");

    await sleep(750);
    assert(!(await cdp.isDisabled(targetSelector)), "target deploy button should re-enable after lock clears");

    await cdp.click(targetSelector);
    await sleep(650);

    const bannerText = await cdp.text("#banner");
    assert(
      bannerText?.includes("Payments Service deployed successfully."),
      "successful deploy banner should appear after lock clears",
    );
  },
};

// ── Auth timeout fixture ──

export const authTimeoutDetection: TestCase = {
  name: "Auth timeout: detect page replacement after session expiry",
  fixture: "auth-timeout.html",
  run: async (cdp) => {
    // Initially should have table
    const before = await cdp.extractEntities();
    const tablesBefore = before.filter((e) => e._entity === "Table");
    assert(tablesBefore.length === 1, "should have table initially");

    // Force the timeout via JS (don't wait 10s)
    await cdp.evalJS(`if (window.expireSession) window.expireSession()`);
    await sleep(500);

    // After timeout: table gone, form appears
    const after = await cdp.extractEntities();
    const tablesAfter = after.filter((e) => e._entity === "Table");
    const formsAfter = after.filter((e) => e._entity === "Form");

    assert(tablesAfter.length === 0, "table should be gone after auth timeout");
    assert(formsAfter.length === 1, "login form should appear after timeout");
  },
};

export const authTimeoutRecovery: TestCase = {
  name: "Auth timeout: login form can restore the original table view",
  fixture: "auth-timeout.html",
  run: async (cdp) => {
    await cdp.evalJS(`if (window.expireSession) window.expireSession()`);
    await sleep(300);

    await cdp.fill("#login-email", "user@example.com");
    await cdp.fill("#login-password", "secret");
    await cdp.click('button[type="submit"]');
    await sleep(1200);

    const entities = await cdp.extractEntities();
    const tables = entities.filter((e) => e._entity === "Table");
    const forms = entities.filter((e) => e._entity === "Form");

    assert(tables.length === 1, "table should return after simulated re-login");
    assert(forms.length === 0, "login form should be gone after reload");
  },
};

export const searchResultExtraction: TestCase = {
  name: "Generic web: extract content links as search results without nav noise",
  fixture: "search-results.html",
  run: async (cdp) => {
    const entities = await cdp.extractEntities();
    const links = entities.filter((e) => e._entity === "Link");
    const results = entities.filter((e) => e._entity === "SearchResult");

    assert(links.length >= 10, `expected many links, got ${links.length}`);
    assert(results.length === 3, `expected 3 content search results, got ${results.length}`);

    const titles = results.map((r) => r.title);
    assert(
      titles.includes("Reactive browser runtime architecture for resilient agents"),
      "missing first result title",
    );
    assert(
      titles.includes("Semantic actions for web agents without brittle selectors"),
      "missing second result title",
    );
    assert(
      !titles.includes("About") && !titles.includes("Pricing") && !titles.includes("Privacy"),
      "nav/footer links should not become SearchResult entities",
    );

    const refs = results.map((r) => r._ref);
    assert(refs.every((value) => String(value).startsWith("@e:")), "search results should expose interactive refs");
  },
};

export const searchResultIgnoresPagerLinks: TestCase = {
  name: "Generic web: pagination and support links stay as links, not search results",
  fixture: "search-results.html",
  run: async (cdp) => {
    const entities = await cdp.extractEntities();
    const results = entities.filter((e) => e._entity === "SearchResult");
    const links = entities.filter((e) => e._entity === "Link");

    const resultTitles = new Set(results.map((result) => result.title));
    assert(!resultTitles.has("Next"), "pager link should not become a SearchResult");
    assert(!resultTitles.has("1"), "numeric pager links should not become SearchResult entities");
    assert(!resultTitles.has("Email support"), "support links should not become SearchResult entities");

    const nextLink = links.find((link) => link.text === "Next");
    assert(nextLink !== undefined, "pager next link should still be extracted as a Link");
    assertEqual(nextLink.href, "?page=next", "pager next href");
  },
};

export const listExtraction: TestCase = {
  name: "Generic web: extract lists and list items with primary links",
  fixture: "docs-home.html",
  run: async (cdp) => {
    const entities = await cdp.extractEntities();
    const lists = entities.filter((e) => e._entity === "List");
    const items = entities.filter((e) => e._entity === "ListItem");

    assert(lists.length >= 1, "expected at least one list");
    assert(items.length >= 4, `expected at least 4 list items, got ${items.length}`);

    const sidebarItem = items.find((item) => item.primary_text === "Getting started");
    assert(sidebarItem !== undefined, "sidebar link list item should be extracted");
    assertEqual(sidebarItem.primary_href, "/docs/getting-started", "sidebar primary href");

    const featured = entities.filter((e) => e._entity === "SearchResult");
    assert(featured.length === 3, `expected 3 featured guide search results, got ${featured.length}`);
  },
};

export const paginationControlsUpdateState: TestCase = {
  name: "Pagination: prev/next controls update disabled and active states across pages",
  fixture: "pagination.html",
  run: async (cdp) => {
    assert(await cdp.isDisabled("#prev-btn"), "previous should be disabled on page 1");
    assert(!(await cdp.isDisabled("#next-btn")), "next should be enabled on page 1");

    await cdp.click("#next-btn");
    await sleep(250);
    assertEqual(await cdp.text(".page-info"), "Page 2 of 3", "page info after next");
    assert(!(await cdp.isDisabled("#prev-btn")), "previous should be enabled on page 2");

    await cdp.click("#next-btn");
    await sleep(250);
    assertEqual(await cdp.text(".page-info"), "Page 3 of 3", "page info on last page");
    assert(await cdp.isDisabled("#next-btn"), "next should be disabled on last page");
  },
};

// ── Export all tests ──

export const ALL_TESTS: TestCase[] = [
  // Base invoice fixture
  invoiceExtraction,
  invoiceSort,
  invoiceQueryFilter,
  invoiceEntityIdentity,
  // Adversarial fixtures
  rerenderReconciliation,
  modalDetection,
  lazyLoadNewEntities,
  paginationPageChange,
  paginationControlsUpdateState,
  validationErrorDetection,
  validationSuccessClearsErrors,
  buttonRelabel,
  relabelSortPreservesActionableButtons,
  disabledButtonLockAndRecovery,
  authTimeoutDetection,
  authTimeoutRecovery,
  // Generic open-web coverage
  searchResultExtraction,
  searchResultIgnoresPagerLinks,
  listExtraction,
];
