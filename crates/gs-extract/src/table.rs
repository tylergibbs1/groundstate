use gs_types::*;
use serde_json::json;

use crate::Extractor;

/// Extracts `Table` and `TableRow` entities from `<table>` elements in the DOM.
pub struct TableExtractor;

impl Extractor for TableExtractor {
    fn extract(&self, observation: &RawObservation) -> Vec<SemanticEntity> {
        let mut entities = Vec::new();
        let tables = observation
            .dom
            .root
            .find_all(&|n| n.node_name.eq_ignore_ascii_case("TABLE"));

        for (table_idx, table_node) in tables.iter().enumerate() {
            let table_id_attr = table_node.get_attribute("id").unwrap_or("");
            let fingerprint = if table_id_attr.is_empty() {
                format!("table-{table_idx}")
            } else {
                table_id_attr.to_string()
            };

            let headers = extract_headers(table_node);
            let rows = extract_rows(table_node, &headers);
            let sorted_by = detect_sort_state(table_node, &headers);

            let mut props = serde_json::Map::new();
            props.insert("headers".into(), json!(headers));
            props.insert("row_count".into(), json!(rows.len()));
            props.insert("column_count".into(), json!(headers.len()));
            if let Some(ref col) = sorted_by {
                props.insert("sorted_by".into(), json!(col));
            }

            let table_entity = SemanticEntity::new(
                EntityId(0),
                StableKey::new(EntityKind::Table, &fingerprint),
                EntityKind::Table,
                serde_json::Value::Object(props),
                SourceRef {
                    selector: table_node.selector_path(),
                    backend_node_id: Some(table_node.backend_node_id),
                    a11y_id: None,
                },
                0.9,
            );
            entities.push(table_entity);

            for (row_idx, row_data) in rows.iter().enumerate() {
                let row_fingerprint = format!("{fingerprint}-row-{row_idx}");
                let row_entity = SemanticEntity::new(
                    EntityId(0),
                    StableKey::new(EntityKind::TableRow, &row_fingerprint),
                    EntityKind::TableRow,
                    row_data.clone(),
                    SourceRef {
                        selector: format!(
                            "{} tr:nth-child({})",
                            table_node.selector_path(),
                            row_idx + 1
                        ),
                        backend_node_id: None,
                        a11y_id: None,
                    },
                    0.85,
                );
                entities.push(row_entity);
            }
        }

        entities
    }
}

/// Detect which column the table is currently sorted by.
/// Looks for common CSS class conventions: `sorted-asc`, `sorted-desc`,
/// `sort-asc`, `sort-desc`, `ascending`, `descending` on `<th>` elements.
fn detect_sort_state(table_node: &DomNode, headers: &[String]) -> Option<String> {
    let th_nodes = table_node.find_all(&|n| n.node_name.eq_ignore_ascii_case("TH"));

    for (i, th) in th_nodes.iter().enumerate() {
        let class = th.get_attribute("class").unwrap_or("");
        let is_sorted = class.contains("sorted-asc")
            || class.contains("sorted-desc")
            || class.contains("sort-asc")
            || class.contains("sort-desc")
            || class.contains("ascending")
            || class.contains("descending")
            || class.contains("active-sort");

        if is_sorted {
            return headers.get(i).cloned();
        }
    }

    None
}

