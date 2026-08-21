//! Whole-product conformance engine.
//!
//! This crate owns the conformance corpus and the harness that executes it. It
//! is described in full by `docs/internal/whole-product-rust-conformance.md`
//! and tracked by issue #877; the module layout here follows that document.
//!
//! What exists so far is Wave 0's foundation: the canonical case record, its
//! identity function, the allocation manifest that a materialized corpus is
//! checked against, and the deterministic shard router. Nothing here executes a
//! case yet, and nothing here fakes production behaviour: a case either names a
//! migrated production Rust entry point or names the compiled release artifact,
//! and both live behind `target`.

pub mod corpus;
pub mod rng;
