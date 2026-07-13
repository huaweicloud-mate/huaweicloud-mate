import { TrustedApprovalCompanion } from "../../dist/approval/companion.js";
import { ApprovalError } from "../../dist/approval/errors.js";
import {
  createApprovalProcessErrorMessage,
  createApprovalResultMessage,
  createApprovalSessionReadyMessage,
  parseApprovalReviewMessage,
} from "../../dist/approval/session-protocol.js";

class TestApprovalTerminal {
  interactive = true;

  write() {}

  async readLine() {
    return "APPROVE";
  }
}

function send(message) {
  return new Promise((resolve, reject) => {
    process.send(message, (error) => {
      if (error === null || error === undefined) {
        resolve();
      } else {
        reject(error);
      }
    });
  });
}

process.once("message", (rawMessage) => {
  void (async () => {
    let sessionId = "test_error_session_abcdefghijklmnopqrstuvwxyz";
    try {
      const review = parseApprovalReviewMessage(rawMessage);
      if (
        process.argv.length !== 2 ||
        Object.values(process.env).some((value) =>
          value?.includes(review.context.request.summary.capabilityId),
        )
      ) {
        throw new ApprovalError(
          "APPROVAL_PROTOCOL_INVALID",
          "Approval context escaped private IPC",
        );
      }
      const companion = await TrustedApprovalCompanion.create();
      sessionId = companion.binding.sessionId;
      await send(createApprovalSessionReadyMessage(companion.binding));
      const receipt = await companion.reviewAndSign(
        review.context,
        new TestApprovalTerminal(),
      );
      await send(createApprovalResultMessage(sessionId, receipt));
      process.disconnect();
    } catch (error) {
      const approvalError = error instanceof ApprovalError
        ? error
        : new ApprovalError("APPROVAL_PROCESS_FAILED", "Test companion failed");
      await send(createApprovalProcessErrorMessage(sessionId, approvalError));
      process.disconnect();
    }
  })();
});