/// Extract header labels from `<th>` / `<td>` cells in the table's `<thead>`.
///
/// Handles multi-row headers with `rowspan` and `colspan`.  For a header like:
///
/// ```text
///   Year(rowspan=2) | Sales(colspan=2)
///                   | US              | EU
/// ```
///
/// this produces `["Year", "US", "EU"]` — the bottom-most text wins for each
/// column, with rowspan-carried labels filling columns that have no cell in
/// lower rows.
fn extract_headers(table_node: &DomNode) -> Vec<String> {
    let thead_nodes = table_node.find_children(&|n| n.node_name.eq_ignore_ascii_case("THEAD"));

    let header_rows: Vec<&DomNode> = if let Some(thead) = thead_nodes.first() {
        thead
            .find_children(&|n| n.node_name.eq_ignore_ascii_case("TR"))
    } else {
        // Fall back: take the first <tr> that contains <th>.
        let direct_rows = table_node.find_children(&|n| n.node_name.eq_ignore_ascii_case("TR"));
        direct_rows
            .into_iter()
            .filter(|tr| {
                !tr.find_children(&|n| n.node_name.eq_ignore_ascii_case("TH"))
                    .is_empty()
            })
            .take(1)
            .collect()
    };

    if header_rows.is_empty() {
        return Vec::new();
    }

    // Single header row — fast path (most tables).
    if header_rows.len() == 1 {
        let cells = header_rows[0].find_children(&|n| {
            n.node_name.eq_ignore_ascii_case("TH") || n.node_name.eq_ignore_ascii_case("TD")
        });
        let mut headers = Vec::new();
        for th in &cells {
            let text = th.text_content().trim().to_string();
            let colspan = parse_span(th.get_attribute("colspan"));
            headers.push(text.clone());
            for _ in 1..colspan {
                headers.push(text.clone());
            }
        }
        return headers;
    }

    // ── Multi-row header: resolve with the same rowspan/colspan grid as body rows ──

    // First pass: determine column count from the first header row's span total.
    let num_cols: usize = header_rows[0]
        .find_children(&|n| {
            n.node_name.eq_ignore_ascii_case("TH") || n.node_name.eq_ignore_ascii_case("TD")
        })
        .iter()
        .map(|c| parse_span(c.get_attribute("colspan")))
        .sum();

    if num_cols == 0 {
        return Vec::new();
    }

    let num_rows = header_rows.len();
    let mut grid: Vec<Vec<String>> = vec![vec![String::new(); num_cols]; num_rows];
    let mut remaining: Vec<usize> = vec![0; num_cols];
    let mut span_val: Vec<String> = vec![String::new(); num_cols];

    for (row_idx, tr) in header_rows.iter().enumerate() {
        let cells: Vec<&DomNode> = tr
            .find_children(&|n| {
                n.node_name.eq_ignore_ascii_case("TH") || n.node_name.eq_ignore_ascii_case("TD")
            })
            .into_iter()
            .collect();

        let mut cell_iter = cells.iter();
        let mut col = 0;

        while col < num_cols {
            if remaining[col] > 0 {
                grid[row_idx][col] = span_val[col].clone();
                remaining[col] -= 1;
                col += 1;
                continue;
            }

            if let Some(cell) = cell_iter.next() {
                let text = cell.text_content().trim().to_string();
                let colspan = parse_span(cell.get_attribute("colspan"));
                let rowspan = parse_span(cell.get_attribute("rowspan"));

                for c in 0..colspan {
                    let target = col + c;
                    if target >= num_cols {
                        break;
                    }
                    grid[row_idx][target] = text.clone();
                    if rowspan > 1 {
                        remaining[target] = rowspan - 1;
                        span_val[target] = text.clone();
                    }
                }
                col += colspan;
            } else {
                break;
            }
        }
    }

    // For each column, take the bottom-most non-empty label.
    (0..num_cols)
        .map(|col| {
            for row in (0..num_rows).rev() {
                let val = &grid[row][col];
                if !val.is_empty() {
                    return val.clone();
                }
            }
            String::new()
        })
        .collect()
}

