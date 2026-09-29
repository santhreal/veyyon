/**
 * The workflow tier: one job carried across two or three of the suite's applications, each step
 * using what an earlier one found in another application. Every task starts its own copies of the
 * applications it spans, from separate seeded streams of the trial seed.
 */

import type { KitTask } from "../../../../engine/kit/catalog";
import { metricsReportTask } from "./metrics-report";
import { payInvoiceFromMailTask } from "./pay-invoice-from-mail";
import { reconcileAndDisputeTask } from "./reconcile-and-dispute";
import { returnFromSupportThreadTask } from "./return-from-support-thread";
import { tripForMeetingTask } from "./trip-for-meeting";

export const WORKFLOW_TASKS: readonly KitTask[] = [
	payInvoiceFromMailTask,
	tripForMeetingTask,
	reconcileAndDisputeTask,
	metricsReportTask,
	returnFromSupportThreadTask,
];
