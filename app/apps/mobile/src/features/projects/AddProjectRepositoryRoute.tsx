import type { StaticScreenProps } from "@react-navigation/native";
import { NativeStackScreenOptions } from "../../native/StackHeader";

import { AddProjectRepositoryScreen } from "./AddProjectScreen";

type AddProjectRepositoryRouteParams = {
  readonly environmentId?: string | string[];
};

export function AddProjectRepositoryRoute({
  route,
}: StaticScreenProps<AddProjectRepositoryRouteParams>) {
  const params = route.params ?? {};
  const title = "Git URL";

  return (
    <>
      <NativeStackScreenOptions options={{ title }} />
      <AddProjectRepositoryScreen {...params} />
    </>
  );
}
