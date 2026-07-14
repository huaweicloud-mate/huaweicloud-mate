import { lstat, readdir, readFile } from "node:fs/promises";

import { ContractRegistry } from "../contracts/registry.js";
import { InstallerError } from "../installer/errors.js";
import type { HostId, HostTemplate } from "./types.js";

const requiredHostIds = ["codex", "claude", "opencode", "codearts"] as const;

function asDirectoryUrl(url: URL): URL {
  return url.href.endsWith("/") ? url : new URL(`${url.href}/`);
}

function invalid(message: string): never {
  throw new InstallerError("HOST_TEMPLATE_INVALID", message);
}

export class HostTemplateRegistry {
  readonly #templates: ReadonlyMap<HostId, HostTemplate>;

  private constructor(templates: ReadonlyMap<HostId, HostTemplate>) {
    this.#templates = templates;
  }

  static async load(
    templateDirectory: URL,
    contractDirectory?: URL,
  ): Promise<HostTemplateRegistry> {
    const directory = asDirectoryUrl(templateDirectory);
    const fileNames = (await readdir(directory))
      .filter((name) => name.endsWith(".json"))
      .sort();
    if (fileNames.length !== requiredHostIds.length) {
      return invalid(
        "Host template directory must contain exactly four JSON files",
      );
    }
    const contracts = await ContractRegistry.load(contractDirectory);
    const templates = new Map<HostId, HostTemplate>();
    for (const fileName of fileNames) {
      const templateUrl = new URL(fileName, directory);
      let value: unknown;
      try {
        const entry = await lstat(templateUrl);
        if (!entry.isFile() || entry.isSymbolicLink()) {
          return invalid("Host template must be a regular non-symlink file");
        }
        value = JSON.parse(
          await readFile(templateUrl, "utf8"),
        ) as unknown;
      } catch (error) {
        if (error instanceof InstallerError) {
          throw error;
        }
        return invalid("Host template is not valid JSON");
      }
      if (!contracts.validate("host-template-v1-lite.schema.json", value).valid) {
        return invalid("Host template does not match the v1-lite contract");
      }
      const template = value as HostTemplate;
      if (
        fileName !== `${template.id}.json` ||
        templates.has(template.id)
      ) {
        return invalid("Host template file name or ID is duplicated");
      }
      templates.set(template.id, structuredClone(template));
    }
    if (requiredHostIds.some((id) => !templates.has(id))) {
      return invalid("Host template set is incomplete");
    }
    return new HostTemplateRegistry(templates);
  }

  list(): readonly HostTemplate[] {
    return requiredHostIds.map((id) => this.get(id));
  }

  get(id: HostId): HostTemplate {
    const template = this.#templates.get(id);
    if (template === undefined) {
      return invalid(`Host template ${id} is not registered`);
    }
    return structuredClone(template);
  }
}
