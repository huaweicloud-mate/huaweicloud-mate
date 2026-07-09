import { XMLBuilder, XMLParser } from "fast-xml-parser";

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
  textNodeName: "#text"
});

const builder = new XMLBuilder({
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
  format: false
});

export function parseXml(xml: string): unknown {
  if (!xml.trim()) {
    return {};
  }
  return parser.parse(xml);
}

export function buildXml(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  return builder.build(value as object);
}
