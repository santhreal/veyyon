//! In-memory virtual filesystem, copy-on-write overlay, and deterministic fault
//! injection.
//!
//! Owned by the `vfs` lane; implements virtual filesystem isolation as
//! specified in `docs/internal/whole-product-rust-conformance.md` Section "2.
//! Virtual Filesystem (`vfs`)".
//!
//! # Architecture & Components
//!
//! 1. **Narrow I/O Trait ([`FileSystem`])**: Defines the essential I/O
//!    operations required by conformance testing and migrated Rust production
//!    crates (`read`, `write`, `append`, `metadata`, `create_dir_all`,
//!    `read_dir`, `remove_file`, `remove_dir_all`, `rename`, `exists`). Avoids
//!    bloated syscall abstractions while ensuring portable execution across
//!    direct-Rust cases.
//!
//! 2. **In-Memory Filesystem ([`MemoryFs`])**: Thread-safe, in-memory tree
//!    implementation. Strictly normalizes path components and refuses path
//!    traversal above the virtual root with [`VfsError::PathEscapesRoot`].
//!
//! 3. **Copy-on-Write Isolation ([`Overlay`])**: Provides isolated filesystem
//!    environments for shards and test cases by overlaying mutations on top of
//!    a shared, immutable base [`MemoryFs`] wrapped in [`std::sync::Arc`].
//!    Deletes are recorded as tombstones (`whiteouts`), ensuring the base tree
//!    is never mutated and modifications are invisible to sibling overlays.
//!
//! 4. **Deterministic Fault Injection ([`FaultInjectingFs`], [`FaultPlan`])**:
//!    Intercepts operations at the trait boundary and injects simulated I/O
//!    errors (`EIO`), disk exhaustion (`ENOSPC`), permission denials
//!    (`EACCES`), partial writes (persisting strictly the accepted prefix),
//!    torn writes (simulating non-atomic sector persistence), and virtual
//!    latency delays. Driven deterministically by [`crate::rng::Rng`].
//!
//! 5. **Total-Ordered Operation Log ([`OpLog`], [`LoggingFs`])**: Monotonically
//!    logs every filesystem invocation with its arguments and outcome,
//!    guaranteeing that log records survive faults and allow cases to assert
//!    sequence invariants.
//!
//! 6. **Content-Addressed Fixture Population ([`populate_from_fixture`])**:
//!    Populates a [`FileSystem`] from serialized [`FixtureTree`] bytes
//!    addressed by a [`crate::corpus::FixtureRef`], refusing any payload whose
//!    BLAKE3 digest does not match.

pub mod error;
pub mod fault;
pub mod fixture;
pub mod log;
pub mod memory;
pub mod overlay;
pub mod path;
pub mod traits;

#[cfg(test)]
mod tests;

pub use error::{VfsError, VfsResult};
pub use fault::{FaultInjectingFs, FaultKind, FaultPlan, TornWriteMode};
pub use fixture::{FixtureTree, populate_from_fixture};
pub use log::{LoggingFs, OpKind, OpLog, OpOutcome, OpRecord};
pub use memory::MemoryFs;
pub use overlay::Overlay;
pub use path::VfsPath;
pub use traits::{FileSystem, VfsDirEntry, VfsFileType, VfsMetadata};
