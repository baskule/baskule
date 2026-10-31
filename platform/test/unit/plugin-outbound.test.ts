import { describe, expect, it } from "vitest";
import { checkOutbound } from "../../src/shared/plugin-outbound";

describe("plugin outbound addresses", () => {
  it.each(["0.1.2.3", "10.2.3.4", "100.64.0.1", "127.0.0.1", "169.254.169.254", "172.31.0.1", "192.0.0.1", "192.168.0.1", "198.18.0.1", "224.0.0.1", "255.255.255.255", "2130706433", "0x7f000001", "0177.0.0.1", "[::]", "[::1]", "[::ffff:127.0.0.1]", "[fc00::1]", "[fe80::1]", "[ff02::1]", "localhost", "localhost.", "host", "service.internal", "app.localhost"])("restricts private address %s to admin private traffic", host => {
    expect(() => checkOutbound(`https://${host}/mcp`, "public")).toThrow();
    expect(checkOutbound(`http://${host}/mcp`, "private").protocol).toBe("http:");
  });
  it.each(["https://baskule-mcp.internal/mcp", "http://baskule-mcp.internal./mcp", "https://user:pass@vendor.test/mcp", "https://vendor.test/mcp#fragment", "file:///tmp/mcp", "https://{tenant}.example.com/mcp"])("always refuses %s", url => {
    for (const network of ["public", "private"] as const) expect(() => checkOutbound(url, network)).toThrow();
  });
  it("allows public HTTPS, including global v6 and mapped v4, and refuses public HTTP", () => {
    for (const host of ["vendor.test", "8.8.8.8", "[2606:4700:4700::1111]", "[::ffff:8.8.8.8]"]) {
      expect(checkOutbound(`https://${host}/mcp`, "public").protocol).toBe("https:");
      expect(() => checkOutbound(`http://${host}/mcp`, "private")).toThrow();
    }
  });
});
