import { t } from "./i18n";
export const CODE_BLOCK_LANGUAGES = [
  {
    id: "",
    get label() {
      return t("Plain text");
    },
  },
  {
    id: "bash",
    get label() {
      return t("Bash");
    },
  },
  { id: "c", label: "C" },
  { id: "cpp", label: "C++" },
  { id: "csharp", label: "C#" },
  {
    id: "css",
    get label() {
      return t("CSS");
    },
  },
  {
    id: "dart",
    get label() {
      return t("Dart");
    },
  },
  {
    id: "diff",
    get label() {
      return t("Diff");
    },
  },
  {
    id: "dockerfile",
    get label() {
      return t("Dockerfile");
    },
  },
  {
    id: "elixir",
    get label() {
      return t("Elixir");
    },
  },
  {
    id: "go",
    get label() {
      return t("Go");
    },
  },
  {
    id: "graphql",
    get label() {
      return t("GraphQL");
    },
  },
  {
    id: "haskell",
    get label() {
      return t("Haskell");
    },
  },
  {
    id: "html",
    get label() {
      return t("HTML");
    },
  },
  {
    id: "java",
    get label() {
      return t("Java");
    },
  },
  {
    id: "javascript",
    get label() {
      return t("JavaScript");
    },
  },
  {
    id: "json",
    get label() {
      return t("JSON");
    },
  },
  {
    id: "jsx",
    get label() {
      return t("JSX");
    },
  },
  {
    id: "kotlin",
    get label() {
      return t("Kotlin");
    },
  },
  {
    id: "lua",
    get label() {
      return t("Lua");
    },
  },
  {
    id: "markdown",
    get label() {
      return t("Markdown");
    },
  },
  {
    id: "php",
    get label() {
      return t("PHP");
    },
  },
  {
    id: "powershell",
    get label() {
      return t("PowerShell");
    },
  },
  {
    id: "python",
    get label() {
      return t("Python");
    },
  },
  { id: "r", label: "R" },
  {
    id: "ruby",
    get label() {
      return t("Ruby");
    },
  },
  {
    id: "rust",
    get label() {
      return t("Rust");
    },
  },
  {
    id: "scala",
    get label() {
      return t("Scala");
    },
  },
  {
    id: "scss",
    get label() {
      return t("SCSS");
    },
  },
  {
    id: "sql",
    get label() {
      return t("SQL");
    },
  },
  {
    id: "svelte",
    get label() {
      return t("Svelte");
    },
  },
  {
    id: "swift",
    get label() {
      return t("Swift");
    },
  },
  {
    id: "toml",
    get label() {
      return t("TOML");
    },
  },
  {
    id: "tsx",
    get label() {
      return t("TSX");
    },
  },
  {
    id: "typescript",
    get label() {
      return t("TypeScript");
    },
  },
  {
    id: "vue",
    get label() {
      return t("Vue");
    },
  },
  {
    id: "xml",
    get label() {
      return t("XML");
    },
  },
  {
    id: "yaml",
    get label() {
      return t("YAML");
    },
  },
  {
    id: "zig",
    get label() {
      return t("Zig");
    },
  },
] as const;

export type CodeBlockLanguage = { readonly id: string; readonly label: string };

const LANGUAGE_ALIASES: Record<string, string> = {
  cs: "csharp",
  "c++": "cpp",
  js: "javascript",
  md: "markdown",
  py: "python",
  rb: "ruby",
  rs: "rust",
  sh: "bash",
  shell: "bash",
  ts: "typescript",
  yml: "yaml",
};

export function languageOfInfoString(info: string): string {
  return info.trim().split(/\s+/, 1)[0] ?? "";
}

/** Plain text clears the language unless trailing metadata would be parsed as one. */
export function withInfoStringLanguage(info: string, language: string): string {
  const leading = /^\s*/.exec(info)![0];
  const rest = info.slice(leading.length + languageOfInfoString(info).length);
  if (language) return `${leading}${language}${rest}`;
  return rest.trim() ? `${leading}text${rest}` : "";
}

export function codeLanguageEntry(language: string): CodeBlockLanguage | null {
  const id = language === "text" ? "" : (LANGUAGE_ALIASES[language.toLowerCase()] ?? language);
  return CODE_BLOCK_LANGUAGES.find((entry) => entry.id === id.toLowerCase()) ?? null;
}

export function codeLanguageLabel(language: string): string {
  return codeLanguageEntry(language)?.label ?? language;
}
