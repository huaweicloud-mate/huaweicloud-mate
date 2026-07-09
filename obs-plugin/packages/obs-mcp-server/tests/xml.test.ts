import { describe, expect, it } from "vitest";
import { buildXml, parseXml } from "../src/provider/xml.js";

describe("XML codec", () => {
  it("builds and parses OBS-style XML", () => {
    const xml = buildXml({
      Delete: {
        Object: [
          {
            Key: "a.txt"
          }
        ],
        Quiet: true
      }
    });
    expect(xml).toContain("<Delete>");
    expect(xml).toContain("<Key>a.txt</Key>");
    const parsed = parseXml(xml) as { Delete: { Object: { Key: string }; Quiet: boolean } };
    expect(parsed.Delete.Object.Key).toBe("a.txt");
    expect(parsed.Delete.Quiet).toBe(true);
  });
});
