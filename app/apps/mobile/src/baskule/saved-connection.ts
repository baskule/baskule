import * as Schema from "effect/Schema";

const authentication = Schema.Struct({
  mode: Schema.Literals(["authenticated", "anonymous"]),
  password: Schema.Boolean,
  providers: Schema.mutable(
    Schema.Array(
      Schema.Struct({
        id: Schema.String,
        name: Schema.String,
        type: Schema.Literals(["social", "oidc"]),
      }),
    ),
  ),
});
const me = Schema.Struct({
  authentication,
  voiceInput: Schema.Boolean,
  user: Schema.Struct({
    id: Schema.String,
    name: Schema.String,
    email: Schema.String,
    role: Schema.Literals(["admin", "member"]),
  }),
  organization: Schema.Struct({ id: Schema.String, name: Schema.String }),
  spaces: Schema.Array(
    Schema.Struct({
      id: Schema.String,
      name: Schema.String,
      base: Schema.String,
      kind: Schema.Literals(["personal", "team"]),
      role: Schema.Literals(["owner", "member"]),
    }),
  ),
});
const savedConnection = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("disconnected"), serverUrl: Schema.NullOr(Schema.String) }),
  Schema.Struct({
    kind: Schema.Literals(["authenticated", "anonymous"]),
    serverUrl: Schema.String,
    me,
  }),
]);
export type SavedConnection = typeof savedConnection.Type;
export const decodeSavedConnection = Schema.decodeUnknownSync(
  Schema.fromJsonString(savedConnection),
);
