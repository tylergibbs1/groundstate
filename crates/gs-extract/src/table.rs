use gs_types::*;
use serde_json::json;

use crate::Extractor;

/// Extracts `Table` and `TableRow` entities from `<table>` elements in the DOM.
pub struct TableExtractor;

impl Extractor for TableExtractor {
    fn extract(&self, observation: &RawObservation) -> Vec<SemanticEntity> {
        let mut entities = Vec::new();
        let tables = observation.dom.root.find_all(&|n| {
            n.node_name.eq_ignore_ascii_case("TABLE")
        });

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
                        selector: format!("{} tr:nth-child({})", table_node.selector_path(), row_idx + 1),
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

/// Extract header labels from `<th>` elements in `<thead>` or the first `<tr>`.
fn extract_headers(table_node: &DomNode) -> Vec<String> {
    // Look for <thead> first
    let thead_nodes = table_node.find_all(&|n| n.node_name.eq_ignore_ascii_case("THEAD"));

    let header_cells = if let Some(thead) = thead_nodes.first() {
        thead.find_all(&|n| n.node_name.eq_ignore_ascii_case("TH"))
    } else {
        // Fall back to <th> anywhere in the table
        table_node.find_all(&|n| n.node_name.eq_ignore_ascii_case("TH"))
    };

    header_cells
        .iter()
        .map(|th| th.text_content().trim().to_string())
        .collect()
}

/// Extract row data from `<tbody>` `<tr>` elements (or all `<tr>` elements if no `<tbody>`).
fn extract_rows(table_node: &DomNode, headers: &[String]) -> Vec<serde_json::Value> {
    let tbody_nodes = table_node.find_all(&|n| n.node_name.eq_ignore_ascii_case("TBODY"));
    let rows = if let Some(tbody) = tbody_nodes.first() {
        tbody.find_all(&|n| n.node_name.eq_ignore_ascii_case("TR"))
    } else {
        table_node.find_all(&|n| n.node_name.eq_ignore_ascii_case("TR"))
    };

    rows.iter()
        .filter(|tr| {
            // Skip rows that only contain <th> (header rows)
            let has_td = tr.find_all(&|n| n.node_name.eq_ignore_ascii_case("TD"));
            !has_td.is_empty()
        })
        .map(|tr| {
            let cells: Vec<String> = tr
                .find_all(&|n| n.node_name.eq_ignore_ascii_case("TD"))
                .iter()
                .map(|td| td.text_content().trim().to_string())
                .collect();

            // Build a JSON object mapping header names to cell values
            let mut row = serde_json::Map::new();
            for (i, cell) in cells.iter().enumerate() {
                let key = headers.get(i).cloned().unwrap_or_else(|| format!("col_{i}"));
                row.insert(key, serde_json::Value::String(cell.clone()));
            }
            // Also include a _cells array for positional access
            row.insert(
                "_cells".to_string(),
                serde_json::Value::Array(cells.into_iter().map(serde_json::Value::String).collect()),
            );

            serde_json::Value::Object(row)
        })
        .collect()
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
        let table = element("table", vec!["id".into(), "invoices".into()], vec![
            element("thead", vec![], vec![
                element("tr", vec![], vec![
                    element("th", vec![], vec![text_node("Vendor")]),
                    element("th", vec![], vec![text_node("Amount")]),
                    element("th", vec![], vec![text_node("Status")]),
                ]),
            ]),
            element("tbody", vec![], vec![
                element("tr", vec![], vec![
                    element("td", vec![], vec![text_node("Acme Corp")]),
                    element("td", vec![], vec![text_node("15000")]),
                    element("td", vec![], vec![text_node("Unpaid")]),
                ]),
                element("tr", vec![], vec![
                    element("td", vec![], vec![text_node("Globex")]),
                    element("td", vec![], vec![text_node("8000")]),
                    element("td", vec![], vec![text_node("Paid")]),
                ]),
            ]),
        ]);

        let obs = make_dom(element("html", vec![], vec![
            element("body", vec![], vec![table]),
        ]));

        let extractor = TableExtractor;
        let entities = extractor.extract(&obs);

        // 1 table + 2 rows
        assert_eq!(entities.len(), 3);

        // Table entity
        assert_eq!(entities[0].kind, EntityKind::Table);
        assert_eq!(entities[0].properties["headers"], json!(["Vendor", "Amount", "Status"]));
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
        let table = element("table", vec![], vec![
            element("tr", vec![], vec![
                element("th", vec![], vec![text_node("Name")]),
                element("th", vec![], vec![text_node("Value")]),
            ]),
            element("tr", vec![], vec![
                element("td", vec![], vec![text_node("Alpha")]),
                element("td", vec![], vec![text_node("100")]),
            ]),
        ]);

        let obs = make_dom(element("html", vec![], vec![table]));
        let entities = TableExtractor.extract(&obs);

        // 1 table + 1 data row (header row filtered out)
        assert_eq!(entities.len(), 2);
        assert_eq!(entities[1].properties["Name"], "Alpha");
    }

    #[test]
    fn no_tables_produces_empty() {
        let obs = make_dom(element("html", vec![], vec![
            element("body", vec![], vec![
                element("div", vec![], vec![text_node("Hello")]),
            ]),
        ]));

        let entities = TableExtractor.extract(&obs);
        assert!(entities.is_empty());
    }
}
