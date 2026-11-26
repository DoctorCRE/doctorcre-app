// Aggregate exports for self-contained Node test bundles. Browser entries are
// selected separately in scripts/ui-bundle.mjs.

export { mountActionLink } from "./action-link";
export { mountActivityAttributionView, parseActivityDealAttribution } from "./activity-attribution";
export { disposeAnswerBlocks, mountAnswerBlocks } from "./answer-blocks";
export { mountCallReview, mountCallReviewDialog } from "./call-review";
export { mountClientAnniversaries } from "./client-anniversaries";
export { createContactReasonsView } from "./contact-reasons";
export { mountDealChecklist } from "./deal-checklist";
export { mountDealDocuments } from "./deal-documents";
export { mountDealRoomAgenda } from "./deal-room-agenda";
export { mountDealRoomBoard } from "./deal-room-board";
export { mountDealTours } from "./deal-tours";
export { mountDealUpdateReviews } from "./home/deal-update-reviews";
export { mountMissingNextStep } from "./home/missing-next-step";
export * as homeTaskDone from "./home/task-done";
export { homeListLimit } from "./home-list-limit";
export { hostNode } from "./host-node";

export { mountIdealClientProfile } from "./ideal-client-profile";
export { mountLeadGuidance } from "./lead-guidance";
export { mountLeadResearch } from "./lead-research";
export { mountMarketStudy, mountPortal } from "./portal/shell-home-sources";
export { mountRelationshipKindFilter, relationshipKind } from "./relationship-kind-filter";
export { mountWorkspace } from "./workspace-shell";
export { mountZoomableWorkspace } from "./workspace-zoom";
