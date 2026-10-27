import { assert } from "@effect/vitest";
import type { ProviderReplayTranscript } from "@t3tools/contracts";

import type { OrchestratorV2ScenarioResult } from "../../OrchestratorScenario.ts";
import {
  assertAssistantTextIncludes,
  assertBaseProjection,
  assertSemanticProjectionIntegrity,
  assertUserMessagesInclude,
  assertVisibleTurnItemsMirrorLocalTurnItems,
  OPENCODE2_COMPACTION_FIRST_PROMPT,
  OPENCODE2_COMPACTION_RECALL_PROMPT,
  projectionFor,
} from "../shared.ts";

/**
 * OpenCode compacts on its own: the second turn's execution summarizes the
 * context before its model step, and the same turn then answers from the
 * summary. The compaction belongs to that turn, between the prompt and the
 * answer.
 */
export function assertOpenCode2CompactionOutput(
  result: OrchestratorV2ScenarioResult,
  transcript: ProviderReplayTranscript,
) {
  assertBaseProjection({
    result,
    transcript,
    runCount: 2,
    runStatuses: ["completed", "completed"],
  });
  const projection = projectionFor(result, transcript.scenario);
  assertSemanticProjectionIntegrity(projection);
  assertVisibleTurnItemsMirrorLocalTurnItems(projection);
  assertUserMessagesInclude(projection, [
    OPENCODE2_COMPACTION_FIRST_PROMPT,
    OPENCODE2_COMPACTION_RECALL_PROMPT,
  ]);

  const recallRun = projection.runs[1];
  const compactions = projection.turnItems.filter((item) => item.type === "compaction");
  assert.lengthOf(compactions, 1);
  const [compaction] = compactions;
  assert.equal(compaction?.runId, recallRun?.id);
  assert.equal(compaction?.status, "completed");
  assert.equal(compaction?.title, "Context compacted");
  assert.include(compaction?.type === "compaction" ? compaction.summary : "", "PAPAYA");
  assert.include(compaction?.type === "compaction" ? compaction.summary : "", "## Objective");
  const answer = projection.turnItems.find(
    (item) => item.type === "assistant_message" && item.runId === recallRun?.id,
  );
  assert.isDefined(answer);
  assert.isBelow(compaction!.ordinal, answer!.ordinal);
  assertAssistantTextIncludes(projection, "PAPAYA");
  assert.deepEqual(
    projection.providerTurns.map((turn) => turn.status),
    ["completed", "completed"],
  );
}
