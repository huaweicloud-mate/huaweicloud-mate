import type { RuntimePermissionPolicy } from "../../src/installer/runtime-permissions.js";

export const noopRuntimePermissions: RuntimePermissionPolicy = {
  async secureRoot(): Promise<void> {},
  async verifyRoot(): Promise<void> {},
};
