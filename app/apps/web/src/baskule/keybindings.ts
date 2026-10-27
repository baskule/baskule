// baskule: keyboard shortcuts allowed in the Baskule UI (review M1). Every other command (terminal,
// diff, preview, command palette, model picker, pin/settle, editors, …) would reach a hidden or
// out-of-scope feature, so its binding is ignored. Applied where the web resolves a key event.
import { THREAD_JUMP_KEYBINDING_COMMANDS, type KeybindingCommand } from "@t3tools/contracts";

import { BASKULE_UI } from "./flags";

const ALLOWED_COMMANDS: ReadonlySet<string> = new Set([
  "sidebar.toggle",
  "navigation.back",
  "navigation.forward",
  "rightPanel.toggle",
  "rightPanel.close",
  "threadPanel.toggle",
  "chat.new",
  "chat.find",
  "thread.stop",
  "thread.previous",
  "thread.next",
  "thread.steerQueuedMessage",
  "thread.editQueuedMessage",
  "composer.sendAlternate",
  "composer.stash",
  ...THREAD_JUMP_KEYBINDING_COMMANDS,
]);

export function isKeybindingCommandEnabled(command: KeybindingCommand): boolean {
  return !BASKULE_UI || ALLOWED_COMMANDS.has(command);
}
