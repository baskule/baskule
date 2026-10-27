import { ProviderDriverKind } from "@t3tools/contracts";

import { openCode2InboxInput } from "./opencode2_inbox/input.ts";
import { openCode2RevertInput } from "./opencode2_revert/input.ts";
import { assertOpenCode2RevertOutput } from "./opencode2_revert/output.ts";
import { assertOpenCode2InboxOutput } from "./opencode2_inbox/output.ts";
import { openCode2CompactionInput } from "./opencode2_compaction/input.ts";
import { assertOpenCode2CompactionOutput } from "./opencode2_compaction/output.ts";
import { openCode2InterruptInput } from "./opencode2_interrupt/input.ts";
import { assertOpenCode2InterruptOutput } from "./opencode2_interrupt/output.ts";
import { openCode2PermissionInput } from "./opencode2_permission/input.ts";
import { assertOpenCode2PermissionOutput } from "./opencode2_permission/output.ts";
import { openCode2QuestionInput } from "./opencode2_question/input.ts";
import { assertOpenCode2QuestionOutput } from "./opencode2_question/output.ts";
import { openCode2BackgroundInput } from "./opencode2_background/input.ts";
import { assertOpenCode2BackgroundOutput } from "./opencode2_background/output.ts";
import { openCode2NestedBackgroundInput } from "./opencode2_nested_background/input.ts";
import { assertOpenCode2NestedBackgroundOutput } from "./opencode2_nested_background/output.ts";
import { openCode2SubagentInput } from "./opencode2_subagent/input.ts";
import { assertOpenCode2SubagentOutput } from "./opencode2_subagent/output.ts";
import { openCode2ResumeAfterRestartInput } from "./opencode2_resume_after_restart/input.ts";
import { assertOpenCode2ResumeAfterRestartOutput } from "./opencode2_resume_after_restart/output.ts";
import { openCode2SimpleInput } from "./opencode2_simple/input.ts";
import { assertOpenCode2SimpleOutput } from "./opencode2_simple/output.ts";
import { openCode2ToolCallInput } from "./opencode2_tool_call/input.ts";
import { assertOpenCode2ToolCallOutput } from "./opencode2_tool_call/output.ts";
import { OPENCODE2_MODEL_SELECTION, type OrchestratorReplayFixture } from "./shared.ts";

