import { RouterError } from "./errors.js";

export const redactedValue = "[REDACTED]";

function cloneJson(value: unknown): unknown {
  try {
    const serialized = JSON.stringify(value);
    if (serialized === undefined) {
      throw new TypeError("JSON value is undefined");
    }
    return JSON.parse(serialized) as unknown;
  } catch {
    throw new RouterError(
      "OUTPUT_REJECTED",
      "Executor result is not serializable JSON",
    );
  }
}

function decodePointerToken(token: string): string {
  return token.replaceAll("~1", "/").replaceAll("~0", "~");
}

function replaceOwnValue(container: object, key: string): void {
  Object.defineProperty(container, key, {
    value: redactedValue,
    configurable: true,
    enumerable: true,
    writable: true,
  });
}

function hasPointerTarget(container: object, token: string): boolean {
  if (Array.isArray(container)) {
    if (!/^(?:0|[1-9][0-9]*)$/u.test(token)) {
      return false;
    }
    const index = Number(token);
    return Number.isSafeInteger(index) && Object.hasOwn(container, index);
  }
  return Object.hasOwn(container, token);
}

export function redactJsonPointers(
  value: unknown,
  pointers: readonly string[],
): unknown {
  let redacted = cloneJson(value);
  for (const pointer of pointers) {
    if (pointer === "") {
      redacted = redactedValue;
      continue;
    }
    const tokens = pointer.slice(1).split("/").map(decodePointerToken);
    let current = redacted;
    for (let index = 0; index < tokens.length; index += 1) {
      const token = tokens[index];
      if (
        token === undefined ||
        typeof current !== "object" ||
        current === null ||
        !hasPointerTarget(current, token)
      ) {
        break;
      }
      if (index === tokens.length - 1) {
        replaceOwnValue(current, token);
        break;
      }
      current = (current as Record<string, unknown>)[token];
    }
  }
  return redacted;
}
