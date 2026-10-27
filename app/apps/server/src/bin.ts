/**
 * Guards outbound sockets before the full CLI module graph (seconds of evaluation) loads, then
 * defers to the real CLI in ./binCli.ts.
 */
import { isEntrypoint } from "./entrypoint.ts";

if (
  isEntrypoint({
    moduleUrl: import.meta.url,
    entryPath: process.argv[1],
    runtimeMain: import.meta.main,
  })
) {
  // Guard sockets before the CLI can load outbound-capable modules.
  const { ignoreMacosTypeOfServiceEinval } = await import("./outboundHttp.ts");
  ignoreMacosTypeOfServiceEinval();
  // Before anything reads stdin: the desktop app's Windows launcher starts
  // the CLI without one.
  const { attachConsoleStdin } = await import("./cli/consoleStdin.ts");
  attachConsoleStdin();
  const { runCli } = await import("./binCli.ts");
  runCli();
}
