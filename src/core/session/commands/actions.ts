import type { ReportProjection } from "../types.js";

export type SessionCompactResult = {
  action: "compact";
  compacted: boolean;
  message: string;
};

export type SessionReportResult = {
  action: "report";
  report: ReportProjection;
  message: string;
};

export type SessionFocusTarget = "conversation" | "activity" | "tasks" | "subagents" | "status";

export type SessionNoticeResult = {
  action: "notice";
  title: string;
  body: string;
  focus?: SessionFocusTarget | undefined;
};

export type SessionExitResult = {
  action: "exit";
  title: string;
  body: string;
};

/** An expanded .coil/commands template: the UI runs `text` as a user turn. */
export type SessionMessageResult = {
  action: "message";
  text: string;
};

export type SessionCommandResult =
  | SessionCompactResult
  | SessionReportResult
  | SessionNoticeResult
  | SessionExitResult
  | SessionMessageResult;
