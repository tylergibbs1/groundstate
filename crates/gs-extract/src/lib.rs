pub mod actions;
#[cfg(test)]
mod extraction_tests;
pub mod generic;
pub mod table;

use gs_graph::StateGraph;
use gs_types::{RawObservation, SemanticEntity};

/// Trait for extracting semantic entities from raw browser observations.
pub trait Extractor: Send + Sync {
    /// Extract entities from a raw observation, returning new or updated entities.
    fn extract(&self, observation: &RawObservation) -> Vec<SemanticEntity>;
}

/// Runs a pipeline of extractors against an observation and upserts results into the graph.
pub struct ExtractorPipeline {
    extractors: Vec<Box<dyn Extractor>>,
}

impl Default for ExtractorPipeline {
    fn default() -> Self {
        Self::new()
    }
}

impl ExtractorPipeline {
    pub fn new() -> Self {
        Self {
            extractors: Vec::new(),
        }
    }

    /// Create a pipeline with the default set of extractors for the MVP.
    pub fn default_pipeline() -> Self {
        let mut pipeline = Self::new();
        pipeline.add(Box::new(generic::GenericExtractor));
        pipeline.add(Box::new(table::TableExtractor));
        pipeline
    }

    pub fn add(&mut self, extractor: Box<dyn Extractor>) {
        self.extractors.push(extractor);
    }

    /// Run all extractors against the observation and upsert results into the graph.
    /// Returns the list of entity IDs that were inserted or updated.
    pub fn extract_and_upsert(
        &self,
        observation: &RawObservation,
        graph: &mut StateGraph,
    ) -> Vec<gs_types::EntityId> {
        let mut ids = Vec::new();

        for extractor in &self.extractors {
            let entities = extractor.extract(observation);
            for entity in entities {
                let id = graph.upsert(entity);
                ids.push(id);
            }
        }

        ids
    }
}
