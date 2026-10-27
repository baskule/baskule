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
  throw new Error("BASKULE_MOBILE_BUILD_NUMBER must be a positive integer no greater than 2100000000.");
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
  iosIcon: fromRepoRoot("assets/baskule/icon-1024.png"),
  splashIcon: fromRepoRoot("assets/baskule/icon-1024.png"),
  androidAdaptiveForeground,
  androidAdaptiveBackgroundColor: "#17181A",
  androidAdaptiveBackgroundImage: undefined,
  androidSplashIcon: fromRepoRoot("assets/baskule/android-splash.png"),
  androidMonochromeIcon: fromRepoRoot("assets/baskule/android-monochrome.png"),
  androidNotificationIcon: fromRepoRoot("assets/baskule/android-notification.png"),
  androidNotificationColor: "#D90429",
} as const;

const PREVIEW_ASSETS = {
  appIcon: fromRepoRoot("assets/baskule/icon-1024.png"),
  iosIcon: fromRepoRoot("assets/baskule/icon-1024.png"),
  splashIcon: fromRepoRoot("assets/baskule/icon-1024.png"),
  androidAdaptiveForeground,
  androidAdaptiveBackgroundColor: "#17181A",
  androidAdaptiveBackgroundImage: undefined,
  androidSplashIcon: fromRepoRoot("assets/baskule/android-splash.png"),
  androidMonochromeIcon: fromRepoRoot("assets/baskule/android-monochrome.png"),
  androidNotificationIcon: fromRepoRoot("assets/baskule/android-notification.png"),
  androidNotificationColor: "#D90429",
} as const;

