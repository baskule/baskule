import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import { afterAll, beforeAll, expect, it } from "vite-plus/test";

const androidPath =
  "ReactAndroid/src/main/java/com/facebook/react/modules/websocket/WebSocketModule.kt";
const iosPath = "React/CoreModules/RCTWebSocketModule.mm";
const patchUrl = new URL("../../../patches/react-native@0.88.0.patch", import.meta.url);
let directory: string;
let ios: string;

beforeAll(() => {
  directory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-websocket-cookie-"));
  for (const path of [
    androidPath,
    iosPath,
    "ReactAndroid/src/main/java/com/facebook/react/modules/fresco/ReactNetworkImageRequest.kt",
    "Libraries/Image/RCTImageLoader.mm",
  ]) {
    const destination = NodePath.join(directory, path);
    NodeFS.mkdirSync(NodePath.dirname(destination), { recursive: true });
    NodeFS.copyFileSync(
      new URL(`../node_modules/react-native/${path}`, import.meta.url),
      destination,
    );
  }
  const patch = NodeURL.fileURLToPath(patchUrl);
  const options = { cwd: directory, timeout: 10_000, encoding: "utf8" } as const;
  const check = NodeChildProcess.spawnSync("git", ["apply", "--check", patch], options);
  if (check.status !== 0)
    NodeChildProcess.execFileSync("git", ["apply", "--reverse", patch], options);
  NodeChildProcess.execFileSync("git", ["apply", patch], options);
  ios = NodeFS.readFileSync(NodePath.join(directory, iosPath), "utf8");
});
afterAll(() => {
  if (directory) NodeFS.rmSync(directory, { recursive: true, force: true });
});

it("applies the native request patch to the pinned React Native sources", () => {
  expect(() =>
    NodeChildProcess.execFileSync(
      "git",
      ["apply", "--check", "--reverse", NodeURL.fileURLToPath(patchUrl)],
      { cwd: directory, timeout: 10_000 },
    ),
  ).not.toThrow();
});

// oxlint-disable-next-line t3code/no-global-process-runtime -- Foundation checks require the host's macOS compiler.
it.skipIf(NodeOS.platform() !== "darwin")(
  "executes the patched iOS header branch against Foundation",
  () => {
    const start = ios.indexOf('      if ([headerKey caseInsensitiveCompare:@"Cookie"]');
    const branch = ios.slice(start, ios.indexOf("\n    }];", start));
    const source = NodePath.join(directory, "CookieRequest.mm");
    NodeFS.writeFileSync(
      source,
      `#import <Foundation/Foundation.h>
int main() { @autoreleasepool {
  for (NSString *headerKey in @[@"Cookie", @"cOoKiE"]) {
    for (NSString *headerValue in @[@"", @"chosen=one"]) {
      NSMutableURLRequest *request = [NSMutableURLRequest requestWithURL:[NSURL URLWithString:@"https://front.test/s/space/api/preview-stream/ws"]];
      [request setValue:@"ambient=secret" forHTTPHeaderField:@"Cookie"];
${branch}
      NSString *cookie = [request valueForHTTPHeaderField:@"Cookie"];
      if ((headerValue.length == 0 && cookie.length != 0) || (headerValue.length > 0 && ![cookie isEqualToString:headerValue]) || request.HTTPShouldHandleCookies) return 1;
    }
  }
} return 0; }
`,
    );
    const executable = NodePath.join(directory, "cookie-request");
    NodeChildProcess.execFileSync(
      "clang++",
      ["-fobjc-arc", "-framework", "Foundation", source, "-o", executable],
      { timeout: 30_000 },
    );
    NodeChildProcess.execFileSync(executable, [], { timeout: 10_000 });
  },
);
