// baskule: Settings → Change password (hosted build).
import { createFileRoute } from "@tanstack/react-router";

import { ChangePasswordView } from "../baskule/ChangePasswordView";

export const Route = createFileRoute("/_chat/settings/password")({ component: ChangePasswordView });
