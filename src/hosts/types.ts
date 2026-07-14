export type HostId = "codex" | "claude" | "opencode" | "codearts";

export interface HostTemplate {
  readonly schemaVersion: "huaweicloud-agent-host-template/v1-lite";
  readonly id: HostId;
  readonly displayName: string;
  readonly detect: {
    readonly commands: readonly string[];
    readonly paths: readonly string[];
  };
  readonly mcp: {
    readonly configPath: string;
    readonly entryKey: "huaweicloud-agent";
    readonly mergeStrategy:
      | "json-object"
      | "jsonc-object"
      | "toml-table"
      | "plugin-manifest";
    readonly launcher: {
      readonly ref: "stable-runtime";
      readonly args: readonly ["router", "--stdio"];
    };
  };
  readonly skills: {
    readonly source: "canonical";
    readonly targetPath: string;
  };
  readonly approval: {
    readonly mode: "bundled-trusted-companion";
    readonly issuerId: "huaweicloud-mate.local-approval";
    readonly verifierKeyId: "local-approval-ed25519-v1";
  };
  readonly verify: {
    readonly type: "config-process-skill";
    readonly requiresTrustedApprovalProbe: true;
  };
}
