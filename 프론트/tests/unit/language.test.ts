import { describe, expect, it, vi } from "vitest";
import {
  formatDate,
  formatNumber,
  koreanErrorDetail,
  localizedErrorText,
  persistLanguage,
  readLanguage,
  translate,
} from "../../src/i18n/language";

describe("language preference and resources", () => {
  it("reads a supported saved language and falls back safely", () => {
    expect(
      readLanguage({ getItem: () => "en", setItem: () => undefined }),
    ).toBe("en");
    expect(
      readLanguage({ getItem: () => "fr", setItem: () => undefined }),
    ).toBe("ko");
    expect(
      readLanguage({ getItem: () => null, setItem: () => undefined }),
    ).toBe("ko");
  });

  it("persists the explicit selection without failing when storage is blocked", () => {
    const setItem = vi.fn();
    persistLanguage("en", { getItem: () => null, setItem });
    expect(setItem).toHaveBeenCalledWith("hufs.language", "en");
    expect(() =>
      persistLanguage("ko", {
        getItem: () => null,
        setItem: () => {
          throw new Error("storage disabled");
        },
      }),
    ).not.toThrow();
  });

  it("translates parameterized UI strings and formats locale-specific values", () => {
    expect(translate("en", "landing.accountWelcome", { name: "Alex" })).toBe(
      "Signed-in account: Alex",
    );
    expect(formatNumber("en", 1200)).toBe("1,200");
    expect(formatNumber("ko", 1200)).toBe("1,200");
    expect(
      formatDate("en", "2026-09-26T12:00:00Z", {
        year: "numeric",
        month: "long",
        day: "numeric",
        timeZone: "UTC",
      }),
    ).toContain("September");
    expect(
      formatDate("ko", "2026-09-26T12:00:00Z", {
        year: "numeric",
        month: "long",
        day: "numeric",
        timeZone: "UTC",
      }),
    ).toContain("9월");
    expect(translate("ko", "roomNote.open")).toBe("공유 메모");
    expect(translate("en", "roomNote.open")).toBe("Shared notes");
    expect(translate("ko", "media.control.mic.on")).toBe("마이크 켜기");
    expect(translate("en", "media.control.mic.on")).toBe("Turn microphone on");
    expect(translate("ko", "auth.guestLoadFailed")).toContain("게스트 입장");
    expect(translate("en", "auth.guestLoadFailed")).toBe(
      "This space does not allow guest access.",
    );
    expect(translate("ko", "connection.overlay.connecting")).toBe(
      "공간에 연결하고 있어요",
    );
    expect(translate("en", "connection.message.reconnecting")).toBe(
      "Connection lost. Reconnecting you to the same place.",
    );
    expect(translate("ko", "campus.nav.people")).toBe("참가자 보기");
    expect(translate("en", "campus.nav.people")).toBe("View participants");
    expect(translate("en", "campus.nav.chatUnread", { count: 3 })).toBe(
      "View chat, 3 unread messages",
    );
    expect(translate("ko", "people.presence.autoAway.title")).toBe(
      "자동 자리 비움",
    );
    expect(translate("en", "people.presence.autoAway.title")).toBe(
      "Automatic away status",
    );
    expect(
      translate("en", "people.participant.profile", { name: "Alex" }),
    ).toBe("View Alex's profile");
    expect(
      translate("ko", "people.participant.profileWithMic", {
        name: "민지",
        status: translate("ko", "people.participant.micOff"),
      }),
    ).toBe("민지님 프로필 보기 · 마이크 꺼짐");
    expect(
      translate("en", "people.participant.profileWithMic", {
        name: "Alex",
        status: translate("en", "people.participant.micOn"),
      }),
    ).toBe("View Alex's profile · Microphone on");
    expect(translate("ko", "people.profile.title", { name: "Alex" })).toBe(
      "Alex님 프로필",
    );
    expect(translate("en", "people.profile.title", { name: "Alex" })).toBe(
      "Alex's profile",
    );
    expect(translate("en", "people.profile.spaceFallback")).toBe(
      "Space participant",
    );
    expect(translate("en", "landing.serverUnavailable")).toBe(
      "Could not connect to the server. Please try again shortly.",
    );
    expect(translate("en", "landing.campusIllustrationAlt")).toContain(
      "Illustration of HUFS Global Campus",
    );
    expect(translate("ko", "landing.title")).toBe("GDG HUFS 훕스타운");
    expect(translate("en", "landing.title")).toBe("GDG HUFS Town");
    expect(translate("ko", "landing.subtitle")).toContain("HUFS SSO");
    expect(translate("ko", "landing.subtitle")).not.toContain("미리보기");
    expect(translate("ko", "landing.subtitle.preview")).toContain("미리보기");
    expect(translate("en", "landing.subtitle")).toContain("HUFS SSO");
    expect(translate("en", "landing.subtitle")).not.toContain("preview");
    expect(translate("en", "landing.subtitle.preview")).toContain(
      "local preview",
    );
    expect(translate("ko", "landing.description")).not.toContain("우리만의");
    expect(translate("en", "landing.description")).not.toContain("our own");
    expect(translate("ko", "lobby.heroTitle")).toBe("공간 목록");
    expect(translate("ko", "lobby.heroDescription")).toContain("공개 공간");
    expect(translate("ko", "lobby.cardDescription")).toBe(
      "공간 설명이 등록되지 않았습니다.",
    );
    expect(translate("en", "lobby.heroTitle")).toBe("Spaces");
    expect(translate("en", "lobby.cardDescription")).toBe(
      "No description provided.",
    );
    expect(translate("ko", "wardrobe.shape")).toBe("체형");
    expect(translate("en", "wardrobe.shape")).toBe("Body type");
    expect(translate("ko", "avatarPart.average")).toBe("보통 체형");
    expect(translate("en", "avatarPart.heavy")).toBe("Broad build");
    expect(translate("ko", "landing.description")).toContain(
      "GDG HUFS가 운영하는",
    );
    expect(translate("en", "landing.description")).toContain(
      "operated by GDG HUFS",
    );
    expect(translate("ko", "landing.localPreviewBadge")).toBe("로컬 미리보기");
    expect(translate("en", "landing.localPreviewBadge")).toBe("Local preview");
    expect(translate("ko", "people.participant.fallbackPlace")).toBe(
      "현재 공간",
    );
    expect(translate("en", "people.participant.fallbackPlace")).toBe(
      "Current space",
    );
    expect(
      translate("en", "auth.notificationConversationUnavailable"),
    ).toContain("from the notification");
    expect(translate("en", "people.profile.error.reconnect")).toBe(
      "Reconnect before viewing this profile.",
    );
    expect(translate("en", "people.profile.error.blocked")).toContain(
      "block setting",
    );
    expect(translate("en", "chat.meetup.sent")).toContain(
      "after it is approved",
    );
    expect(translate("en", "campus.place.commonFallback")).toBe("Common area");
    expect(translate("en", "campus.npc.defaultGreeting")).toBe("Hello!");
    expect(translate("en", "campus.poke.received", { name: "Alex" })).toBe(
      "Alex poked you.",
    );
    expect(
      translate("en", "group.members.removeConfirm", { name: "Alex" }),
    ).toBe("Remove Alex from the group conversation?");
    expect(translate("en", "group.leave.confirm", { name: "Project" })).toBe(
      "Leave the 'Project' group conversation?",
    );
    expect(
      translate("en", "people.participant.joinLabel", { name: "Alex" }),
    ).toBe("Request to join Alex");
    expect(translate("ko", "events.live.hand.raise")).toBe("손들기");
    expect(translate("en", "events.live.hand.raise")).toBe("Raise hand");
    expect(translate("ko", "events.live.defaultTitle")).toBe("전체 발표");
    expect(translate("en", "events.live.defaultTitle")).toBe(
      "Campus-wide presentation",
    );
    expect(translate("ko", "events.engagement.ui.defaultAgree")).toBe("찬성");
    expect(translate("en", "events.engagement.ui.defaultAgree")).toBe("Agree");
    expect(translate("ko", "events.engagement.ui.defaultDisagree")).toBe(
      "반대",
    );
    expect(translate("en", "events.engagement.ui.defaultDisagree")).toBe(
      "Disagree",
    );
    expect(translate("en", "events.live.notice.attendance")).toContain(
      "deleted after 180 days",
    );
    expect(translate("en", "events.live.notice.attendance")).not.toContain(
      "행사",
    );
    expect(translate("ko", "events.scavenger.label")).toBe(
      "캠퍼스 수집 퀘스트",
    );
    expect(translate("en", "events.scavenger.label")).toBe(
      "Campus scavenger hunt",
    );
    expect(translate("en", "events.engagement.error.mapChanged")).toContain(
      "hunt map changed",
    );
    expect(translate("en", "events.engagement.ui.startQuiz")).toBe(
      "Start quiz",
    );
    expect(translate("en", "events.action.error.speakerLimit")).toContain(
      "up to 8 speakers",
    );
    expect(translate("ko", "media.preflight.title")).toBe("입장 전 장치 확인");
    expect(translate("en", "media.preflight.title")).toBe(
      "Check devices before entering",
    );
    expect(translate("en", "media.preflight.error.denied")).toContain(
      "Permission was denied",
    );
    expect(
      translate("en", "media.event.participantCount", {
        count: formatNumber("en", 12),
        peers: formatNumber("en", 8),
        videos: formatNumber("en", 3),
      }),
    ).toBe("12 participants · 8 media peers · 3 incoming videos");
  });

  it("shows a localized fallback instead of crashing on a missing dynamic key", () => {
    const missingKey = undefined as unknown as Parameters<typeof translate>[1];
    expect(translate("ko", missingKey)).toBe("문구를 표시할 수 없어요.");
    expect(translate("en", missingKey)).toBe("Text is unavailable.");
  });

  it("keeps Korean diagnostics private to Korean display and follows language changes", () => {
    const detail = koreanErrorDetail(
      new Error("그룹 멤버를 불러오지 못했어요. 권한을 확인해 주세요."),
    );
    const key = "group.members.loadError";
    expect(
      localizedErrorText("ko", detail, key, (translationKey) =>
        translate("ko", translationKey),
      ),
    ).toBe(detail);
    expect(
      localizedErrorText("en", detail, key, (translationKey) =>
        translate("en", translationKey),
      ),
    ).toBe("Could not load group members.");
    expect(koreanErrorDetail(new Error("Network error"))).toBe("");
  });
});
