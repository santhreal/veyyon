//! Motion role table, physics spring integrator, and animator registry for the
//! veyyon desktop surface.
//!
//! Provides deterministic, frame-rate independent spring physics (§8.23),
//! standard cubic bezier curves, centralized reduced motion resolution (§7.2),
//! and remount-resilient animation tracking (§7.3).

pub mod curves;
pub mod error;
pub mod registry;
pub mod role;
pub mod spring;
pub mod tokens;

pub use curves::{CubicBezier, EasingCurve};
pub use error::MotionError;
pub use registry::{ActiveAnimation, AnimatorKey, AnimatorRegistry, SurfaceId};
pub use role::{
	ALL_ROLES, DirectThenSpringModel, DurationModel, FlipModel, MotionModel, MotionRole,
	ResolvedMotion, SpringFadeModel, TwoStepModel, resolve_motion,
};
pub use spring::{SpringModel, SpringState};
pub use tokens::MotionTokens;