const RELEASE_ASSETS = {
  appIcon: fromRepoRoot("assets/baskule/icon-1024.png"),
  iosIcon: fromRepoRoot("assets/baskule/icon-1024.png"),
  splashIcon: fromRepoRoot("assets/baskule/icon-1024.png"),
  androidAdaptiveForeground,
  androidAdaptiveBackgroundColor: "#17181A",
  androidAdaptiveBackgroundImage: undefined,
  androidSplashIcon: fromRepoRoot("assets/baskule/android-splash.png"),
  androidMonochromeIcon: fromRepoRoot("assets/baskule/android-monochrome.png"),
  androidNotificationIcon: fromRepoRoot("assets/baskule/android-notification.png"),
  androidNotificationColor: "#D90429",
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
    // Agent activity can update many times an hour; without the
    // frequent-updates entitlement iOS throttles the update budget sooner.
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
      // Personal Teams cannot sign App Groups or extension targets. Keep the
      // reduced-capability local build usable while release builds expose the
      // real system share target.
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

// These aliases match the fonts' PostScript names on iOS. Register the same
// names on Android so React Native and the native composer use one set of
// family names without waiting for runtime font loading.

const config: ExpoConfig = {
  locales: nativeLocales,
  name: variant.appName,
  slug: "baskule", // baskule: was "t3-code"
  platforms: ["ios", "android"],
  scheme: variant.scheme,
  version: repoEnv.T3CODE_MOBILE_VERSION ?? "0.0.0",
  runtimeVersion: {
    // Development manifests resolve on every launch, so avoid fingerprint's
    // expensive native-project calculation there. Preview and production stay
    // fingerprinted so OTAs only reach binaries with matching native projects.
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
    // Pin code signing to the T3 Tools team so non-interactive `expo run:ios`
    // does not fall back to a personal team (which cannot sign app groups,
    // Sign in with Apple, or push notification entitlements).
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
      // "Audio, AirPlay, and Picture in Picture": the browser screen's system
      // picture in picture needs it to start and to stay up outside the app.
      UIBackgroundModes: ["audio"],
      ITSAppUsesNonExemptEncryption: false,
      // The App Store screenshot harness rotates the iPad interface from
      // inside the app (CI denies osascript the Accessibility access that
      // Simulator menu scripting needs), and iPadOS ignores programmatic
      // orientation requests for multitasking-capable apps — so the capture
      // build opts out of multitasking and declares landscape support.
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
    // Opts into OnBackInvokedCallback-based back dispatch (Android 13+).
    // JS back handling survives it via react-native's Android 16 shim plus
    // withAndroidPredictiveBackCompat on Android 13-15.
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
    // appleSignIn must be gated here: withoutIosPersonalTeamCapabilities.cjs runs before
    // plugins earlier in this array, so it cannot strip the entitlement Clerk would add.
    ["@clerk/expo", { theme: "./clerk-theme.json", appleSignIn: !isIosPersonalTeamBuild }],
    "expo-web-browser",
    [
      "expo-quick-actions",
      {
        // Adaptive launcher-shortcut icon; referenced by resource name from
        // the shortcut items set in src/features/shortcuts.
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
        imageWidth: 220,
        dark: {
          image: variant.assets.splashIcon,
          backgroundColor: "#0a0a0a",
        },
        android: {
          // Android 12+ masks the splash icon to a circle over the central two thirds of
          // its 288dp canvas, so the iOS export's corners get cut. A full-canvas image of
          // the composed adaptive layers puts the wordmark in the same frame the launcher
          // icon uses.
          image: variant.assets.androidSplashIcon,
          imageWidth: 288,
          dark: { image: variant.assets.androidSplashIcon },
        },
      },
    ],
    [
      "expo-build-properties",
      {
        buildReactNativeFromSource: true,
        android: {
          minSdkVersion: 24,
          // kotlinx-io uses Kotlin 2.3's return-value checker annotation, while
          // SDK 58 builds with Kotlin 2.2. It has no runtime behavior.
          // WorkManager 2.9 keeps InputMerger classes but not their constructors,
          // and R8 full mode no longer keeps a default constructor implicitly.
          // Without it no work request can start, so the Glance session behind
          // the widget never renders and it stays on "Loading widget".
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
    // Only the accelerometer is used (device viewer shake). Compile out the
    // pedometer so iOS needs no motion purpose string.
    ["expo-sensors", { motionPermission: false }],
    // Must be listed BEFORE expo-widgets: same-type mods run last-registered-
    // first, so registering earlier makes this plugin's mods run AFTER
    // expo-widgets' — its dangerous mod wipes ios/ExpoWidgetsTarget/ (which
    // would delete the asset catalog) and its xcodeproj mod creates the widget
    // target (which must exist before the compile phase can be attached).
    ...(!isIosPersonalTeamBuild ? ["./plugins/withWidgetLogoAsset.cjs", widgetsPlugin] : []),
    "./plugins/withAndroidCleartextTraffic.cjs",
    "./plugins/withAndroidGradleHeap.cjs",
    "./plugins/withAndroidFbjniVersion.cjs",
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
    // @clerk/expo reads these from `extra`
    // under their exact env-var names (not nested), and its config plugin reads
    // the iOS URL scheme at prebuild to register it in Info.plist.
    // Unset values must be omitted (not null): the public manifest serializes
    // null to {}, which is truthy and would defeat Clerk's fallback checks.
    EXPO_PUBLIC_CLERK_GOOGLE_WEB_CLIENT_ID: repoEnv.EXPO_PUBLIC_CLERK_GOOGLE_WEB_CLIENT_ID,
    EXPO_PUBLIC_CLERK_GOOGLE_IOS_CLIENT_ID: repoEnv.EXPO_PUBLIC_CLERK_GOOGLE_IOS_CLIENT_ID,
    EXPO_PUBLIC_CLERK_GOOGLE_ANDROID_CLIENT_ID: repoEnv.EXPO_PUBLIC_CLERK_GOOGLE_ANDROID_CLIENT_ID,
    EXPO_PUBLIC_CLERK_GOOGLE_IOS_URL_SCHEME: repoEnv.EXPO_PUBLIC_CLERK_GOOGLE_IOS_URL_SCHEME,
    observability: {
      tracesUrl: repoEnv.EXPO_PUBLIC_OTLP_TRACES_URL ?? "https://api.axiom.co/v1/traces",
      tracesDataset: repoEnv.EXPO_PUBLIC_OTLP_TRACES_DATASET ?? null,
      tracesToken: repoEnv.EXPO_PUBLIC_OTLP_TRACES_TOKEN ?? null,
    },
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
