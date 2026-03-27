use gs_types::*;
use serde_json::json;

use crate::Extractor;

/// Extracts generic page semantics that are useful across arbitrary websites.
/// This intentionally favors broad web primitives over site-specific schemas.
pub struct GenericExtractor;

impl Extractor for GenericExtractor {
    fn extract(&self, observation: &RawObservation) -> Vec<SemanticEntity> {
        let mut entities = Vec::new();

        extract_buttons(&observation.dom.root, &mut entities);
        extract_links(&observation.dom.root, &mut entities);
        extract_lists(&observation.dom.root, &mut entities);

        entities
    }
}

fn extract_buttons(root: &DomNode, entities: &mut Vec<SemanticEntity>) {
    let buttons = root.find_all(&|node| is_button(node));

    for (index, node) in buttons.iter().enumerate() {
        let label = button_label(node);
        if label.is_empty() {
            continue;
        }

        let fingerprint = node
            .get_attribute("id")
            .map(ToOwned::to_owned)
            .unwrap_or_else(|| format!("button-{}-{}", sanitize(&label), index));

        let disabled = node.get_attribute("disabled").is_some()
            || node
                .get_attribute("aria-disabled")
                .is_some_and(|value| value.eq_ignore_ascii_case("true"));

        // Extract ARIA state attributes (OS-ATLAS inspired — a11y tree enrichment)
        let mut props = serde_json::Map::new();
        props.insert("label".into(), json!(label));
        props.insert("disabled".into(), json!(disabled));
        props.insert(
            "role".into(),
            json!(
                node.get_attribute("role")
                    .map(ToOwned::to_owned)
                    .unwrap_or_else(|| "button".to_string())
            ),
        );

        for attr in &[
            "aria-expanded",
            "aria-selected",
            "aria-checked",
            "aria-pressed",
            "aria-hidden",
            "aria-current",
            "aria-controls",
            "aria-haspopup",
        ] {
            if let Some(value) = node.get_attribute(attr) {
                let key = attr.replace('-', "_");
                let typed_value = match value {
                    "true" => json!(true),
                    "false" => json!(false),
                    other => json!(other),
                };
                props.insert(key, typed_value);
            }
        }

        // Extract data-* attributes for row context (CI4A inspired)
        for pair in node.attributes.chunks(2) {
            if let (Some(name), Some(value)) = (pair.first(), pair.get(1))
                && let Some(suffix) = name.strip_prefix("data-")
            {
                let key = format!("data_{}", suffix.replace('-', "_"));
                props.insert(key, json!(value));
            }
        }

        let button_entity = SemanticEntity::new(
            EntityId(0),
            StableKey::new(EntityKind::Button, fingerprint),
            EntityKind::Button,
            serde_json::Value::Object(props),
            SourceRef {
                selector: selector_for_node(node),
                backend_node_id: Some(node.backend_node_id),
                a11y_id: None,
            },
            0.9,
        );
        entities.push(button_entity);
    }
}

fn extract_links(root: &DomNode, entities: &mut Vec<SemanticEntity>) {
    let links = root.find_all(&|node| {
        node.node_name.eq_ignore_ascii_case("A") && node.get_attribute("href").is_some()
    });

    for (index, node) in links.iter().enumerate() {
        let href = match node.get_attribute("href") {
            Some(href) if !href.trim().is_empty() => href.trim(),
            _ => continue,
        };
        let text = normalized_text(node);
        if text.is_empty() {
            continue;
        }

        let selector = selector_for_link(node, href);
        let link_entity = SemanticEntity::new(
            EntityId(0),
            StableKey::new(EntityKind::Link, format!("{}::{}", href, sanitize(&text))),
            EntityKind::Link,
            json!({
                "text": text,
                "href": href,
                "title": node.get_attribute("title"),
            }),
            SourceRef {
                selector: selector.clone(),
                backend_node_id: Some(node.backend_node_id),
                a11y_id: None,
            },
            0.92,
        );
        entities.push(link_entity);

        if looks_like_content_link(&text, href) {
            let search_result = SemanticEntity::new(
                EntityId(0),
                StableKey::new(
                    EntityKind::SearchResult,
                    format!("result::{}::{}", href, sanitize(&text)),
                ),
                EntityKind::SearchResult,
                json!({
                    "title": text,
                    "href": href,
                    "position": index + 1,
                }),
                SourceRef {
                    selector,
                    backend_node_id: Some(node.backend_node_id),
                    a11y_id: None,
                },
                0.84,
            );
            entities.push(search_result);
        }
    }
}

