/**
 * Shared argument descriptions.
 *
 * One sentence, in one place, because the MCP target compiles it straight into
 * a tool's `inputSchema` (P2-AGT-01, contract 04 §2.2) and that property
 * description is the whole of what the model is told about the argument. Four
 * skills take a work item id; four independently-worded descriptions of the
 * same thing is how a caller learns that `work-item-id` means something
 * slightly different depending on which tool it is calling.
 */

export const WORK_ITEM_ID_ARG =
  'The id of the work item this run is about, e.g. FEAT-014. Must name an existing card.';
