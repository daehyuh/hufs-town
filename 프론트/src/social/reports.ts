import { apiGet, apiMutate } from "../auth/client";

export type ReportCategory = "HARASSMENT" | "THREAT" | "SPAM" | "PERSONAL_INFO" | "OTHER";
export type ReportStatus = "OPEN" | "REVIEWING" | "RESOLVED" | "DISMISSED";

export interface ReportAccess { administrator: boolean }
export interface ModerationReport {
  reportId: string;
  reporterName: string;
  targetName: string;
  targetType: "ACCOUNT" | "GUEST";
  conversationId: string;
  messageId: string;
  category: ReportCategory;
  details: string;
  evidenceText: string;
  status: ReportStatus;
  createdAt: number;
  reviewedAt: number | null;
  reviewerName: string | null;
  reviewNote: string | null;
  sourceType: "DIRECT_MESSAGE" | "PLAYER";
  spaceId: string | null;
}

export const getReportAccess = () => apiGet<ReportAccess>("reports/access");

export const reportDirectMessage = (messageId: string, category: ReportCategory, details: string) =>
  apiMutate<{ reportId: string; created: boolean }>("reports", { messageId, category, details });

export const listModerationReports = (status: ReportStatus) =>
  apiGet<ModerationReport[]>(`admin/reports?status=${encodeURIComponent(status)}&limit=100`);

export const reviewModerationReport = (reportId: string, status: ReportStatus, note: string) =>
  apiMutate<ModerationReport>(`admin/reports/${encodeURIComponent(reportId)}`, { status, note }, "PATCH");

export const muteReportedUser = (reportId: string, requestId: string, durationMinutes: number, note: string) =>
  apiMutate<{ report: ModerationReport; mutedUntil: number }>(
    `admin/reports/${encodeURIComponent(reportId)}/chat-mute`,
    { requestId, durationMinutes, note },
    "PATCH",
  );

export const muteReportedMedia = (reportId: string, requestId: string, durationMinutes: number, note: string) =>
  apiMutate<{ report: ModerationReport; effectiveUntil: number }>(
    `admin/reports/${encodeURIComponent(reportId)}/media-mute`,
    { requestId, durationMinutes, note },
    "PATCH",
  );

export const kickReportedUser = (reportId: string, requestId: string, note: string) =>
  apiMutate<{ report: ModerationReport; effectiveUntil: number }>(
    `admin/reports/${encodeURIComponent(reportId)}/kick`,
    { requestId, note },
    "PATCH",
  );