/// Build a column-resolved grid from the table body, then emit one JSON
/// object per logical row (i.e. per row that starts a new entity).
///
/// The grid tracks `rowspan` carry-overs: when a `<td rowspan="N">` appears
/// in column C, the next N-1 rows inherit that cell's value at column C.
/// Similarly, `colspan` on a `<td>` fills multiple columns in one row.
fn extract_rows(table_node: &DomNode, headers: &[String]) -> Vec<serde_json::Value> {
    let tbody_nodes = table_node.find_children(&|n| n.node_name.eq_ignore_ascii_case("TBODY"));
    let rows = if let Some(tbody) = tbody_nodes.first() {
        tbody.find_children(&|n| n.node_name.eq_ignore_ascii_case("TR"))
    } else {
        table_node.find_children(&|n| n.node_name.eq_ignore_ascii_case("TR"))
    };

    // Filter to data rows (those with at least one <td>).
    let data_rows: Vec<&DomNode> = rows
        .into_iter()
        .filter(|tr| {
            !tr.find_children(&|n| n.node_name.eq_ignore_ascii_case("TD"))
                .is_empty()
        })
        .collect();

    if data_rows.is_empty() {
        return Vec::new();
    }

    // Determine column count from headers, or from the first row's cell span total.
    let num_cols = if !headers.is_empty() {
        headers.len()
    } else {
        data_rows
            .first()
            .map(|tr| {
                tr.find_children(&|n| n.node_name.eq_ignore_ascii_case("TD"))
                    .iter()
                    .map(|td| parse_span(td.get_attribute("colspan")))
                    .sum()
            })
            .unwrap_or(0)
    };

    if num_cols == 0 {
        return Vec::new();
    }

    // ── Build the resolved grid ──
    //
    // `grid[row][col]` = cell text after resolving rowspan/colspan.
    // `remaining[col]`  = how many more rows the current rowspan occupies.

    let num_rows = data_rows.len();
    let mut grid: Vec<Vec<String>> = vec![vec![String::new(); num_cols]; num_rows];
    let mut remaining: Vec<usize> = vec![0; num_cols]; // remaining rowspan per column
    let mut span_val: Vec<String> = vec![String::new(); num_cols]; // value carried by rowspan

    for (row_idx, tr) in data_rows.iter().enumerate() {
        let cells: Vec<&DomNode> = tr
            .find_children(&|n| n.node_name.eq_ignore_ascii_case("TD"))
            .into_iter()
            .collect();

        let mut cell_iter = cells.iter();
        let mut col = 0;

        while col < num_cols {
            // If a previous rowspan is still active, carry the value forward.
            if remaining[col] > 0 {
                grid[row_idx][col] = span_val[col].clone();
                remaining[col] -= 1;
                col += 1;
                continue;
            }

            // Consume the next physical <td>.
            if let Some(td) = cell_iter.next() {
                let text = td.text_content().trim().to_string();
                let colspan = parse_span(td.get_attribute("colspan"));
                let rowspan = parse_span(td.get_attribute("rowspan"));

                for c in 0..colspan {
                    let target_col = col + c;
                    if target_col >= num_cols {
                        break;
                    }
                    grid[row_idx][target_col] = text.clone();

                    if rowspan > 1 {
                        remaining[target_col] = rowspan - 1;
                        span_val[target_col] = text.clone();
                    }
                }

                col += colspan;
            } else {
                // No more cells in this row — leave remaining columns empty.
                break;
            }
        }
    }

    // ── Emit one JSON object per resolved row ──

    grid.into_iter()
        .map(|row_cells| {
            let mut row = serde_json::Map::new();
            for (i, cell) in row_cells.iter().enumerate() {
                let key = headers
                    .get(i)
                    .cloned()
                    .unwrap_or_else(|| format!("col_{i}"));
                row.insert(key, serde_json::Value::String(cell.clone()));
            }
            row.insert(
                "_cells".to_string(),
                serde_json::Value::Array(
                    row_cells
                        .into_iter()
                        .map(serde_json::Value::String)
                        .collect(),
                ),
            );
            serde_json::Value::Object(row)
        })
        .collect()
}

