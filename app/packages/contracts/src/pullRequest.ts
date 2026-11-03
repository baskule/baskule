import * as Schema from "effect/Schema";
import * as Effect from "effect/Effect";

import { NonNegativeInt, PositiveInt, TrimmedNonEmptyString } from "./baseSchemas.ts";

export const PullRequestInvolvement = Schema.Literals(["all", "reviewing", "authored"]);
export type PullRequestInvolvement = typeof PullRequestInvolvement.Type;

export const PullRequestState = Schema.Literals(["open", "closed", "merged"]);
export type PullRequestState = typeof PullRequestState.Type;

export const PullRequestListState = Schema.Literals(["all", "open", "closed", "merged"]);
export type PullRequestListState = typeof PullRequestListState.Type;

export const PullRequestReviewDecision = Schema.Literals([
  "approved",
  "changes-requested",
  "review-required",
]);
export type PullRequestReviewDecision = typeof PullRequestReviewDecision.Type;

const PullRequestQualifierValue = TrimmedNonEmptyString.check(Schema.isMaxLength(200));
const PullRequestQualifierValues = Schema.Array(PullRequestQualifierValue).check(
  Schema.isMaxLength(10),
);

export const PullRequestListFilters = Schema.Struct({
  draft: Schema.optional(Schema.Literals(["only", "hide"])),
  review: Schema.optional(
    Schema.Literals(["approved", "changes-requested", "review-required", "none"]),
  ),
  checks: Schema.optional(Schema.Literals(["passing", "failing"])),
  /** GitHub label qualifiers: every group must match; any name within a group suffices. */
  labels: Schema.optional(Schema.Array(PullRequestQualifierValues).check(Schema.isMaxLength(10))),
  excludedLabels: Schema.optional(PullRequestQualifierValues),
  author: Schema.optional(PullRequestQualifierValue),
});
export type PullRequestListFilters = typeof PullRequestListFilters.Type;

export const PullRequestChecksState = Schema.Literals(["passing", "failing", "pending"]);
export type PullRequestChecksState = typeof PullRequestChecksState.Type;

export const PullRequestMergeability = Schema.Literals(["mergeable", "conflicting", "unknown"]);
export type PullRequestMergeability = typeof PullRequestMergeability.Type;

export const PullRequestMergeMethod = Schema.Literals(["merge", "squash", "rebase"]);
export type PullRequestMergeMethod = typeof PullRequestMergeMethod.Type;

export const PullRequestActor = Schema.Struct({
  isBot: Schema.optional(Schema.Boolean),
  login: TrimmedNonEmptyString,
  name: Schema.NullOr(Schema.String),
  avatarUrl: Schema.NullOr(Schema.String),
});
export type PullRequestActor = typeof PullRequestActor.Type;

export const PullRequestDiffSide = Schema.Literals(["left", "right"]);
export type PullRequestDiffSide = typeof PullRequestDiffSide.Type;

const PullRequestLineCount = Schema.Struct({
  additions: NonNegativeInt,
  deletions: NonNegativeInt,
});

/**
 * A change's line counts split by what the changed files are, judged from their paths. Null when
 * the host gives no per-file counts, or has more files than one read covers: a split of part of
 * the change would not add up to the totals shown beside it.
 */
export const PullRequestChangeBreakdown = Schema.NullOr(
  Schema.Struct({
    code: PullRequestLineCount,
    tests: PullRequestLineCount,
    mocks: PullRequestLineCount,
    generated: PullRequestLineCount,
    // Servers from before the docs split send no key; their docs lines sit in `code`.
    docs: PullRequestLineCount.pipe(
      Schema.withDecodingDefault(Effect.succeed({ additions: 0, deletions: 0 })),
    ),
  }),
);
export type PullRequestChangeBreakdown = typeof PullRequestChangeBreakdown.Type;

export const PullRequestReviewPosition = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("added"),
    newLine: PositiveInt,
  }),
  Schema.Struct({
    kind: Schema.Literal("deleted"),
    oldLine: PositiveInt,
  }),
  Schema.Struct({
    kind: Schema.Literal("context"),
    oldLine: PositiveInt,
    newLine: PositiveInt,
    side: PullRequestDiffSide,
  }),
]);
export type PullRequestReviewPosition = typeof PullRequestReviewPosition.Type;