export const ORCHESTRATOR_REPLAY_FIXTURES: ReadonlyArray<OrchestratorReplayFixture> = [
  {
    name: "opencode2_simple",
    buildInput: openCode2SimpleInput,
    providers: [
      {
        driver: ProviderDriverKind.make("opencode"),
        transcriptFile: new URL("./opencode2_simple/opencode_transcript.ndjson", import.meta.url),
        modelSelection: OPENCODE2_MODEL_SELECTION,
        assertOutput: assertOpenCode2SimpleOutput,
      },
    ],
  },
  {
    name: "opencode2_tool_call",
    buildInput: openCode2ToolCallInput,
    providers: [
      {
        driver: ProviderDriverKind.make("opencode"),
        transcriptFile: new URL(
          "./opencode2_tool_call/opencode_transcript.ndjson",
          import.meta.url,
        ),
        modelSelection: {
          instanceId: OPENCODE2_MODEL_SELECTION.instanceId,
          model: "opencode/big-pickle",
        },
        assertOutput: assertOpenCode2ToolCallOutput,
      },
    ],
  },
  {
    name: "opencode2_interrupt",
    buildInput: openCode2InterruptInput,
    providers: [
      {
        driver: ProviderDriverKind.make("opencode"),
        transcriptFile: new URL(
          "./opencode2_interrupt/opencode_transcript.ndjson",
          import.meta.url,
        ),
        modelSelection: {
          instanceId: OPENCODE2_MODEL_SELECTION.instanceId,
          model: "opencode/big-pickle",
        },
        assertOutput: assertOpenCode2InterruptOutput,
      },
    ],
  },
  {
    name: "opencode2_inbox",
    buildInput: openCode2InboxInput,
    providers: [
      {
        driver: ProviderDriverKind.make("opencode"),
        transcriptFile: new URL("./opencode2_inbox/opencode_transcript.ndjson", import.meta.url),
        modelSelection: {
          instanceId: OPENCODE2_MODEL_SELECTION.instanceId,
          model: "opencode/big-pickle",
        },
        assertOutput: assertOpenCode2InboxOutput,
      },
    ],
  },
  {
    name: "opencode2_revert",
    buildInput: openCode2RevertInput,
    providers: [
      {
        driver: ProviderDriverKind.make("opencode"),
        transcriptFile: new URL("./opencode2_revert/opencode_transcript.ndjson", import.meta.url),
        modelSelection: {
          instanceId: OPENCODE2_MODEL_SELECTION.instanceId,
          model: "opencode/big-pickle",
        },
        assertOutput: assertOpenCode2RevertOutput,
      },
    ],
  },
  {
    name: "opencode2_permission",
    buildInput: openCode2PermissionInput,
    providers: [
      {
        driver: ProviderDriverKind.make("opencode"),
        transcriptFile: new URL(
          "./opencode2_permission/opencode_transcript.ndjson",
          import.meta.url,
        ),
        modelSelection: {
          instanceId: OPENCODE2_MODEL_SELECTION.instanceId,
          model: "opencode/big-pickle",
        },
        assertOutput: assertOpenCode2PermissionOutput,
      },
    ],
  },
  {
    name: "opencode2_question",
    buildInput: openCode2QuestionInput,
    providers: [
      {
        driver: ProviderDriverKind.make("opencode"),
        transcriptFile: new URL("./opencode2_question/opencode_transcript.ndjson", import.meta.url),
        modelSelection: {
          instanceId: OPENCODE2_MODEL_SELECTION.instanceId,
          model: "opencode/big-pickle",
        },
        assertOutput: assertOpenCode2QuestionOutput,
      },
    ],
  },
  {
    name: "opencode2_subagent",
    buildInput: openCode2SubagentInput,
    providers: [
      {
        driver: ProviderDriverKind.make("opencode"),
        transcriptFile: new URL("./opencode2_subagent/opencode_transcript.ndjson", import.meta.url),
        modelSelection: {
          instanceId: OPENCODE2_MODEL_SELECTION.instanceId,
          model: "opencode/big-pickle",
        },
        assertOutput: assertOpenCode2SubagentOutput,
      },
    ],
  },
  {
    name: "opencode2_background",
    buildInput: openCode2BackgroundInput,
    providers: [
      {
        driver: ProviderDriverKind.make("opencode"),
        transcriptFile: new URL(
          "./opencode2_background/opencode_transcript.ndjson",
          import.meta.url,
        ),
        modelSelection: {
          instanceId: OPENCODE2_MODEL_SELECTION.instanceId,
          model: "opencode/big-pickle",
        },
        runContinuationWorker: true,
        assertOutput: assertOpenCode2BackgroundOutput,
      },
    ],
  },
  {
    name: "opencode2_nested_background",
    buildInput: openCode2NestedBackgroundInput,
    providers: [
      {
        driver: ProviderDriverKind.make("opencode"),
        transcriptFile: new URL(
          "./opencode2_nested_background/opencode_transcript.ndjson",
          import.meta.url,
        ),
        modelSelection: {
          instanceId: OPENCODE2_MODEL_SELECTION.instanceId,
          model: "openrouter/deepseek/deepseek-v4-flash",
        },
        assertOutput: assertOpenCode2NestedBackgroundOutput,
      },
    ],
  },
  {
    name: "opencode2_compaction",
    buildInput: openCode2CompactionInput,
    providers: [
      {
        driver: ProviderDriverKind.make("opencode"),
        transcriptFile: new URL(
          "./opencode2_compaction/opencode_transcript.ndjson",
          import.meta.url,
        ),
        modelSelection: {
          instanceId: OPENCODE2_MODEL_SELECTION.instanceId,
          model: "opencode/big-pickle",
        },
        assertOutput: assertOpenCode2CompactionOutput,
      },
    ],
  },
  {
    name: "opencode2_resume_after_restart",
    buildInput: openCode2ResumeAfterRestartInput,
    providers: [
      {
        driver: ProviderDriverKind.make("opencode"),
        transcriptFile: new URL(
          "./opencode2_resume_after_restart/opencode_transcript.ndjson",
          import.meta.url,
        ),
        modelSelection: {
          instanceId: OPENCODE2_MODEL_SELECTION.instanceId,
          model: "opencode/big-pickle",
        },
        assertOutput: assertOpenCode2ResumeAfterRestartOutput,
      },
    ],
  },
];