/// Parse a `rowspan` or `colspan` attribute value, defaulting to 1.
fn parse_span(attr: Option<&str>) -> usize {
    attr.and_then(|v| v.parse::<usize>().ok())
        .unwrap_or(1)
        .max(1)
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::Utc;

    fn make_dom(html_structure: DomNode) -> RawObservation {
        RawObservation {
            dom: DomSnapshot {
                root: html_structure,
            },
            a11y: None,
            url: "https://test.com".into(),
            title: "Test".into(),
            timestamp: Utc::now(),
        }
    }

    fn text_node(text: &str) -> DomNode {
        DomNode {
            node_id: 0,
            backend_node_id: 0,
            node_type: 3, // TEXT_NODE
            node_name: "#text".into(),
            node_value: text.into(),
            attributes: vec![],
            children: vec![],
        }
    }

    fn element(tag: &str, attrs: Vec<String>, children: Vec<DomNode>) -> DomNode {
        DomNode {
            node_id: 0,
            backend_node_id: 100,
            node_type: 1, // ELEMENT_NODE
            node_name: tag.to_uppercase(),
            node_value: String::new(),
            attributes: attrs,
            children,
        }
    }

    #[test]
    fn extracts_table_with_headers_and_rows() {
        let table = element(
            "table",
            vec!["id".into(), "invoices".into()],
            vec![
                element(
                    "thead",
                    vec![],
                    vec![element(
                        "tr",
                        vec![],
                        vec![
                            element("th", vec![], vec![text_node("Vendor")]),
                            element("th", vec![], vec![text_node("Amount")]),
                            element("th", vec![], vec![text_node("Status")]),
                        ],
                    )],
                ),
                element(
                    "tbody",
                    vec![],
                    vec![
                        element(
                            "tr",
                            vec![],
                            vec![
                                element("td", vec![], vec![text_node("Acme Corp")]),
                                element("td", vec![], vec![text_node("15000")]),
                                element("td", vec![], vec![text_node("Unpaid")]),
                            ],
                        ),
                        element(
                            "tr",
                            vec![],
                            vec![
                                element("td", vec![], vec![text_node("Globex")]),
                                element("td", vec![], vec![text_node("8000")]),
                                element("td", vec![], vec![text_node("Paid")]),
                            ],
                        ),
                    ],
                ),
            ],
        );

        let obs = make_dom(element(
            "html",
            vec![],
            vec![element("body", vec![], vec![table])],
        ));

        let extractor = TableExtractor;
        let entities = extractor.extract(&obs);

        // 1 table + 2 rows
        assert_eq!(entities.len(), 3);

        // Table entity
        assert_eq!(entities[0].kind, EntityKind::Table);
        assert_eq!(
            entities[0].properties["headers"],
            json!(["Vendor", "Amount", "Status"])
        );
        assert_eq!(entities[0].properties["row_count"], 2);

        // Row entities
        assert_eq!(entities[1].kind, EntityKind::TableRow);
        assert_eq!(entities[1].properties["Vendor"], "Acme Corp");
        assert_eq!(entities[1].properties["Amount"], "15000");
        assert_eq!(entities[1].properties["Status"], "Unpaid");

        assert_eq!(entities[2].kind, EntityKind::TableRow);
        assert_eq!(entities[2].properties["Vendor"], "Globex");
    }

    #[test]
    fn handles_table_without_thead() {
        let table = element(
            "table",
            vec![],
            vec![
                element(
                    "tr",
                    vec![],
                    vec![
                        element("th", vec![], vec![text_node("Name")]),
                        element("th", vec![], vec![text_node("Value")]),
                    ],
                ),
                element(
                    "tr",
                    vec![],
                    vec![
                        element("td", vec![], vec![text_node("Alpha")]),
                        element("td", vec![], vec![text_node("100")]),
                    ],
                ),
            ],
        );

        let obs = make_dom(element("html", vec![], vec![table]));
        let entities = TableExtractor.extract(&obs);

        // 1 table + 1 data row (header row filtered out)
        assert_eq!(entities.len(), 2);
        assert_eq!(entities[1].properties["Name"], "Alpha");
    }

    #[test]
    fn handles_rowspan_colspan() {
        // Simulates a Wikipedia-style table:
        //
        //   | Browser | Engine | Platform | Version |
        //   | Chrome  | Blink  | Android  | 146     |  (rowspan=3 on "Chrome" and "Blink")
        //   |         |        | Linux    | 146     |
        //   |         |        | Windows  | 146     |
        //   | Firefox | Gecko  | Android  | 149     |

        let table = element(
            "table",
            vec![],
            vec![
                element(
                    "thead",
                    vec![],
                    vec![element(
                        "tr",
                        vec![],
                        vec![
                            element("th", vec![], vec![text_node("Browser")]),
                            element("th", vec![], vec![text_node("Engine")]),
                            element("th", vec![], vec![text_node("Platform")]),
                            element("th", vec![], vec![text_node("Version")]),
                        ],
                    )],
                ),
                element(
                    "tbody",
                    vec![],
                    vec![
                        element(
                            "tr",
                            vec![],
                            vec![
                                element(
                                    "td",
                                    vec!["rowspan".into(), "3".into()],
                                    vec![text_node("Chrome")],
                                ),
                                element(
                                    "td",
                                    vec!["rowspan".into(), "3".into()],
                                    vec![text_node("Blink")],
                                ),
                                element("td", vec![], vec![text_node("Android")]),
                                element("td", vec![], vec![text_node("146")]),
                            ],
                        ),
                        element(
                            "tr",
                            vec![],
                            vec![
                                // Browser and Engine columns are spanned from above
                                element("td", vec![], vec![text_node("Linux")]),
                                element("td", vec![], vec![text_node("146")]),
                            ],
                        ),
                        element(
                            "tr",
                            vec![],
                            vec![
                                element("td", vec![], vec![text_node("Windows")]),
                                element("td", vec![], vec![text_node("146")]),
                            ],
                        ),
                        element(
                            "tr",
                            vec![],
                            vec![
                                element("td", vec![], vec![text_node("Firefox")]),
                                element("td", vec![], vec![text_node("Gecko")]),
                                element("td", vec![], vec![text_node("Android")]),
                                element("td", vec![], vec![text_node("149")]),
                            ],
                        ),
                    ],
                ),
            ],
        );

        let obs = make_dom(element("html", vec![], vec![table]));
        let entities = TableExtractor.extract(&obs);

        // 1 table + 4 rows
        assert_eq!(entities.len(), 5);

        // Row 1: Chrome/Blink/Android/146
        assert_eq!(entities[1].properties["Browser"], "Chrome");
        assert_eq!(entities[1].properties["Engine"], "Blink");
        assert_eq!(entities[1].properties["Platform"], "Android");

        // Row 2: Chrome (carried by rowspan)/Blink (carried)/Linux/146
        assert_eq!(entities[2].properties["Browser"], "Chrome");
        assert_eq!(entities[2].properties["Engine"], "Blink");
        assert_eq!(entities[2].properties["Platform"], "Linux");

        // Row 3: Chrome/Blink/Windows/146
        assert_eq!(entities[3].properties["Browser"], "Chrome");
        assert_eq!(entities[3].properties["Engine"], "Blink");
        assert_eq!(entities[3].properties["Platform"], "Windows");

        // Row 4: Firefox (new row, no span)
        assert_eq!(entities[4].properties["Browser"], "Firefox");
        assert_eq!(entities[4].properties["Engine"], "Gecko");
        assert_eq!(entities[4].properties["Platform"], "Android");
        assert_eq!(entities[4].properties["Version"], "149");
    }

    #[test]
    fn handles_multi_row_header_with_rowspan() {
        // Multi-row header:
        //   Year(rowspan=2) | Sales(colspan=2)
        //                   | US              | EU
        let table = element(
            "table",
            vec![],
            vec![
                element(
                    "thead",
                    vec![],
                    vec![
                        element(
                            "tr",
                            vec![],
                            vec![
                                element(
                                    "th",
                                    vec!["rowspan".into(), "2".into()],
                                    vec![text_node("Year")],
                                ),
                                element(
                                    "th",
                                    vec!["colspan".into(), "2".into()],
                                    vec![text_node("Sales")],
                                ),
                            ],
                        ),
                        element(
                            "tr",
                            vec![],
                            vec![
                                // Year column is spanned from above
                                element("th", vec![], vec![text_node("US")]),
                                element("th", vec![], vec![text_node("EU")]),
                            ],
                        ),
                    ],
                ),
                element(
                    "tbody",
                    vec![],
                    vec![element(
                        "tr",
                        vec![],
                        vec![
                            element("td", vec![], vec![text_node("2024")]),
                            element("td", vec![], vec![text_node("100")]),
                            element("td", vec![], vec![text_node("200")]),
                        ],
                    )],
                ),
            ],
        );

        let obs = make_dom(element("html", vec![], vec![table]));
        let entities = TableExtractor.extract(&obs);

        // 1 table + 1 row
        assert_eq!(entities.len(), 2);

        // Table should have 3 resolved headers
        assert_eq!(
            entities[0].properties["headers"],
            json!(["Year", "US", "EU"])
        );
        assert_eq!(entities[0].properties["column_count"], 3);

        // Row maps correctly
        assert_eq!(entities[1].properties["Year"], "2024");
        assert_eq!(entities[1].properties["US"], "100");
        assert_eq!(entities[1].properties["EU"], "200");
    }

    #[test]
    fn handles_colspan() {
        // A cell with colspan="2" should fill two columns.
        let table = element(
            "table",
            vec![],
            vec![
                element(
                    "thead",
                    vec![],
                    vec![element(
                        "tr",
                        vec![],
                        vec![
                            element("th", vec![], vec![text_node("A")]),
                            element("th", vec![], vec![text_node("B")]),
                            element("th", vec![], vec![text_node("C")]),
                        ],
                    )],
                ),
                element(
                    "tbody",
                    vec![],
                    vec![element(
                        "tr",
                        vec![],
                        vec![
                            element(
                                "td",
                                vec!["colspan".into(), "2".into()],
                                vec![text_node("wide")],
                            ),
                            element("td", vec![], vec![text_node("narrow")]),
                        ],
                    )],
                ),
            ],
        );

        let obs = make_dom(element("html", vec![], vec![table]));
        let entities = TableExtractor.extract(&obs);

        assert_eq!(entities.len(), 2); // 1 table + 1 row
        assert_eq!(entities[1].properties["A"], "wide");
        assert_eq!(entities[1].properties["B"], "wide");
        assert_eq!(entities[1].properties["C"], "narrow");
    }

    #[test]
    fn no_tables_produces_empty() {
        let obs = make_dom(element(
            "html",
            vec![],
            vec![element(
                "body",
                vec![],
                vec![element("div", vec![], vec![text_node("Hello")])],
            )],
        ));

        let entities = TableExtractor.extract(&obs);
        assert!(entities.is_empty());
    }
}
