export interface EndpointInput {
  region: string;
  endpoint?: string;
  bucket?: string;
  key?: string;
  query?: Record<string, unknown>;
}

export function resolveEndpoint(input: EndpointInput): URL {
  const base = normalizeEndpoint(input.endpoint ?? `https://obs.${input.region}.myhuaweicloud.com`);
  const url = new URL(base);
  const segments: string[] = [];

  if (input.bucket) {
    segments.push(input.bucket);
  }
  if (input.key) {
    segments.push(...input.key.split("/").map(encodeURIComponent));
  }

  url.pathname = `/${segments.join("/")}`;

  for (const [key, value] of Object.entries(input.query ?? {})) {
    if (value === undefined || value === null || value === false) {
      continue;
    }
    if (value === true) {
      url.searchParams.set(key, "");
      continue;
    }
    url.searchParams.set(key, String(value));
  }

  return url;
}

function normalizeEndpoint(endpoint: string): string {
  if (/^https?:\/\//i.test(endpoint)) {
    return endpoint.endsWith("/") ? endpoint : `${endpoint}/`;
  }
  return `https://${endpoint.endsWith("/") ? endpoint : `${endpoint}/`}`;
}
