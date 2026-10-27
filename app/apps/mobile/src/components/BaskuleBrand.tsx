import type { ColorValue } from "react-native";
import { Image } from "expo-image";
import Svg, { G, Path } from "react-native-svg";
import { withUniwind } from "uniwind";
import { useAppearancePreferences } from "../features/settings/appearance/AppearancePreferencesProvider";

const ThemedPath = withUniwind(Path);

export function BaskuleWordmark({ height = 24 }: { readonly height?: number }) {
  const { themeAppearance } = useAppearancePreferences();
  return (
    <Image
      source={
        themeAppearance === "dark"
          ? require("../../../../assets/baskule/wordmark-inverse.png")
          : require("../../../../assets/baskule/wordmark.png")
      }
      accessibilityLabel="Baskule"
      accessibilityIgnoresInvertColors
      contentFit="contain"
      style={{ height, width: (height * 7315.76) / 1519.8 }}
    />
  );
}

export function BaskuleMark(props: {
  readonly height: number;
  readonly color?: ColorValue;
  readonly colorClassName?: string;
}) {
  return (
    <Svg
      accessibilityLabel="Baskule"
      height={props.height}
      width={props.height}
      viewBox="0 0 100 100"
    >
      <G transform="translate(11.065 0)">
        <ThemedPath
          color={props.color}
          colorClassName={props.colorClassName}
          fill="currentColor"
          d="M23.87 0H0V64.51L23.87 26ZM0 100H23.87V58.22L0 80.9Z"
        />
        <Path
          fill="#D90429"
          d="M0 74L45.87 0H77.87ZM41.55 41.41L28.87 53.47V72.57L45.87 100H77.87Z"
        />
      </G>
    </Svg>
  );
}
