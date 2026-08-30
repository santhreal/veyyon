//! The model, the moves over it, and the two seams the engine replaces.
//!
//! Nothing in here links against gpui. The window holds one [`model::Store`] in
//! a gpui entity and calls a [`moves`] function per interaction; every decision
//! with a right answer is in this directory and is tested without a window.

pub mod agent;
pub mod model;
pub mod moves;
pub mod seed;

#[cfg(test)]
mod tests;
