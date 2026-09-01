pub mod color;
pub mod dumper;
pub mod dumper_surface;
pub mod elevation;
pub mod error;
pub mod loader;
pub mod loader_ceilings;
pub mod loader_elevation;
pub mod loader_motion;
pub mod loader_scale;
pub mod loader_surface;
pub mod loader_surface_primary;
pub mod loader_surface_secondary;
pub mod loader_surface_shell;
pub mod loader_theme;
pub mod motion;
pub mod schema;
pub mod surface;
pub mod watcher;

pub use color::{ColorParseError, ColorRole, RgbColor, Theme};
pub use dumper::dump_to_dir;
pub use elevation::{ElevationLevel, ElevationTokens};
pub use error::TokenError;
pub use loader::load_from_dir;
pub use loader_theme::{APPEARANCES, THEME_VERSION, load_bundled_themes, load_theme};
pub use motion::{
	DirectThenSpringModel, DurationModel, EasingCurve, FlipModel, MotionModel, MotionRole,
	MotionRoleConfig, MotionTokens, ReducedMotion, SpringFadeModel, SpringModel, TwoStepModel,
};
pub use schema::{
	CeilingTokens, DensityRegionCeiling, MonoSizeStep, RadiusStep, ScaleTokens, SpacingStep,
	StrokeStep, SurfaceCeilings, TypeSize, TypeSizeStep, TypeWeightStep,
};
pub use surface::{
	AttachedCardsSurfaceTokens, BreakpointConfig, BreakpointsSurfaceTokens, ComposerSurfaceTokens,
	PaletteSurfaceTokens, PanelsSurfaceTokens, QueueSurfaceTokens, SettingsSurfaceTokens,
	ShellSurfaceTokens, SurfaceTokens, TranscriptSurfaceTokens,
};
pub use watcher::{TokenReloadMessage, TokenWatcher};

/// Root container holding all resolved design tokens.
#[derive(Debug, Clone, PartialEq)]
pub struct Tokens {
	pub scale:     ScaleTokens,
	pub elevation: ElevationTokens,
	pub ceilings:  CeilingTokens,
	pub motion:    MotionTokens,
	pub surface:   SurfaceTokens,
}
