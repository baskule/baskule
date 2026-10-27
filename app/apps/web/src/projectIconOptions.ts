import { t } from "./i18n";
import { lucideIconNames } from "./lib/lucideIconByName";
export { PROJECT_ICON_COLORS, projectIconColorClassName } from "./projectIconColors";

const POPULAR_PROJECT_ICONS: ReadonlyArray<string> = [
  "folder-code",
  "code-2",
  "terminal",
  "globe-2",
  "server",
  "database",
  "bot",
  "sparkles",
  "smartphone",
  "monitor",
  "cloud-cog",
  "package",
  "book-open",
  "flask-conical",
  "shield-check",
  "rocket",
  "gamepad-2",
  "music",
  "image",
  "shopping-bag",
  "git-branch",
  "workflow",
  "wrench",
  "layers-3",
];

export const PROJECT_EMOJIS: ReadonlyArray<{ readonly emoji: string; readonly label: string }> = [
  {
    emoji: "💻",
    get label() {
      return t("Computer");
    },
  },
  {
    emoji: "🛠️",
    get label() {
      return t("Tools");
    },
  },
  {
    emoji: "🚀",
    get label() {
      return t("Rocket");
    },
  },
  {
    emoji: "🤖",
    get label() {
      return t("Robot");
    },
  },
  {
    emoji: "✨",
    get label() {
      return t("Sparkles");
    },
  },
  {
    emoji: "⚡",
    get label() {
      return t("Lightning");
    },
  },
  {
    emoji: "🌐",
    get label() {
      return t("Web");
    },
  },
  {
    emoji: "📱",
    get label() {
      return t("Mobile");
    },
  },
  {
    emoji: "🖥️",
    get label() {
      return t("Desktop");
    },
  },
  {
    emoji: "⌨️",
    get label() {
      return t("Keyboard");
    },
  },
  {
    emoji: "⚙️",
    get label() {
      return t("Gear");
    },
  },
  {
    emoji: "🗄️",
    get label() {
      return t("Database");
    },
  },
  {
    emoji: "☁️",
    get label() {
      return t("Cloud");
    },
  },
  {
    emoji: "📦",
    get label() {
      return t("Package");
    },
  },
  {
    emoji: "📚",
    get label() {
      return t("Books");
    },
  },
  {
    emoji: "🧪",
    get label() {
      return t("Test tube");
    },
  },
  {
    emoji: "🔒",
    get label() {
      return t("Lock");
    },
  },
  {
    emoji: "🎮",
    get label() {
      return t("Game");
    },
  },
  {
    emoji: "🎵",
    get label() {
      return t("Music");
    },
  },
  {
    emoji: "🎬",
    get label() {
      return t("Movie");
    },
  },
  {
    emoji: "🖼️",
    get label() {
      return t("Picture");
    },
  },
  {
    emoji: "🛍️",
    get label() {
      return t("Shopping");
    },
  },
  {
    emoji: "🔥",
    get label() {
      return t("Fire");
    },
  },
  {
    emoji: "💡",
    get label() {
      return t("Idea");
    },
  },
  {
    emoji: "🧩",
    get label() {
      return t("Puzzle");
    },
  },
  {
    emoji: "📊",
    get label() {
      return t("Chart");
    },
  },
  {
    emoji: "🧠",
    get label() {
      return t("Brain");
    },
  },
  {
    emoji: "🦄",
    get label() {
      return t("Unicorn");
    },
  },
  {
    emoji: "🐙",
    get label() {
      return t("Octopus");
    },
  },
  {
    emoji: "🌱",
    get label() {
      return t("Seedling");
    },
  },
];

export function filterProjectIconNames(query: string): ReadonlyArray<string> {
  const normalized = query.trim().toLowerCase().replaceAll(/\s+/g, "-");
  if (!normalized) return POPULAR_PROJECT_ICONS;
  return lucideIconNames.filter((name) => name.includes(normalized)).slice(0, 60);
}

export function firstEmoji(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  const segments = new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(trimmed);
  const segment = segments[Symbol.iterator]().next().value?.segment;
  const isFlag = /^\p{Regional_Indicator}{2}$/u.test(segment ?? "");
  const isKeycap = /^[#*0-9]\uFE0F?\u20E3$/u.test(segment ?? "");
  if (!segment || (!/\p{Extended_Pictographic}/u.test(segment) && !isFlag && !isKeycap)) {
    return null;
  }
  return segment;
}
