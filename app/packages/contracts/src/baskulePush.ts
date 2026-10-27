import * as Schema from "effect/Schema";

export const PushPreferences = Schema.Struct({
  notificationsEnabled: Schema.Boolean,
  notifyOnApproval: Schema.Boolean,
  notifyOnInput: Schema.Boolean,
  notifyOnCompletion: Schema.Boolean,
  notifyOnFailure: Schema.Boolean,
});
export type PushPreferences = typeof PushPreferences.Type;
const deviceFields = {
  appId: Schema.NonEmptyString,
  token: Schema.NonEmptyString,
  preferences: PushPreferences,
};
export const PushRegistration = Schema.Union([
  Schema.Struct({ ...deviceFields, platform: Schema.Literal("android") }),
  Schema.Struct({
    ...deviceFields,
    platform: Schema.Literal("ios"),
    apnsEnvironment: Schema.Literals(["sandbox", "production"]),
  }),
]);
export type PushRegistration = typeof PushRegistration.Type;
export const PushNotification = Schema.Struct({
  eventId: Schema.NonEmptyString,
  threadId: Schema.NonEmptyString,
  userId: Schema.NonEmptyString,
  kind: Schema.Literals(["approval", "input", "completion", "failure"]),
  title: Schema.NonEmptyString,
  body: Schema.String,
  expiresAt: Schema.Number,
});
export type PushNotification = typeof PushNotification.Type;
export const PushAvailability = Schema.Struct({
  available: Schema.Boolean,
  ios: Schema.NullOr(
    Schema.Struct({
      appId: Schema.NonEmptyString,
      environments: Schema.Array(Schema.Literals(["sandbox", "production"])),
    }),
  ),
  android: Schema.NullOr(Schema.Struct({ appId: Schema.NonEmptyString })),
  reason: Schema.NullOr(Schema.String),
});
export type PushAvailability = typeof PushAvailability.Type;
export const decodePushAvailability = Schema.decodeUnknownSync(PushAvailability);

export const decodePushRegistration = Schema.decodeUnknownSync(PushRegistration);
export const decodePushNotification = Schema.decodeUnknownSync(PushNotification);

export const decodePushPreferences = Schema.decodeUnknownSync(PushPreferences);
