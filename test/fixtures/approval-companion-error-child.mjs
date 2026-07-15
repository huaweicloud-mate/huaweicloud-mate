export async function runApprovalCompanionProcess() {
  if (process.send === undefined || !process.connected) return 2;
  return await new Promise((resolve) => {
    process.once("message", async (review) => {
      const documents =
        globalThis.__HUAWEICLOUD_MATE_VERIFIED_CONTRACT_DOCUMENTS__;
      const contractSetValid =
        typeof documents === "object" &&
        documents !== null &&
        Object.keys(documents).length === 7 &&
        documents["approval-v1.schema.json"]?.includes(
          "urn:huaweicloud:agent-plugin:approval:v1",
        );
      const leaked =
        process.argv.some((value) =>
          value.includes("Verified source bootstrap fixture"),
        ) ||
        Object.values(process.env).some((value) =>
          value?.includes(review?.context?.request?.summary?.capabilityId ?? "\0"),
        );
      const inspector = await import("node:inspector");
      const unsafeProcess =
        inspector.url() !== undefined ||
        !process.execArgv.includes("--disable-sigusr1") ||
        process.execArgv.some((argument) =>
          /^--(?:inspect|debug)(?:-|=|$)/.test(argument)
        ) ||
        process.env.NODE_OPTIONS !== undefined ||
        process.env.NODE_PATH !== undefined ||
        process.env.NODE_DEBUG !== undefined ||
        process.env.NODE_DEBUG_NATIVE !== undefined ||
        process.env.NODE_V8_COVERAGE !== undefined ||
        process.env.SSLKEYLOGFILE !== undefined;
      process.send(
        {
          schemaVersion: "huaweicloud-mate-approval-result/v1",
          type: "approval-result",
          status: "error",
          approvalSessionId:
            "fixture_error_session_abcdefghijklmnopqrstuvwxyz0123456789",
          code: leaked || unsafeProcess || !contractSetValid
            ? "APPROVAL_PROTOCOL_INVALID"
            : "APPROVAL_PROCESS_FAILED",
          message: leaked || unsafeProcess || !contractSetValid
            ? "Private source, review, or verified contracts are invalid"
            : "Verified source bootstrap fixture",
        },
        () => resolve(1),
      );
    });
  });
}
