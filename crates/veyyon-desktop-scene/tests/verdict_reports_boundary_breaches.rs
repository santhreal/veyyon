//! Contract test: verdict checks hard ceilings inclusively at the boundary,
//! names each breached metric, ignores diagnostic metrics, and renders reports.

use veyyon_desktop_scene::metrics::{
	ClutterMetrics, DENSEST_REGION_CEILING, MetricReport, SurfaceClass, check,
};

#[test]
fn test_metrics_exactly_at_ceiling_pass() {
	// QueueRowCard ceilings: edges: 2.0, gaps: 3, text_sizes: 3, interactive: 3
	let metrics = ClutterMetrics {
		distinct_gaps:       3,
		distinct_text_sizes: 3,
		edge_count:          2.0,
		ink_ratio:           0.85, // reported only
		element_density:     DENSEST_REGION_CEILING,
		alignment_residue:   0.45, // reported only
	};

	let verdict = check(&metrics, SurfaceClass::QueueRowCard);
	assert!(verdict.passed());
	assert!(verdict.breaches().is_empty());
}

#[test]
fn test_metrics_one_step_above_ceiling_are_flagged_as_breaches() {
	// 1. Gaps breach
	let mut metrics = ClutterMetrics {
		distinct_gaps:       4, // ceiling is 3
		distinct_text_sizes: 3,
		edge_count:          2.0,
		ink_ratio:           0.0,
		element_density:     10.0,
		alignment_residue:   0.0,
	};
	let v1 = check(&metrics, SurfaceClass::QueueRowCard);
	assert!(!v1.passed());
	assert_eq!(v1.breaches().len(), 1);
	assert_eq!(v1.breaches()[0].metric, "distinct_gaps");

	// 2. Text sizes breach
	metrics.distinct_gaps = 3;
	metrics.distinct_text_sizes = 4; // ceiling is 3
	let v2 = check(&metrics, SurfaceClass::QueueRowCard);
	assert!(!v2.passed());
	assert_eq!(v2.breaches().len(), 1);
	assert_eq!(v2.breaches()[0].metric, "distinct_text_sizes");

	// 3. Edge count breach
	metrics.distinct_text_sizes = 3;
	metrics.edge_count = 2.1; // ceiling is 2.0
	let v3 = check(&metrics, SurfaceClass::QueueRowCard);
	assert!(!v3.passed());
	assert_eq!(v3.breaches().len(), 1);
	assert_eq!(v3.breaches()[0].metric, "edge_count");

	// 4. Element density breach
	metrics.edge_count = 2.0;
	metrics.element_density = 21.0; // ceiling is 20.8
	let v4 = check(&metrics, SurfaceClass::QueueRowCard);
	assert!(!v4.passed());
	assert_eq!(v4.breaches().len(), 1);
	assert_eq!(v4.breaches()[0].metric, "element_density");
}

#[test]
fn test_reported_only_metrics_never_cause_breach() {
	let metrics = ClutterMetrics {
		distinct_gaps:       1,
		distinct_text_sizes: 1,
		edge_count:          0.5,
		ink_ratio:           1.0, // extreme ink
		element_density:     5.0,
		alignment_residue:   1.0, // completely off-grid
	};

	let verdict = check(&metrics, SurfaceClass::BlockChrome);
	assert!(verdict.passed());
}

#[test]
fn test_metric_report_display_formatting() {
	let metrics = ClutterMetrics {
		distinct_gaps:       2,
		distinct_text_sizes: 2,
		edge_count:          1.0,
		ink_ratio:           0.045,
		element_density:     4.5,
		alignment_residue:   0.0,
	};

	let report = MetricReport::new(metrics, SurfaceClass::BlockChrome);
	let output = format!("{report}");

	assert!(output.contains("[PASS]"));
	assert!(output.contains("edges: 1.0"));
	assert!(output.contains("gaps: 2"));
	assert!(output.contains("text: 2"));
}
