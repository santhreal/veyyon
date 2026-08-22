//! Whole-product conformance engine.
//!
//! This crate owns the conformance corpus and the harness that executes it. It
//! is described in full by `docs/internal/whole-product-rust-conformance.md`
//! and tracked by issue #877; the module layout here follows that document.
//!
//! `corpus` is the committed contract: the canonical case record, its identity
//! function, the allocation manifest a materialized corpus is checked against,
//! and the deterministic shard router. Everything else is the harness that
//! executes a case.
//!
//! `generator` produces the rows and accounts for every one that did not land;
//! `oracle` judges a run against the row that produced it. They are separate
//! because an expectation derived from the observation it judges is a test that
//! cannot fail: a generator never sees a result, and an oracle never computes
//! one.
//!
//! Nothing here fakes production behaviour. A case either names a migrated
//! production Rust entry point or names the compiled release artifact, and both
//! live behind `corpus::Target`. The four virtual subsystems below isolate a
//! case from the machine it runs on — time, filesystem, terminal, network — and
//! none of them substitutes for the code under test.
//!
//! `mutation::CriticalPath` names the six production paths where one surviving
//! mutant is one shipped defect, and the campaign gate sweeps that array rather
//! than a written list, so a seventh path makes every campaign red until it is
//! covered. Three are uncovered today: `credentials`, `path-traversal` and
//! `checksum-verification`. Covering one means a mutant the corpus can execute
//! against a real entry point on that path, and a killed verdict recorded for
//! it. Until then the gate reports `covered=false` for each, which is a hole
//! and not a pass.

pub mod corpus;
pub mod fuzz;
pub mod generator;
pub mod model_check;
pub mod mutation;
pub mod oracle;
pub mod render;
pub mod report;
pub mod rng;
pub mod shrink;
pub mod vclock;
pub mod vfs;
pub mod vmock;
pub mod vpty;
