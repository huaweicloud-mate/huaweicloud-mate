import { createInterface, type Interface } from "node:readline/promises";

import type { ApprovalTerminal } from "./types.js";

export class NodeApprovalTerminal implements ApprovalTerminal {
  readonly interactive: boolean;
  readonly #readline: Interface;

  constructor(
    private readonly input: NodeJS.ReadStream = process.stdin,
    private readonly output: NodeJS.WriteStream = process.stdout,
  ) {
    this.interactive = input.isTTY === true && output.isTTY === true;
    this.#readline = createInterface({ input, output });
  }

  write(message: string): void {
    this.output.write(message);
  }

  readLine(prompt: string): Promise<string> {
    return this.#readline.question(prompt);
  }

  close(): void {
    this.#readline.close();
  }
}
