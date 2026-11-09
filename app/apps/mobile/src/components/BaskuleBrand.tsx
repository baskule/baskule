import type { ColorValue } from "react-native";
import { Image } from "expo-image";
import Svg, { Path } from "react-native-svg";
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
      style={{ height, width: (height * 7048.5) / 1511 }}
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
      <Path
        fill="#C9C9C9"
        d="M69.05949 51.43248L85.36247 75.60265L72.72816 84.12460L68.80120 52.14213ZM14.63753 24.39735L27.27184 15.87540L31.19880 47.85787L30.94051 48.56752Z"
      />
      <ThemedPath
        color={props.color}
        colorClassName={props.colorClassName}
        fill="currentColor"
        d="M66.23976 59.17962L69.88484 88.86635L54.75869 90.72361ZM30.11516 11.13365L45.24131 9.27639L33.76024 40.82038Z"
      />
      <Path
        fill="#C79A1E"
        d="M49.92744 6.34230L78.11822 16.60290L50.07256 93.65770L21.88178 83.39710Z"
      />
    </Svg>
  );
}
