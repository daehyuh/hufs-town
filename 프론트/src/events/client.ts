import { apiGet, apiMutate } from "../auth/client";

export interface ScheduledEvent {
  id: string;
  title: string;
  description: string;
  instructions: string;
  resourceUrl: string;
  startsAt: string;
  endsAt: string;
  cancelled: boolean;
  createdAt: string;
  updatedAt: string;
  goingCount: number;
  interestedCount: number;
  declinedCount: number;
  myResponse: "" | "GOING" | "INTERESTED" | "DECLINED";
}
export type ScheduledEventResponse = Exclude<ScheduledEvent["myResponse"], "">;
export interface ScheduledEventDraft {
  title: string;
  description: string;
  instructions: string;
  resourceUrl: string;
  startsAt: string;
  endsAt: string;
}
export const listScheduledEvents = (spaceId: string) =>
  apiGet<ScheduledEvent[]>(
    `spaces/${encodeURIComponent(spaceId)}/scheduled-events`,
  );
export const saveScheduledEvent = (
  spaceId: string,
  draft: ScheduledEventDraft,
  eventId?: string,
) =>
  apiMutate<ScheduledEvent>(
    `spaces/${encodeURIComponent(spaceId)}/scheduled-events${eventId ? `/${encodeURIComponent(eventId)}` : ""}`,
    draft,
    eventId ? "PATCH" : "POST",
  );
export const cancelScheduledEvent = (spaceId: string, eventId: string) =>
  apiMutate<ScheduledEvent>(
    `spaces/${encodeURIComponent(spaceId)}/scheduled-events/${encodeURIComponent(eventId)}`,
    undefined,
    "DELETE",
  );
export const respondToScheduledEvent = (
  spaceId: string,
  eventId: string,
  response: ScheduledEventResponse,
) =>
  apiMutate<ScheduledEvent>(
    `spaces/${encodeURIComponent(spaceId)}/scheduled-events/${encodeURIComponent(eventId)}/rsvp`,
    { response },
    "PUT",
  );
export const clearScheduledEventResponse = (spaceId: string, eventId: string) =>
  apiMutate<ScheduledEvent>(
    `spaces/${encodeURIComponent(spaceId)}/scheduled-events/${encodeURIComponent(eventId)}/rsvp`,
    undefined,
    "DELETE",
  );

export interface EventSummary {
  id: string;
  title: string;
  description: string;
  resourceUrl: string;
  startedAt: string;
  endedAt: string;
  attendeeCount: number;
}
export interface EventQuestionResult {
  id: string;
  askerName: string;
  text: string;
  answered: boolean;
  answer: string;
  answererName: string;
  askedAt: string;
  answeredAt: string;
}
export interface EventPollOptionResult {
  index: number;
  label: string;
  voteCount: number;
}
export interface EventPollResult {
  id: string;
  question: string;
  kind: "POLL" | "QUIZ";
  correctOptionIndex: number | null;
  closed: boolean;
  createdAt: string;
  closedAt: string;
  options: EventPollOptionResult[];
}
export interface EventAttendanceResult {
  participantId: string;
  userId: string | null;
  displayName: string;
  joinedAt: string;
  lastSeenAt: string;
  leftAt: string;
  attendedSeconds: number;
  sessionCount: number;
}
export interface EventQuizScoreResult {
  name: string;
  score: number;
}
export interface EventResults {
  event: EventSummary;
  questions: EventQuestionResult[];
  polls: EventPollResult[];
  quizScores: EventQuizScoreResult[];
  attendance: EventAttendanceResult[];
}
export const listEventHistory = (spaceId: string) =>
  apiGet<EventSummary[]>(`spaces/${encodeURIComponent(spaceId)}/events`);
export const getEventResults = (spaceId: string, eventId: string) =>
  apiGet<EventResults>(
    `spaces/${encodeURIComponent(spaceId)}/events/${encodeURIComponent(eventId)}/results`,
  );

export async function downloadEventAttendance(spaceId: string, eventId: string) {
  const response = await fetch(
    `/api/v1/spaces/${encodeURIComponent(spaceId)}/events/${encodeURIComponent(eventId)}/attendance.csv`,
    { credentials: "same-origin", cache: "no-store" },
  );
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    throw new Error(body.message ?? "출석 파일을 내려받지 못했어요.");
  }
  const blob = await response.blob();
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = `hufs-town-attendance-${eventId}.csv`;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}
