import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import nativeLocales from "./locales/config.json";
import type { ExpoConfig } from "expo/config";
import { loadRepoEnv } from "../../scripts/lib/public-config.ts";
type AppVariant = "development" | "preview" | "production";

const repoEnv = loadRepoEnv();
Object.assign(process.env, repoEnv);

const mobileBuildNumber = repoEnv.BASKULE_MOBILE_BUILD_NUMBER ?? "1";
const androidVersionCode = Number(mobileBuildNumber);
if (
  !/^[1-9]\d*$/.test(mobileBuildNumber) ||
  !Number.isSafeInteger(androidVersionCode) ||
  androidVersionCode > 2_100_000_000
) {
  throw new Error(
    "BASKULE_MOBILE_BUILD_NUMBER must be a positive integer no greater than 2100000000.",
  );
}

const APP_VARIANT = resolveAppVariant(repoEnv.APP_VARIANT);
const isIosPersonalTeamBuild = repoEnv.T3CODE_IOS_PERSONAL_TEAM === "1";
const runtimeVersionPolicy =
  process.env.MOBILE_VERSION_POLICY ??
  (APP_VARIANT === "development" ? "appVersion" : "fingerprint");

const personalTeamBundleIdentifier = repoEnv.T3CODE_IOS_PERSONAL_TEAM_BUNDLE_ID?.trim();
const IOS_BUNDLE_IDENTIFIER_PATTERN = /^[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+$/;

const fromRepoRoot = (relativePath: string) => `../../${relativePath}`;
const androidAdaptiveForeground = fromRepoRoot("assets/baskule/android-foreground.png");

if (
  isIosPersonalTeamBuild &&
  (!personalTeamBundleIdentifier ||
    !IOS_BUNDLE_IDENTIFIER_PATTERN.test(personalTeamBundleIdentifier))
) {
  throw new Error(
    "T3CODE_IOS_PERSONAL_TEAM_BUNDLE_ID must be a reverse-DNS identifier such as com.example.t3code when T3CODE_IOS_PERSONAL_TEAM=1.",
  );
}

const DEVELOPMENT_ASSETS = {
  appIcon: fromRepoRoot("assets/baskule/icon-1024.png"),
  iosIcon: fromRepoRoot("assets/baskule/icon-square-1024.png"),
  splashIcon: fromRepoRoot("assets/baskule/splash.png"),
  androidAdaptiveForeground,
  androidAdaptiveBackgroundColor: "#111111",
  androidAdaptiveBackgroundImage: undefined,
  splashIconInverse: fromRepoRoot("assets/baskule/splash-inverse.png"),
  androidMonochromeIcon: fromRepoRoot("assets/baskule/android-monochrome.png"),
  androidNotificationIcon: fromRepoRoot("assets/baskule/android-notification.png"),
  androidNotificationColor: "#B8902A",
} as const;

const PREVIEW_ASSETS = {
  appIcon: fromRepoRoot("assets/baskule/icon-1024.png"),
  iosIcon: fromRepoRoot("assets/baskule/icon-square-1024.png"),
  splashIcon: fromRepoRoot("assets/baskule/splash.png"),
  androidAdaptiveForeground,
  androidAdaptiveBackgroundColor: "#111111",
  androidAdaptiveBackgroundImage: undefined,
  splashIconInverse: fromRepoRoot("assets/baskule/splash-inverse.png"),
  androidMonochromeIcon: fromRepoRoot("assets/baskule/android-monochrome.png"),
  androidNotificationIcon: fromRepoRoot("assets/baskule/android-notification.png"),
  androidNotificationColor: "#B8902A",
} as const;

const RELEASE_ASSETS = {
  appIcon: fromRepoRoot("assets/baskule/icon-1024.png"),
  iosIcon: fromRepoRoot("assets/baskule/icon-square-1024.png"),
  splashIcon: fromRepoRoot("assets/baskule/splash.png"),
  androidAdaptiveForeground,
  androidAdaptiveBackgroundColor: "#111111",
  androidAdaptiveBackgroundImage: undefined,
  splashIconInverse: fromRepoRoot("assets/baskule/splash-inverse.png"),
  androidMonochromeIcon: fromRepoRoot("assets/baskule/android-monochrome.png"),
  androidNotificationIcon: fromRepoRoot("assets/baskule/android-notification.png"),
  androidNotificationColor: "#B8902A",
} as const;

// baskule: rebranded identifiers (Android-first). No Clerk relying party (no T3 cloud sign-in), so
// iOS associated domains are empty. Upstream values: "T3 Code*", "t3code*", "com.t3tools.t3code*",
// relyingParty "clerk.t3.codes".
const VARIANT_CONFIG = {
  development: {
    appName: "Baskule Dev",
    scheme: "baskule-dev",
    iosBundleIdentifier: "dev.baskule.app.dev",
    androidPackage: "dev.baskule.app.dev",
    relyingParty: null,
    assets: DEVELOPMENT_ASSETS,
  },
  preview: {
    appName: "Baskule Preview",
    scheme: "baskule-preview",
    iosBundleIdentifier: "dev.baskule.app.preview",
    androidPackage: "dev.baskule.app.preview",
    relyingParty: null,
    assets: PREVIEW_ASSETS,
  },
  production: {
    appName: "Baskule",
    scheme: "baskule",
    iosBundleIdentifier: "dev.baskule.app",
    androidPackage: "dev.baskule.app",
    relyingParty: null,
    assets: RELEASE_ASSETS,
  },
} as const;

function resolveAppVariant(value: string | undefined): AppVariant {
  switch (value) {
    case "development":
    case "preview":
    case "production":
      return value;
    default:
      return "production";
  }
}

const variant = VARIANT_CONFIG[APP_VARIANT];
const iosBundleIdentifier = isIosPersonalTeamBuild
  ? personalTeamBundleIdentifier!
  : variant.iosBundleIdentifier;

const dmSansFonts = {
  regular: "@expo-google-fonts/dm-sans/400Regular/DMSans_400Regular.ttf",
  medium: "@expo-google-fonts/dm-sans/500Medium/DMSans_500Medium.ttf",
  bold: "@expo-google-fonts/dm-sans/700Bold/DMSans_700Bold.ttf",
} as const;

const widgetsPlugin: NonNullable<ExpoConfig["plugins"]>[number] = [
  "expo-widgets",
  {
    bundleIdentifier: `${iosBundleIdentifier}.widgets`,
    groupIdentifier: `group.${iosBundleIdentifier}`,
    enablePushNotifications: true,
    // Frequent updates need the iOS entitlement to avoid early throttling.
    frequentUpdates: true,
    enableAndroid: true,
    widgets: [
      {
        name: "AgentActivity",
        displayName: "Agent Activity",
        description: "Shows the current state of active Baskule agents.",
        android: null,
        ios: { supportedFamilies: ["systemSmall", "systemMedium", "accessoryRectangular"] },
      },
    ],
  },
];

const sharingPlugin: NonNullable<ExpoConfig["plugins"]>[number] = [
  "expo-sharing",
  {
    ios: {
      // Personal Teams cannot sign App Groups or extension targets; keep local builds usable.
      enabled: !isIosPersonalTeamBuild,
      extensionBundleIdentifier: `${iosBundleIdentifier}.sharing`,
      appGroupId: `group.${iosBundleIdentifier}`,
      activationRule: {
        supportsText: true,
        supportsWebUrlWithMaxCount: 1,
        supportsImageWithMaxCount: 8,
        supportsMovieWithMaxCount: 8,
        supportsFileWithMaxCount: 8,
      },
    },
    android: {
      enabled: true,
      singleShareMimeTypes: ["*/*"],
      multipleShareMimeTypes: ["*/*"],
    },
  },
];

// Match iOS PostScript names on Android so RN and the native composer share fonts before runtime loading.

const config: ExpoConfig = {
  locales: nativeLocales,
  name: variant.appName,
  slug: "baskule", // baskule: was "t3-code"
  platforms: ["ios", "android"],
  scheme: variant.scheme,
  version:
    repoEnv.T3CODE_MOBILE_VERSION ??
    NodeFS.readFileSync(NodePath.resolve(__dirname, "../../../VERSION"), "utf8").trim(),
  runtimeVersion: {
    // Skip costly fingerprinting on dev launches; preview and production OTAs require matching native projects.
    policy: runtimeVersionPolicy,
  },
  orientation: "portrait",
  icon: variant.assets.appIcon,
  userInterfaceStyle: "automatic",
  // baskule: no OTA updates from T3's EAS project; opt in with an own EXPO_UPDATES_URL.
  updates: {
    enabled: Boolean(repoEnv.EXPO_UPDATES_URL) && repoEnv.T3CODE_MOBILE_UPDATES_ENABLED !== "0",
    ...(repoEnv.EXPO_UPDATES_URL ? { url: repoEnv.EXPO_UPDATES_URL } : {}),
    checkAutomatically: "ON_LOAD",
    fallbackToCacheTimeout: 0,
  },
  ios: {
    buildNumber: mobileBuildNumber,
    icon: variant.assets.iosIcon,
    supportsTablet: true,
    requireFullScreen: process.env.T3_SHOWCASE_CAPTURE_BUILD === "1",
    bundleIdentifier: iosBundleIdentifier,
    // Avoid Personal Team fallback: it cannot sign App Groups, Apple sign-in or push entitlements.
    // baskule: T3's team id only applies to T3's signing; set APPLE_TEAM_ID for an own team.
    ...(repoEnv.APPLE_TEAM_ID ? { appleTeamId: repoEnv.APPLE_TEAM_ID } : {}),
    associatedDomains: variant.relyingParty
      ? [`applinks:${variant.relyingParty}`, `webcredentials:${variant.relyingParty}`]
      : [],
    entitlements: {
      "keychain-access-groups": [`$(AppIdentifierPrefix)${variant.iosBundleIdentifier}`],
    },
    infoPlist: {
      CFBundleAllowMixedLocalizations: true,
      UISupportedInterfaceOrientations: [
        "UIInterfaceOrientationPortrait",
        "UIInterfaceOrientationLandscapeLeft",
        "UIInterfaceOrientationLandscapeRight",
      ],
      NSAppTransportSecurity: {
        NSAllowsArbitraryLoads: true,
      },
      NSLocalNetworkUsageDescription:
        "Allow Baskule to connect to Baskule servers on your local network or tailnet.",
      NSPhotoLibraryAddUsageDescription: "Allow Baskule to save images to your photo library.",
      // System picture in picture needs background audio to start and survive outside the app.
      UIBackgroundModes: ["audio"],
      ITSAppUsesNonExemptEncryption: false,
      // Capture builds disable multitasking because iPadOS otherwise ignores orientation requests.
      ...(process.env.T3_SHOWCASE_CAPTURE_BUILD === "1"
        ? {
            "UISupportedInterfaceOrientations~ipad": [
              "UIInterfaceOrientationPortrait",
              "UIInterfaceOrientationPortraitUpsideDown",
              "UIInterfaceOrientationLandscapeLeft",
              "UIInterfaceOrientationLandscapeRight",
            ],
          }
        : {}),
    },
  },
  android: {
    versionCode: androidVersionCode,
    icon: variant.assets.appIcon,
    package: variant.androidPackage,
    ...(repoEnv.T3CODE_ANDROID_GOOGLE_SERVICES_FILE
      ? { googleServicesFile: repoEnv.T3CODE_ANDROID_GOOGLE_SERVICES_FILE }
      : {}),
    adaptiveIcon: {
      backgroundColor: variant.assets.androidAdaptiveBackgroundColor,
      ...(variant.assets.androidAdaptiveBackgroundImage
        ? { backgroundImage: variant.assets.androidAdaptiveBackgroundImage }
        : {}),
      foregroundImage: variant.assets.androidAdaptiveForeground,
      monochromeImage: variant.assets.androidMonochromeIcon,
    },
    // JS back dispatch needs RN's Android 16 shim and withAndroidPredictiveBackCompat on Android 13-15.
    predictiveBackGestureEnabled: true,
    // expo-sensors declares this for its pedometer, which the app does not use.
    blockedPermissions: ["android.permission.ACTIVITY_RECOGNITION"],
  },
  web: {
    favicon: variant.assets.appIcon,
  },
  plugins: [
    ["expo-localization", { supportedLocales: Object.keys(nativeLocales) }],
    "expo-asset",
    "react-native-pdf-jsi",
    [
      "expo-font",
      {
        ios: {
          fonts: [dmSansFonts.regular, dmSansFonts.medium, dmSansFonts.bold],
        },
        android: {
          fonts: [
            {
              fontFamily: "DMSans-Regular",
              fontDefinitions: [{ path: dmSansFonts.regular, weight: 400 }],
            },
            {
              fontFamily: "DMSans-Medium",
              fontDefinitions: [{ path: dmSansFonts.medium, weight: 500 }],
            },
            {
              fontFamily: "DMSans-Bold",
              fontDefinitions: [{ path: dmSansFonts.bold, weight: 700 }],
            },
          ],
        },
      },
    ],
    "expo-secure-store",
    "expo-sqlite",
    ...(isIosPersonalTeamBuild
      ? [sharingPlugin]
      : ["./plugins/withShareExtensionDisplayName.cjs", sharingPlugin]),
    [
      "expo-notifications",
      {
        icon: variant.assets.androidNotificationIcon,
        color: variant.assets.androidNotificationColor,
        mode: APP_VARIANT === "development" ? "development" : "production",
      },
    ],
    // Gate Clerk here: withoutIosPersonalTeamCapabilities runs too early to strip its entitlement.
    ["@clerk/expo", { theme: "./clerk-theme.json", appleSignIn: !isIosPersonalTeamBuild }],
    "expo-web-browser",
    [
      "expo-quick-actions",
      {
        androidIcons: {
          shortcut_icon: {
            foregroundImage: variant.assets.androidAdaptiveForeground,
            backgroundColor: variant.assets.androidAdaptiveBackgroundColor,
            ...(variant.assets.androidAdaptiveBackgroundImage
              ? { backgroundImage: variant.assets.androidAdaptiveBackgroundImage }
              : {}),
          },
        },
      },
    ],
    [
      "expo-audio",
      {
        microphonePermission: "Allow Baskule to use your microphone for voice input.",
        recordAudioAndroid: false,
        enableBackgroundPlayback: false,
        enableBackgroundRecording: false,
      },
    ],
    [
      "expo-camera",
      {
        cameraPermission:
          "Allow Baskule to access your camera so you can scan connection QR codes.",
        microphonePermission: false,
        barcodeScannerEnabled: true,
        recordAudioAndroid: false,
      },
    ],
    ["expo-image-picker", { photosPermission: false, microphonePermission: false }],
    [
      "expo-splash-screen",
      {
        image: variant.assets.splashIcon,
        resizeMode: "contain",
        backgroundColor: "#ffffff",
        imageWidth: 288,
        dark: {
          image: variant.assets.splashIconInverse,
          backgroundColor: "#0a0a0a",
        },
        android: {
          // Android 12+ masks the central two thirds of the 288dp canvas; the transparent mark stays inside it.
          image: variant.assets.splashIcon,
          imageWidth: 288,
          dark: { image: variant.assets.splashIconInverse },
        },
      },
    ],
    [
      "expo-build-properties",
      {
        buildReactNativeFromSource: true,
        android: {
          minSdkVersion: 24,
          // SDK 58 lacks Kotlin 2.3's runtime-inert annotation. R8 needs explicit InputMerger constructors for widgets.
          extraProguardRules: [
            "-dontwarn kotlin.MustUseReturnValues",
            "-keep class * extends androidx.work.InputMerger { <init>(); }",
          ].join("\n"),
        },
        ios: {
          deploymentTarget: "18.0",
          // AppCheckCore 11.3+ includes Swift and needs module maps for these Objective-C dependencies.
          extraPods: [
            { name: "GoogleUtilities", modular_headers: true },
            { name: "RecaptchaInterop", modular_headers: true },
          ],
        },
      },
    ],
    "./plugins/withIosCocoaPodsUuidCache.cjs",
    // Compile out the unused pedometer to avoid an iOS motion purpose string.
    ["expo-sensors", { motionPermission: false }],
    // Mods run in reverse order; expo-widgets must create and wipe the target before assets are added.
    ...(!isIosPersonalTeamBuild ? ["./plugins/withWidgetLogoAsset.cjs", widgetsPlugin] : []),
    "./plugins/withAndroidNetworkSecurityConfig.cjs",
    "./plugins/withAndroidGradleHeap.cjs",
    "./plugins/withAndroidInputBackground.cjs",
    "./plugins/withAndroidModernPopupMenu.cjs",
    "./plugins/withAndroidModernAlertDialog.cjs",
    "./plugins/withAndroidPredictiveBackCompat.cjs",
    "./plugins/withAndroidTabletOrientation.cjs",
    ...(isIosPersonalTeamBuild ? ["./plugins/withoutIosPersonalTeamCapabilities.cjs"] : []),
  ],
  extra: {
    appVariant: APP_VARIANT,
    iosPersonalTeamBuild: isIosPersonalTeamBuild,
    // baskule: no T3 Connect relay and no Clerk cloud sign-in (scope: no auth, no accounts).
    relay: {
      url: null,
    },
    clerk: {
      publishableKey: null,
      jwtTemplate: null,
    },
    // Clerk reads these exact names at prebuild. Omit unset values: manifest null becomes truthy {}.
    EXPO_PUBLIC_CLERK_GOOGLE_WEB_CLIENT_ID: repoEnv.EXPO_PUBLIC_CLERK_GOOGLE_WEB_CLIENT_ID,
    EXPO_PUBLIC_CLERK_GOOGLE_IOS_CLIENT_ID: repoEnv.EXPO_PUBLIC_CLERK_GOOGLE_IOS_CLIENT_ID,
    EXPO_PUBLIC_CLERK_GOOGLE_ANDROID_CLIENT_ID: repoEnv.EXPO_PUBLIC_CLERK_GOOGLE_ANDROID_CLIENT_ID,
    EXPO_PUBLIC_CLERK_GOOGLE_IOS_URL_SCHEME: repoEnv.EXPO_PUBLIC_CLERK_GOOGLE_IOS_URL_SCHEME,
    // baskule: T3's EAS project id and owner removed; `eas init` writes your own if you use EAS.
    ...(repoEnv.EAS_PROJECT_ID ? { eas: { projectId: repoEnv.EAS_PROJECT_ID } } : {}),
  },
  ...(repoEnv.EAS_OWNER ? { owner: repoEnv.EAS_OWNER } : {}),
  experiments: {
    // Metro only runs babel-plugin-react-compiler when this is set; see src/reactCompilerCoverage.test.ts.
    reactCompiler: true,
  },
};

export default config;
