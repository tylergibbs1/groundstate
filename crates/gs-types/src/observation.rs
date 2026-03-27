use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};

/// Raw DOM snapshot captured via CDP DOM.getDocument.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DomSnapshot {
    pub root: DomNode,
}

/// A single node in the DOM tree.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DomNode {
    pub node_id: i64,
    pub backend_node_id: i64,
    pub node_type: i32,
    pub node_name: String,
    pub node_value: String,
    pub attributes: Vec<String>,
    pub children: Vec<DomNode>,
}

impl DomNode {
    /// Get an attribute value by name.
    pub fn get_attribute(&self, name: &str) -> Option<&str> {
        // CDP returns attributes as flat [name, value, name, value, ...]
        self.attributes
            .chunks(2)
            .find(|pair| pair.first().is_some_and(|n| n == name))
            .and_then(|pair| pair.get(1).map(|v| v.as_str()))
    }

    /// Get the text content of this node (shallow — immediate text node children).
    pub fn text_content(&self) -> String {
        let mut text = String::new();
        if self.node_type == 3 {
            // Text node
            text.push_str(&self.node_value);
        }
        for child in &self.children {
            text.push_str(&child.text_content());
        }
        text
    }

    /// Find all descendant nodes matching a predicate.
    pub fn find_all<F>(&self, predicate: &F) -> Vec<&DomNode>
    where
        F: Fn(&DomNode) -> bool,
    {
        let mut results = Vec::new();
        if predicate(self) {
            results.push(self);
        }
        for child in &self.children {
            results.extend(child.find_all(predicate));
        }
        results
    }

    /// Find direct child nodes matching a predicate (non-recursive).
    pub fn find_children<F>(&self, predicate: &F) -> Vec<&DomNode>
    where
        F: Fn(&DomNode) -> bool,
    {
        self.children
            .iter()
            .filter(|child| predicate(child))
            .collect()
    }

    /// Build a simple CSS-like selector path to this node.
    pub fn selector_path(&self) -> String {
        let tag = self.node_name.to_lowercase();
        if let Some(id) = self.get_attribute("id") {
            format!("#{id}")
        } else {
            tag
        }
    }
}

/// Accessibility tree snapshot captured via CDP Accessibility.getFullAXTree.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct A11ySnapshot {
    pub nodes: Vec<A11yNode>,
}

/// A single node in the accessibility tree.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct A11yNode {
    pub node_id: String,
    pub role: String,
    pub name: Option<String>,
    pub value: Option<String>,
    pub backend_dom_node_id: Option<i64>,
    pub children: Vec<String>,
    pub properties: Vec<A11yProperty>,
}

/// An accessibility property on a node.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct A11yProperty {
    pub name: String,
    pub value: serde_json::Value,
}

/// Combined raw observation from a single browser snapshot pass.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RawObservation {
    pub dom: DomSnapshot,
    pub a11y: Option<A11ySnapshot>,
    pub url: String,
    pub title: String,
    pub timestamp: DateTime<Utc>,
}
