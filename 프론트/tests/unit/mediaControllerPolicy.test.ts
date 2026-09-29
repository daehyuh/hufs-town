import { expect, it, vi } from "vitest";
import type { MediaOffer, MediaState } from "../../src/generated/protocol";
import type {
  ConnectionStatus,
  WorldConnection,
} from "../../src/game/WorldConnection";
import {
  MediaController,
  type MediaView,
} from "../../src/media/MediaController";

type ControllerProbe = {
  key: string;
  view: MediaView;
  pruneConsumers: (offers: MediaOffer[]) => void;
  receive: () => Promise<void>;
};

const policy = (): MediaState => ({
  type: "mediaState",
  policyEpoch: 7,
  domain: "space:main",
  kind: "NEARBY",
  available: true,
  transitioning: false,
  limited: false,
  proximityEnterDistance: 5,
  proximityExitDistance: 7,
  moderatedSources: [],
  peers: [],
  offers: [],
  engineId: "sfu-1",
  eventMode: false,
  eventSpeaker: false,
  eventTitle: "",
});

it("reconciles media only when the connection or policy changes", async () => {
  let notify: (() => void) | undefined;
  let snapshot: {
    status: ConnectionStatus;
    selfId: string;
    media: MediaState;
  } = { status: "online", selfId: "self", media: policy() };
  const connection = {
    getSnapshot: () => snapshot,
    subscribe: (listener: () => void) => {
      notify = listener;
      return () => {
        notify = undefined;
      };
    },
  } as unknown as WorldConnection;
  const controller = new MediaController(connection, true);
  const probe = controller as unknown as ControllerProbe;
  probe.key = "self:7:sfu-1:space:main";
  probe.view = { ...controller.getSnapshot(), status: "ready" };
  probe.pruneConsumers = vi.fn();
  probe.receive = vi.fn(async () => {});

  controller.start();
  expect(probe.pruneConsumers).toHaveBeenCalledTimes(1);
  expect(probe.receive).toHaveBeenCalledTimes(1);

  // Player movement and unrelated world updates keep this media policy object.
  notify?.();
  expect(probe.pruneConsumers).toHaveBeenCalledTimes(1);
  expect(probe.receive).toHaveBeenCalledTimes(1);

  // The server sends a new object when offers or other policy fields change.
  snapshot = { ...snapshot, media: { ...snapshot.media, offers: [] } };
  notify?.();
  expect(probe.pruneConsumers).toHaveBeenCalledTimes(2);
  expect(probe.receive).toHaveBeenCalledTimes(2);

  controller.stop();
});