fn extract_lists(root: &DomNode, entities: &mut Vec<SemanticEntity>) {
    let lists = root.find_all(&|node| {
        node.node_name.eq_ignore_ascii_case("UL")
            || node.node_name.eq_ignore_ascii_case("OL")
            || node
                .get_attribute("role")
                .is_some_and(|role| role.eq_ignore_ascii_case("list"))
    });

    for (list_index, node) in lists.iter().enumerate() {
        let items = node.find_all(&|candidate| {
            candidate.node_name.eq_ignore_ascii_case("LI")
                || candidate
                    .get_attribute("role")
                    .is_some_and(|role| role.eq_ignore_ascii_case("listitem"))
        });

        let list_selector = selector_for_node(node);
        let list_fingerprint = node
            .get_attribute("id")
            .map(ToOwned::to_owned)
            .unwrap_or_else(|| format!("list-{list_index}"));

        entities.push(SemanticEntity::new(
            EntityId(0),
            StableKey::new(EntityKind::List, list_fingerprint.clone()),
            EntityKind::List,
            json!({
                "item_count": items.len(),
                "ordered": node.node_name.eq_ignore_ascii_case("OL"),
            }),
            SourceRef {
                selector: list_selector.clone(),
                backend_node_id: Some(node.backend_node_id),
                a11y_id: None,
            },
            0.86,
        ));

        for (item_index, item) in items.iter().enumerate() {
            let text = normalized_text(item);
            if text.is_empty() {
                continue;
            }

            let primary_link = item
                .find_all(&|candidate| {
                    candidate.node_name.eq_ignore_ascii_case("A")
                        && candidate.get_attribute("href").is_some()
                })
                .into_iter()
                .next();

            let primary_href = primary_link.and_then(|link| link.get_attribute("href"));
            let primary_text = primary_link.map(normalized_text);

            entities.push(SemanticEntity::new(
                EntityId(0),
                StableKey::new(
                    EntityKind::ListItem,
                    format!(
                        "{}-item-{}-{}",
                        list_fingerprint,
                        item_index,
                        sanitize(&text)
                    ),
                ),
                EntityKind::ListItem,
                json!({
                    "text": text,
                    "index": item_index + 1,
                    "primary_href": primary_href,
                    "primary_text": primary_text,
                }),
                SourceRef {
                    selector: selector_for_node(item),
                    backend_node_id: Some(item.backend_node_id),
                    a11y_id: None,
                },
                0.8,
            ));
        }
    }
}

fn is_button(node: &DomNode) -> bool {
    if node.node_name.eq_ignore_ascii_case("BUTTON") {
        return true;
    }

    if node
        .get_attribute("role")
        .is_some_and(|role| role.eq_ignore_ascii_case("button"))
    {
        return true;
    }

    node.node_name.eq_ignore_ascii_case("INPUT")
        && node.get_attribute("type").is_some_and(|input_type| {
            matches!(
                input_type.to_ascii_lowercase().as_str(),
                "button" | "submit" | "reset"
            )
        })
}

fn button_label(node: &DomNode) -> String {
    node.get_attribute("aria-label")
        .filter(|value| !value.trim().is_empty())
        .map(|value| value.trim().to_string())
        .or_else(|| {
            node.get_attribute("value")
                .filter(|value| !value.trim().is_empty())
                .map(|value| value.trim().to_string())
        })
        .unwrap_or_else(|| normalized_text(node))
}

fn selector_for_node(node: &DomNode) -> String {
    if let Some(id) = node.get_attribute("id") {
        return format!("#{}", css_escape(id));
    }

    if let Some(name) = node.get_attribute("name") {
        return format!(
            "{}[name=\"{}\"]",
            node.node_name.to_ascii_lowercase(),
            css_escape(name)
        );
    }

    node.selector_path()
}

fn selector_for_link(node: &DomNode, href: &str) -> String {
    if let Some(id) = node.get_attribute("id") {
        return format!("#{}", css_escape(id));
    }

    format!("a[href=\"{}\"]", css_escape(href))
}

fn normalized_text(node: &DomNode) -> String {
    node.text_content()
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .trim()
        .to_string()
}

fn looks_like_content_link(text: &str, href: &str) -> bool {
    let text_len = text.chars().count();
    let href_lower = href.to_ascii_lowercase();
    text_len >= 18
        && (text.contains(char::is_whitespace) || !text.contains('.'))
        && !href.starts_with('#')
        && !href_lower.starts_with("javascript:")
        && !href_lower.starts_with("mailto:")
}

fn sanitize(value: &str) -> String {
    value
        .to_ascii_lowercase()
        .chars()
        .map(|ch| if ch.is_ascii_alphanumeric() { ch } else { '-' })
        .collect::<String>()
}

fn css_escape(value: &str) -> String {
    value.replace('\\', "\\\\").replace('"', "\\\"")
}
