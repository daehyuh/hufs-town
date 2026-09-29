import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";
import { EventHistoryPanel } from "../../src/events/EventHistoryPanel";
import type { EventResults, EventSummary } from "../../src/events/client";
import { formatDate, LanguageProvider } from "../../src/i18n/language";

const startedAt = "2026-09-26T13:42:39.000Z";
const history: EventSummary[] = [
  {
    id: "town-hall",
    title: "Town Hall",
    description: "",
    resourceUrl: "",
    startedAt,
    endedAt: startedAt,
    attendeeCount: 1200,
  },
];
const results: EventResults = {
  event: history[0],
  questions: [
    {
      id: "question-one",
      askerName: "Alex",
      text: "Where can I find the slides?",
      answered: false,
      answer: "",
      answererName: "",
      askedAt: startedAt,
      answeredAt: "",
    },
  ],
  polls: [
    {
      id: "poll-one",
      question: "Which topic should we cover next?",
      kind: "POLL",
      correctOptionIndex: null,
      closed: true,
      createdAt: startedAt,
      closedAt: startedAt,
      options: [
        { index: 0, label: "Design", voteCount: 800 },
        { index: 1, label: "Web", voteCount: 400 },
      ],
    },
    {
      id: "quiz-one",
      question: "Which city is HUFS in?",
      kind: "QUIZ",
      correctOptionIndex: 1,
      closed: true,
      createdAt: startedAt,
      closedAt: startedAt,
      options: [
        { index: 0, label: "Seoul", voteCount: 200 },
        { index: 1, label: "Yongin", voteCount: 1000 },
      ],
    },
  ],
  quizScores: [{ name: "Alex", score: 12 }],
  attendance: [],
};

function renderPanel(language: "ko" | "en", empty = false) {
  const originalWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: {
      localStorage: { getItem: () => language, setItem: () => undefined },
    },
  });
  try {
    return renderToStaticMarkup(
      createElement(
        LanguageProvider,
        null,
        createElement(EventHistoryPanel, {
          history: empty ? [] : history,
          results: empty ? undefined : results,
          onOpenEvent: () => undefined,
          onDownloadAttendance: () => undefined,
        }),
      ),
    );
  } finally {
    if (originalWindow)
      Object.defineProperty(globalThis, "window", originalWindow);
    else Reflect.deleteProperty(globalThis, "window");
  }
}

it("renders event history, localized stats, dates, and quiz results in both languages", () => {
  const korean = renderPanel("ko");
  const english = renderPanel("en");
  const englishDate = formatDate("en", startedAt, {
    dateStyle: "medium",
    timeStyle: "short",
  });

  expect(korean).toContain('aria-label="행사 기록"');
  expect(korean).toContain("최근 행사");
  expect(korean).toContain("저장된 행사 1개");
  expect(korean).toContain("질문 1 · 투표 1 · 퀴즈 1 · 출석 1,200");
  expect(korean).toContain("미답변");
  expect(korean).toContain("정답 Yongin");
  expect(korean).toContain('aria-label="Town Hall 출석 CSV 다운로드"');

  expect(english).toContain('aria-label="Event history"');
  expect(english).toContain("Recent events");
  expect(english).toContain("Saved events: 1");
  expect(english).toContain(
    "Questions: 1 · polls: 1 · quizzes: 1 · attendees: 1,200",
  );
  expect(english).toContain(englishDate);
  expect(english).toContain("Unanswered");
  expect(english).toContain("Correct answer: Yongin");
  expect(english).toContain("Quiz scores");
  expect(english).toContain("Alex · 12 pts");
  expect(english).not.toContain("최근 행사");
  expect(english).not.toContain("미답변");
});

it("renders the localized empty event history state", () => {
  expect(renderPanel("ko", true)).toContain("저장된 행사가 아직 없어요.");
  expect(renderPanel("en", true)).toContain("No events have been saved yet.");
});
