import { pathToFileURL } from "node:url";

import { BrowserApprovalTerminal } from "./browser-ui.js";
import { TrustedApprovalCompanion } from "./companion.js";
import { ApprovalError } from "./errors.js";
import {
  createApprovalProcessErrorMessage,
  createApprovalResultMessage,
  createApprovalSessionReadyMessage,
  parseApprovalReviewMessage,
} from "./session-protocol.js";

function sendToParent(message: object): Promise<void> {
  if (process.send === undefined || !process.connected) {
    return Promise.reject(
      new ApprovalError(
        "APPROVAL_PROCESS_FAILED",
        "Approval companion has no private parent IPC channel",
      ),
    );
  }
  return new Promise<void>((resolve, reject) => {
    process.send?.(message, (error) => {
      if (error === null || error === undefined) {
        resolve();
      } else {
        reject(
          new ApprovalError(
            "APPROVAL_PROCESS_FAILED",
            "Approval companion could not send a private IPC message",
          ),
        );
      }
    });
  });
}

export async function runApprovalCompanionProcess(): Promise<number> {
  if (process.send === undefined || !process.connected) {
    return 2;
  }

  return new Promise<number>((resolve) => {
    const requestTimer = setTimeout(() => resolve(2), 10_000);
    requestTimer.unref();

    process.once("message", (rawMessage: unknown) => {
      clearTimeout(requestTimer);
      void (async () => {
        let sessionId = "unavailable_abcdefghijklmnopqrstuvwxyz0123456789";
        try {
          const review = parseApprovalReviewMessage(rawMessage);
          const companion = await TrustedApprovalCompanion.create(
            new URL("../contracts/schema/", import.meta.url),
          );
          sessionId = companion.binding.sessionId;
          await sendToParent(
            createApprovalSessionReadyMessage(companion.binding),
          );

          const receipt = await companion.reviewAndSign(
            review.context,
            new BrowserApprovalTerminal(),
          );
          await sendToParent(createApprovalResultMessage(sessionId, receipt));
          resolve(0);
        } catch (error) {
          const approvalError = error instanceof ApprovalError
            ? error
            : new ApprovalError(
                "APPROVAL_PROCESS_FAILED",
                "Approval companion failed",
              );
          try {
            await sendToParent(
              createApprovalProcessErrorMessage(sessionId, approvalError),
            );
          } catch {
            // The parent channel is already unavailable; only the exit code remains.
          }
          resolve(1);
        }
      })();
    });
  });
}

const isEntryPoint =
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href;

if (isEntryPoint) {
  process.exitCode = await runApprovalCompanionProcess();
  if (process.connected) {
    process.disconnect();
  }
}
