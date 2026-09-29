import { formatDate, formatNumber, useLanguage } from "../i18n/language";
import type { EventResults, EventSummary } from "./client";

export function EventHistoryPanel({
  history,
  results,
  onOpenEvent,
  onDownloadAttendance,
}: {
  history: EventSummary[];
  results?: EventResults;
  onOpenEvent: (eventId: string) => void;
  onDownloadAttendance: (eventId: string) => void;
}) {
  const { language, t } = useLanguage();

  return (
    <section className="event-history" aria-label={t("events.history.aria")}>
      <div className="event-history-heading">
        <strong>{t("events.history.title")}</strong>
        <small>
          {t("events.history.count", {
            count: formatNumber(language, history.length),
          })}
        </small>
      </div>
      {history.length === 0 ? (
        <small>{t("events.history.empty")}</small>
      ) : (
        <div className="event-history-list">
          {history.map((item) => {
            const startedAt = Date.parse(item.startedAt);
            const startedAtLabel = Number.isFinite(startedAt)
              ? formatDate(language, startedAt, {
                  dateStyle: "medium",
                  timeStyle: "short",
                })
              : t("events.history.timeUnavailable");
            const selected = results?.event.id === item.id;

            return (
              <button
                type="button"
                className={selected ? "selected" : ""}
                aria-pressed={selected}
                key={item.id}
                onClick={() => onOpenEvent(item.id)}
              >
                <span>{item.title}</span>
                <small>
                  {startedAtLabel} ·{" "}
                  {t("events.history.attendeeCount", {
                    count: formatNumber(language, item.attendeeCount),
                  })}
                </small>
              </button>
            );
          })}
        </div>
      )}
      {results && (
        <div className="event-history-results">
          <div className="event-history-heading">
            <strong>{results.event.title}</strong>
            <button
              type="button"
              aria-label={t("events.history.downloadLabel", {
                title: results.event.title,
              })}
              onClick={() => onDownloadAttendance(results.event.id)}
            >
              CSV
            </button>
          </div>
          <small>
            {t("events.history.resultSummary", {
              questions: formatNumber(language, results.questions.length),
              polls: formatNumber(
                language,
                results.polls.filter((poll) => poll.kind === "POLL").length,
              ),
              quizzes: formatNumber(
                language,
                results.polls.filter((poll) => poll.kind === "QUIZ").length,
              ),
              attendees: formatNumber(language, results.event.attendeeCount),
            })}
          </small>
          {results.questions.slice(0, 5).map((question) => (
            <p key={question.id}>
              <b>{question.askerName}</b> {question.text}
              {question.answered
                ? ` · ${question.answer}`
                : ` · ${t("events.history.unanswered")}`}
            </p>
          ))}
          {results.polls.map((poll) => {
            const correctAnswer =
              poll.kind === "QUIZ" && poll.correctOptionIndex !== null
                ? (poll.options.find(
                    (option) => option.index === poll.correctOptionIndex,
                  )?.label ?? t("events.history.answerUnavailable"))
                : undefined;

            return (
              <p key={poll.id}>
                <b>
                  {poll.kind === "QUIZ"
                    ? t("events.history.quiz")
                    : t("events.history.poll")}
                </b>{" "}
                {poll.question}
                {correctAnswer !== undefined && (
                  <>
                    {" "}
                    ·{" "}
                    {t("events.history.correctAnswer", {
                      answer: correctAnswer,
                    })}
                  </>
                )}{" "}
                ·{" "}
                {poll.options
                  .map(
                    (option) =>
                      `${option.label} ${formatNumber(language, option.voteCount)}`,
                  )
                  .join(" / ")}
              </p>
            );
          })}
          {results.quizScores.length > 0 && (
            <p>
              <b>{t("events.history.quizScores")}</b>{" "}
              {results.quizScores
                .map((score) =>
                  t("events.history.quizScore", {
                    name: score.name,
                    score: formatNumber(language, score.score),
                  }),
                )
                .join(" · ")}
            </p>
          )}
        </div>
      )}
    </section>
  );
}
