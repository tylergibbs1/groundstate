#[cfg(test)]
mod tests {
    use chrono::Utc;
    use gs_types::*;
    use serde_json::json;

    use crate::Extractor;
    use crate::table::TableExtractor;

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
            node_type: 3,
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
            node_type: 1,
            node_name: tag.to_uppercase(),
            node_value: String::new(),
            attributes: attrs,
            children,
        }
    }

    #[test]
    fn empty_table_headers_only_no_rows() {
        let table = element(
            "table",
            vec!["id".into(), "empty-table".into()],
            vec![element(
                "thead",
                vec![],
                vec![element(
                    "tr",
                    vec![],
                    vec![
                        element("th", vec![], vec![text_node("A")]),
                        element("th", vec![], vec![text_node("B")]),
                    ],
                )],
            )],
        );

        let obs = make_dom(element("html", vec![], vec![table]));
        let entities = TableExtractor.extract(&obs);

        // Only the table entity, no rows
        assert_eq!(entities.len(), 1);
        assert_eq!(entities[0].kind, EntityKind::Table);
        assert_eq!(entities[0].properties["row_count"], 0);
        assert_eq!(entities[0].properties["headers"], json!(["A", "B"]));
    }

    #[test]
    fn table_with_no_headers_uses_col_indices() {
        let table = element(
            "table",
            vec![],
            vec![element(
                "tbody",
                vec![],
                vec![element(
                    "tr",
                    vec![],
                    vec![
                        element("td", vec![], vec![text_node("val1")]),
                        element("td", vec![], vec![text_node("val2")]),
                    ],
                )],
            )],
        );

        let obs = make_dom(element("html", vec![], vec![table]));
        let entities = TableExtractor.extract(&obs);

        // 1 table + 1 row
        assert_eq!(entities.len(), 2);
        assert_eq!(entities[0].properties["headers"], json!([]));
        // Row should use col_0, col_1 since no headers
        assert_eq!(entities[1].properties["col_0"], "val1");
        assert_eq!(entities[1].properties["col_1"], "val2");
    }

    #[test]
    fn multiple_tables_each_gets_unique_fingerprint() {
        let table1 = element(
            "table",
            vec!["id".into(), "alpha".into()],
            vec![element(
                "tbody",
                vec![],
                vec![element(
                    "tr",
                    vec![],
                    vec![element("td", vec![], vec![text_node("x")])],
                )],
            )],
        );
        let table2 = element(
            "table",
            vec!["id".into(), "beta".into()],
            vec![element(
                "tbody",
                vec![],
                vec![element(
                    "tr",
                    vec![],
                    vec![element("td", vec![], vec![text_node("y")])],
                )],
            )],
        );

        let obs = make_dom(element("html", vec![], vec![table1, table2]));
        let entities = TableExtractor.extract(&obs);

        let table_entities: Vec<_> = entities
            .iter()
            .filter(|e| e.kind == EntityKind::Table)
            .collect();
        assert_eq!(table_entities.len(), 2);
        assert_ne!(
            table_entities[0].stable_key.fingerprint, table_entities[1].stable_key.fingerprint,
            "each table must have a unique fingerprint"
        );
        assert_eq!(table_entities[0].stable_key.fingerprint, "alpha");
        assert_eq!(table_entities[1].stable_key.fingerprint, "beta");
    }

    #[test]
    fn table_with_nested_elements_in_cells() {
        // <td><span><strong>deep text</strong></span></td>
        let table = element(
            "table",
            vec!["id".into(), "nested".into()],
            vec![
                element(
                    "thead",
                    vec![],
                    vec![element(
                        "tr",
                        vec![],
                        vec![element("th", vec![], vec![text_node("Col")])],
                    )],
                ),
                element(
                    "tbody",
                    vec![],
                    vec![element(
                        "tr",
                        vec![],
                        vec![element(
                            "td",
                            vec![],
                            vec![element(
                                "span",
                                vec![],
                                vec![element("strong", vec![], vec![text_node("deep text")])],
                            )],
                        )],
                    )],
                ),
            ],
        );

        let obs = make_dom(element("html", vec![], vec![table]));
        let entities = TableExtractor.extract(&obs);

        let rows: Vec<_> = entities
            .iter()
            .filter(|e| e.kind == EntityKind::TableRow)
            .collect();
        assert_eq!(rows.len(), 1);
        assert_eq!(
            rows[0].properties["Col"], "deep text",
            "nested text must be extracted from cells"
        );
    }

    #[test]
    fn sort_state_detection_sorted_asc_class() {
        let table = element(
            "table",
            vec!["id".into(), "sorted-table".into()],
            vec![
                element(
                    "thead",
                    vec![],
                    vec![element(
                        "tr",
                        vec![],
                        vec![
                            element("th", vec![], vec![text_node("Name")]),
                            element(
                                "th",
                                vec!["class".into(), "sorted-asc".into()],
                                vec![text_node("Amount")],
                            ),
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
                            element("td", vec![], vec![text_node("a")]),
                            element("td", vec![], vec![text_node("100")]),
                        ],
                    )],
                ),
            ],
        );

        let obs = make_dom(element("html", vec![], vec![table]));
        let entities = TableExtractor.extract(&obs);

        let table_entity = entities
            .iter()
            .find(|e| e.kind == EntityKind::Table)
            .unwrap();
        assert_eq!(
            table_entity.properties["sorted_by"], "Amount",
            "sorted-asc class on th should populate sorted_by"
        );
    }

    #[test]
    fn sort_state_detection_no_sorted_class() {
        let table = element(
            "table",
            vec!["id".into(), "unsorted".into()],
            vec![
                element(
                    "thead",
                    vec![],
                    vec![element(
                        "tr",
                        vec![],
                        vec![
                            element("th", vec![], vec![text_node("Name")]),
                            element("th", vec![], vec![text_node("Amount")]),
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
                            element("td", vec![], vec![text_node("a")]),
                            element("td", vec![], vec![text_node("1")]),
                        ],
                    )],
                ),
            ],
        );

        let obs = make_dom(element("html", vec![], vec![table]));
        let entities = TableExtractor.extract(&obs);

        let table_entity = entities
            .iter()
            .find(|e| e.kind == EntityKind::Table)
            .unwrap();
        assert!(
            table_entity.properties.get("sorted_by").is_none(),
            "no sorted class means sorted_by should not be present"
        );
    }

    #[test]
    fn table_with_id_attribute_uses_id_as_fingerprint() {
        let table = element(
            "table",
            vec!["id".into(), "my-table".into()],
            vec![element(
                "tbody",
                vec![],
                vec![element(
                    "tr",
                    vec![],
                    vec![element("td", vec![], vec![text_node("x")])],
                )],
            )],
        );

        let obs = make_dom(element("html", vec![], vec![table]));
        let entities = TableExtractor.extract(&obs);

        let table_entity = entities
            .iter()
            .find(|e| e.kind == EntityKind::Table)
            .unwrap();
        assert_eq!(table_entity.stable_key.fingerprint, "my-table");
    }

    #[test]
    fn table_without_id_uses_index_as_fingerprint() {
        let table = element(
            "table",
            vec![], // no id attribute
            vec![element(
                "tbody",
                vec![],
                vec![element(
                    "tr",
                    vec![],
                    vec![element("td", vec![], vec![text_node("x")])],
                )],
            )],
        );

        let obs = make_dom(element("html", vec![], vec![table]));
        let entities = TableExtractor.extract(&obs);

        let table_entity = entities
            .iter()
            .find(|e| e.kind == EntityKind::Table)
            .unwrap();
        assert_eq!(
            table_entity.stable_key.fingerprint, "table-0",
            "table without id must use index-based fingerprint"
        );
    }
}
