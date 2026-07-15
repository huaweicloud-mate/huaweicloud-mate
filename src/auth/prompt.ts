import { stdin, stderr } from "node:process";

import { AuthError } from "./errors.js";
import type { CredentialPrompter } from "./types.js";

const maxSecretBytes = 4096;

export class TerminalCredentialPrompter implements CredentialPrompter {
  async readSecret(prompt: string): Promise<string> {
    if (!stdin.isTTY || !stderr.isTTY || typeof stdin.setRawMode !== "function") {
      throw new AuthError(
        "AUTH_NOT_INTERACTIVE",
        "Credential input requires an interactive terminal",
      );
    }
    stderr.write(prompt);
    const wasRaw = stdin.isRaw;
    stdin.setRawMode(true);
    stdin.resume();
    const bytes: number[] = [];
    try {
      return await new Promise<string>((resolve, reject) => {
        const finish = (error?: Error): void => {
          stdin.off("data", onData);
          stderr.write("\n");
          if (error === undefined) {
            resolve(Buffer.from(bytes).toString("utf8"));
          } else {
            reject(error);
          }
        };
        const onData = (chunk: Buffer): void => {
          for (const byte of chunk) {
            if (byte === 3) {
              finish(new AuthError("AUTH_INPUT_INVALID", "Credential input was cancelled"));
              return;
            }
            if (byte === 13 || byte === 10) {
              finish();
              return;
            }
            if (byte === 8 || byte === 127) {
              bytes.pop();
              continue;
            }
            if (byte < 32 || bytes.length >= maxSecretBytes) {
              finish(new AuthError("AUTH_INPUT_INVALID", "Credential input is invalid"));
              return;
            }
            bytes.push(byte);
          }
        };
        stdin.on("data", onData);
      });
    } finally {
      stdin.setRawMode(wasRaw);
      stdin.pause();
    }
  }
}
