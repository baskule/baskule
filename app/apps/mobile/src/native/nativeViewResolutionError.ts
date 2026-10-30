import { t } from "../i18n";

import * as Schema from "effect/Schema";

export class NativeViewResolutionError extends Schema.TaggedError<NativeViewResolutionError>()(
  "NativeViewResolutionError",
  {
    nativeModuleName: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return t("Failed to resolve native view {{nativeModuleName}}.", {
      nativeModuleName: this.nativeModuleName,
    });
  }
}
