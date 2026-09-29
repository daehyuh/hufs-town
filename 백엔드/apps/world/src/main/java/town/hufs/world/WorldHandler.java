package town.hufs.world;

import com.fasterxml.jackson.databind.*;
import jakarta.annotation.PreDestroy;
import io.micrometer.core.instrument.MeterRegistry;
import io.micrometer.core.instrument.simple.SimpleMeterRegistry;
import org.springframework.beans.factory.ObjectProvider;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Component;
import org.springframework.web.socket.*;
import org.springframework.web.socket.handler.TextWebSocketHandler;
import town.hufs.domain.Movement;
import town.hufs.domain.MediaPolicy;
import town.hufs.protocol.*;
import town.hufs.auth.TownPrincipal;
import town.hufs.auth.AvatarCatalog;
import town.hufs.auth.JoinTickets;
import town.hufs.auth.PublishedMaps;

import java.util.*;
import java.util.concurrent.*;
import java.util.concurrent.atomic.AtomicReference;

@Component
public class WorldHandler extends TextWebSocketHandler implements SubProtocolCapable {
    private static final int MAX_SNAPSHOT_SYNC_FAILURES = 3;
    private static final List<String> WORLD_FEATURES = List.of("PARTICIPANT_REPORTS", "PERSISTENT_SIT", "EXTENDED_EMOTES", "SCAVENGER_HUNT", "MICROPHONE_PRESENCE");
    private static final List<String> ROOM_EXTRA_FEATURES = List.of("ROOM_NOTES", "ROOM_RECORDING");
    @Override public List<String> getSubProtocols() { return List.of("hufs-town-v2"); }
    private final ObjectMapper json = new ObjectMapper().enable(DeserializationFeature.FAIL_ON_MISSING_CREATOR_PROPERTIES)
        .enable(DeserializationFeature.FAIL_ON_NULL_FOR_PRIMITIVES).enable(DeserializationFeature.FAIL_ON_UNKNOWN_PROPERTIES)
        .disable(DeserializationFeature.ACCEPT_FLOAT_AS_INT);
    private final MapDefinition defaultMap = MapLoader.campus();
    private final Map<String, PublishedMaps.Published> roomMaps = new HashMap<>();
    private final Map<String, Movement.CollisionGrid> roomMovementGrids = new HashMap<>();
    private final ScavengerObjectCountsCache scavengerObjectCounts = new ScavengerObjectCountsCache();
    private final Map<String, CachedMapChange> mapChangedPayloads = new HashMap<>();
    private final String defaultMapChangedPayload;
    private final Map<String, PublishedMaps.Published> pendingMaps = new HashMap<>();
    private final MediaPolicy mediaPolicy = new MediaPolicy();
    private final MediaGateway media;
    private final ScheduledExecutorService ticker = Executors.newScheduledThreadPool(2);
    // Both bounded queues cover a whole connection batch (including simultaneous session revocation).
    private final ThreadPoolExecutor sends;
    private final ExecutorService closes = new ThreadPoolExecutor(2, 2, 0, TimeUnit.SECONDS, new ArrayBlockingQueue<>(512));
    private final Semaphore socketSlots = new Semaphore(320);
    private final ConcurrentMap<String, Connection> connections = new ConcurrentHashMap<>();
    private final ArrayBlockingQueue<Runnable> commands = new ArrayBlockingQueue<>(512);
    // Initial joins build player state and snapshots, so pace them separately from real-time commands.
    private final ArrayBlockingQueue<Runnable> joinCommands = new ArrayBlockingQueue<>(512);
    private final ConcurrentLinkedQueue<JoinTickets.Admission> pendingAdmissionReleases = new ConcurrentLinkedQueue<>();
    private final ConcurrentLinkedQueue<JoinTickets.SeatLease> pendingSeatReleases = new ConcurrentLinkedQueue<>();
    private final ConcurrentLinkedQueue<JoinTickets.Ownership> pendingOwnershipReleases = new ConcurrentLinkedQueue<>();
    private final Set<String> releasingSeatIds = ConcurrentHashMap.newKeySet();
    private volatile List<JoinTickets.SeatLease> seatLeaseSnapshot = List.of();
    private volatile List<WorldMapPublicationStore.AppliedMap> mapPublicationSnapshot = List.of();
    private final String worldNodeId = UUID.randomUUID().toString();
    private volatile WorldMapPublicationStore mapPublicationStore;
    private volatile long nextMapPublicationWarningAt;
    private final Map<String, PendingJoin> joinRequests = new HashMap<>();
    private final Map<RoomKey, RoomRuntime> roomRuntimes = new HashMap<>();
    private final Map<String, EventRuntime> events = new HashMap<>();
    private final Map<String, SpaceParticipants> spaceParticipantViews = new HashMap<>();
    // Only the room tick writes these maps and player state.
    private final Map<String, Player> players = new LinkedHashMap<>();
    private final Map<String, Integer> spacePlayerCounts = new HashMap<>();
    private final Map<String, Player> resumable = new HashMap<>();
    private final Map<String, Long> blockRefreshAt = new HashMap<>();
    private final Set<String> pendingBlockRefresh = ConcurrentHashMap.newKeySet();
    private long tick;
    private final WorldAuthentication auth;
    private final WorldRuntimeMetrics metrics;
    private final ChatPersistence chatPersistence;
    private final UserBlockStore userBlockStore;
    private final DirectMessageStore directMessageStore;
    private final UserReportStore userReportStore;
    private final UserModerationStore userModerationStore;
    private final SpaceAccessStore spaceAccessStore;
    private final EventPersistence eventPersistence;
    private final WorldDndPresence dndPresence;
    private volatile ProductAnalytics productAnalytics;
    @Value("${town.features.room-extras.enabled:false}")
    private boolean roomExtrasEnabled;
    @Value("${town.world.max-joins-per-tick:8}")
    private int maxJoinsPerTick = 8;
    private volatile RoomNotesStore roomNotesStore;
    private volatile DirectMessageFanout directMessageFanout;
    private volatile long nextModerationRefreshAt;
    private volatile boolean moderationRefreshPending;
    private volatile long nextSpaceAccessRefreshAt;
    private volatile boolean spaceAccessRefreshPending;
    private final ScheduledExecutorService authChecks = Executors.newSingleThreadScheduledExecutor();
    private long nextSeatRenewAt;
    private long nextDndPresenceSnapshotAt;

    @Autowired
    public WorldHandler(WorldAuthentication auth, MediaGateway media, ObjectProvider<ChatPersistence> chatStorage,
                        ObjectProvider<UserBlockStore> blockStorage, ObjectProvider<DirectMessageStore> directStorage,
                        ObjectProvider<UserReportStore> reportStorage,
                        ObjectProvider<UserModerationStore> moderationStorage, ObjectProvider<SpaceAccessStore> accessStorage,
                        ObjectProvider<EventPersistence> eventStorage, ObjectProvider<MeterRegistry> meterRegistry,
                        ObjectProvider<WorldDndPresence> dndPresenceStorage,
                        @Value("${town.world.send-threads:4}") int sendThreads) {
        this(auth, media, chatStorage.getIfAvailable(), blockStorage.getIfAvailable(), directStorage.getIfAvailable(),
            reportStorage.getIfAvailable(), moderationStorage.getIfAvailable(), accessStorage.getIfAvailable(),
            eventStorage.getIfAvailable(), meterRegistry.getIfAvailable(), dndPresenceStorage.getIfAvailable(), sendThreads);
    }
    public WorldHandler(WorldAuthentication auth, MediaGateway media) {
        this(auth, media, (ChatPersistence)null, (UserBlockStore)null, (DirectMessageStore)null,
            (UserReportStore)null, (UserModerationStore)null, (SpaceAccessStore)null, (EventPersistence)null, null, null, 4);
    }
    WorldHandler(WorldAuthentication auth, MediaGateway media, UserModerationStore moderationStorage) {
        this(auth, media, null, null, null, null, moderationStorage, null, null, null, null, 4);
    }
    WorldHandler(WorldAuthentication auth, MediaGateway media, MeterRegistry meterRegistry) {
        this(auth, media, null, null, null, null, null, null, null, meterRegistry, null, 4);
    }
    private WorldHandler(WorldAuthentication auth, MediaGateway media, ChatPersistence chatStorage,
                         UserBlockStore blockStorage, DirectMessageStore directStorage, UserReportStore reportStorage,
                         UserModerationStore moderationStorage,
                         SpaceAccessStore accessStorage, EventPersistence eventStorage, MeterRegistry meterRegistry,
                         WorldDndPresence dndPresence, int sendThreads) {
        if (sendThreads < 2 || sendThreads > 16)
            throw new IllegalArgumentException("town.world.send-threads must be between 2 and 16");
        this.auth = auth; this.media = media; this.chatPersistence = chatStorage; this.userBlockStore = blockStorage;
        this.directMessageStore = directStorage; this.userReportStore = reportStorage;
        this.userModerationStore = moderationStorage; this.spaceAccessStore = accessStorage;
        this.eventPersistence = eventStorage;
        this.dndPresence = dndPresence;
        this.sends = new ThreadPoolExecutor(sendThreads, sendThreads, 0, TimeUnit.SECONDS, new ArrayBlockingQueue<>(512));
        this.defaultMapChangedPayload = encodeMapChangedPayload(defaultMap);
        this.metrics = new WorldRuntimeMetrics(meterRegistry == null ? new SimpleMeterRegistry() : meterRegistry,
            commands, joinCommands, connections);
        ticker.scheduleAtFixedRate(this::step, 50, 50, TimeUnit.MILLISECONDS);
        ticker.scheduleAtFixedRate(this::sweep, 1, 1, TimeUnit.SECONDS);
        authChecks.scheduleWithFixedDelay(this::checkSessions, 1, 1, TimeUnit.SECONDS);
    }
    @Autowired(required = false)
    void attachDirectMessageFanout(DirectMessageFanout fanout) {
        directMessageFanout = fanout;
        fanout.receiver(this::receiveDirectMessageRelay);
    }
    @Autowired(required = false)
    void attachProductAnalytics(ProductAnalytics analytics) {
        productAnalytics = analytics;
    }
    @Autowired(required = false)
    void attachMapPublicationStore(WorldMapPublicationStore store) { mapPublicationStore = store; }
    @Autowired(required = false)
    void attachRoomNotesStore(RoomNotesStore store) {
        roomNotesStore = store;
        store.receiver(relay -> offerCommand(() -> broadcastRoomNote(relay)));
    }
    @Autowired(required = false)
    void attachUserBlockChangeFanout(UserBlockChangeFanout fanout) {
        fanout.receiver(userId -> {
            if (!offerCommand(() -> blockRefreshAt.put(userId, 0L)))
                org.slf4j.LoggerFactory.getLogger(getClass()).warn("Block-list refresh queue is full; periodic SQL refresh will recover it");
        });
    }
    @Override public void afterConnectionEstablished(WebSocketSession session) throws Exception {
        if (!socketSlots.tryAcquire()) { session.close(CloseStatus.SERVICE_OVERLOAD); return; }
        session.setTextMessageSizeLimit(65_536);
        connections.put(session.getId(), new Connection(session, new SessionSender(session, sends)));
    }
    @Override protected void handleTextMessage(WebSocketSession session, TextMessage message) {
        Connection c = connections.get(session.getId());
        if (c == null) return;
        try {
            long now = System.nanoTime();
            synchronized (c) {
                if (now - c.windowStart > 1_000_000_000L) { c.windowStart = now; c.messages = 0; }
                if (++c.messages > 120) { fail(c, "RATE_LIMIT", "입력이 너무 빠릅니다. 잠시 후 다시 접속하세요."); return; }
            }
            JsonNode node = json.readTree(message.getPayload());
            String type = node.path("type").asText();
            if(!type.equals("mediaRequest")&&!type.equals("chatSend")&&!type.equals("roomNoteRequest")&&!type.equals("roomRecordingRequest")&&!type.equals("directMessageMutationRequest")&&!type.equals("profileUpdate")&&!type.equals("playerReportRequest")&&message.getPayloadLength()>1024)throw new IllegalArgumentException();
            if((type.equals("chatSend")||type.equals("directMessageMutationRequest"))&&message.getPayloadLength()>4096)throw new IllegalArgumentException();
            if(type.equals("playerReportRequest")&&message.getPayloadLength()>8192)throw new IllegalArgumentException();
            if(type.equals("profileUpdate")&&message.getPayloadLength()>8192)throw new IllegalArgumentException();
            if (type.equals("join")) {
                Join join = json.treeToValue(node, Join.class);
                if (join.protocolVersion() != 2 || join.name() == null || join.name().isBlank() || join.name().length() > 20
                    || join.name().chars().anyMatch(Character::isISOControl) || join.avatar() < 0 || join.avatar() > 2
                    || join.skin() == null || join.clothing() == null || join.hair() == null
                    || (c.principal == null && (!AvatarCatalog.SKIN_TONES.contains(join.skin())
                        || !AvatarCatalog.CLOTHING.contains(join.clothing()) || !AvatarCatalog.HAIR.contains(join.hair())))
                    || join.resumeToken() == null || join.resumeToken().length() > 100) throw new IllegalArgumentException();
                synchronized (c) { if (c.joinRequested) throw new IllegalArgumentException(); c.joinRequested = true; }
                enqueueJoin(c, () -> join(c, join));
            } else if (type.equals("profileUpdate")) {
                ProfileUpdate update = json.treeToValue(node, ProfileUpdate.class);
                String normalizedBio = update.bio() == null ? "" : update.bio().strip();
                if (update.epoch() < 1 || update.name() == null || update.name().strip().isEmpty() || update.name().strip().length() > 20
                    || update.name().codePoints().anyMatch(ch -> Character.isISOControl(ch) || Character.getType(ch) == Character.FORMAT)
                    || update.avatar() < 0 || update.avatar() > 2 || !AvatarCatalog.SKIN_TONES.contains(update.skin())
                    || !AvatarCatalog.CLOTHING.contains(update.clothing()) || !AvatarCatalog.HAIR.contains(update.hair())
                    || normalizedBio.codePointCount(0, normalizedBio.length()) > 280
                    || normalizedBio.codePoints().anyMatch(ch -> Character.isISOControl(ch) || Character.getType(ch) == Character.FORMAT)
                    || update.links() == null) throw new IllegalArgumentException();
                List<String> links = update.links().stream().filter(Objects::nonNull).map(String::strip)
                    .filter(value -> !value.isEmpty()).distinct().toList();
                if (links.size() > 3 || links.stream().anyMatch(link -> link.length() > 512 || !link.matches("(?i)https?://[^\\s]+")))
                    throw new IllegalArgumentException();
                enqueue(c, () -> updateProfile(c, update, normalizedBio, links));
            } else if (type.equals("profileRequest")) {
                ProfileRequest request = json.treeToValue(node, ProfileRequest.class);
                if (request.epoch() < 1 || request.requestId() == null
                    || !request.requestId().matches("[A-Za-z0-9_-]{1,64}")
                    || request.targetId() == null || request.targetId().length() > 36)
                    throw new IllegalArgumentException();
                enqueue(c, () -> requestProfileDetails(c, request));
            } else if (type.equals("move")) {
                Move move = json.treeToValue(node, Move.class);
                if (!Double.isFinite(move.dx()) || !Double.isFinite(move.dy()) || move.dx() < -1 || move.dx() > 1 || move.dy() < -1 || move.dy() > 1 || move.seq() < 0 || move.seq() > 9_007_199_254_740_991L) throw new IllegalArgumentException();
                c.input.set(new TimedInput(move, now));
            } else if (type.equals("snapshotAck")) {
                SnapshotAck ack = json.treeToValue(node, SnapshotAck.class);
                if (ack.tick() < 0 || ack.tick() > 9_007_199_254_740_991L) throw new IllegalArgumentException();
                enqueue(c, () -> acknowledgeSnapshot(c, ack));
            } else if (type.equals("emote")) {
                Emote emote = json.treeToValue(node, Emote.class);
                if (!Set.of("wave", "heart", "clap", "sparkles", "laugh", "thumbsup", "sad", "sit", "party", "thinking", "hands", "wow", "fire").contains(emote.emoji())) throw new IllegalArgumentException();
                enqueue(c, () -> {
                    Player p = c.player;
                    if (p != null && p.connection == c && p.epoch == emote.epoch() && System.currentTimeMillis() >= p.nextEmoteAt) {
                        long emoteAt = System.currentTimeMillis();
                        if ("sit".equals(emote.emoji())) {
                            p.sitting = !p.sitting;
                        } else {
                            EmoteEvent event = new EmoteEvent("emoteEvent", UUID.randomUUID().toString(),
                                p.id, emote.emoji(), emoteAt);
                            for (Player recipient : players.values())
                                if (recipient.connection != null && !recipient.connection.closed && sameWorld(recipient, p)
                                    && WorldInterest.visible(recipient.x, recipient.y, p.x, p.y))
                                    control(recipient.connection, event);
                        }
                        // Preserve rapid repeat input while bounding per-player fan-out to 5 events/second.
                        p.nextEmoteAt = emoteAt + 200;
                    }
                });
            } else if (type.equals("presenceSet")) {
                PresenceSet presence = json.treeToValue(node, PresenceSet.class);
                if (presence.epoch() < 1 || presence.requestId() == null
                    || !presence.requestId().matches("[A-Za-z0-9_-]{1,64}")
                    || !Set.of("AVAILABLE", "AWAY", "DND").contains(presence.status()))
                    throw new IllegalArgumentException();
                enqueue(c, () -> setPresence(c, presence));
            } else if (type.equals("microphoneSet")) {
                MicrophoneSet microphone = json.treeToValue(node, MicrophoneSet.class);
                if (microphone.epoch() < 1) throw new IllegalArgumentException();
                enqueue(c, () -> setMicrophone(c, microphone));
            } else if (type.equals("pokePreference")) {
                PokePreference preference = json.treeToValue(node, PokePreference.class);
                if (preference.epoch() < 1) throw new IllegalArgumentException();
                enqueue(c, () -> {
                    Player player = c.player;
                    if (player != null && player.connection == c && player.epoch == preference.epoch()) {
                        player.allowPokes = preference.enabled();
                        control(c, new PokePreferenceState("pokePreferenceState", player.allowPokes));
                    }
                });
            } else if (type.equals("poke")) {
                Poke poke = json.treeToValue(node, Poke.class);
                if (poke.epoch() < 1 || poke.requestId() == null || !poke.requestId().matches("[A-Za-z0-9_-]{1,64}")
                    || poke.targetId() == null || poke.targetId().length() > 36) throw new IllegalArgumentException();
                enqueue(c, () -> poke(c, poke));
            } else if (type.equals("playerReportRequest")) {
                PlayerReportRequest request = json.treeToValue(node, PlayerReportRequest.class);
                String details = request.details() == null ? "" : request.details().strip();
                if (request.epoch() < 1 || request.requestId() == null
                    || !request.requestId().matches("[A-Za-z0-9_-]{1,64}")
                    || request.targetId() == null || request.targetId().length() > 36
                    || !Set.of("HARASSMENT", "THREAT", "SPAM", "PERSONAL_INFO", "OTHER").contains(request.category())
                    || details.codePointCount(0, details.length()) > 1000
                    || details.codePoints().anyMatch(ch -> Character.isISOControl(ch) && ch != '\n' && ch != '\t'))
                    throw new IllegalArgumentException();
                enqueue(c, () -> reportPlayer(c, request, details));
            } else if (type.equals("blockAction")) {
                BlockAction action = json.treeToValue(node, BlockAction.class);
                if (action.epoch() < 1 || action.requestId() == null
                    || !action.requestId().matches("[A-Za-z0-9_-]{1,64}")
                    || action.targetId() == null || action.targetId().length() > 36)
                    throw new IllegalArgumentException();
                enqueue(c, () -> block(c, action));
            } else if (type.equals("joinRequest")) {
                JoinRequest request = json.treeToValue(node, JoinRequest.class);
                if (request.epoch() < 1 || request.requestId() == null
                    || !request.requestId().matches("[A-Za-z0-9_-]{1,64}")
                    || request.targetId() == null || request.targetId().length() > 36)
                    throw new IllegalArgumentException();
                enqueue(c, () -> requestJoin(c, request));
            } else if (type.equals("joinResponse")) {
                JoinResponse response = json.treeToValue(node, JoinResponse.class);
                if (response.epoch() < 1 || response.requestId() == null
                    || !response.requestId().matches("[A-Za-z0-9_-]{1,64}"))
                    throw new IllegalArgumentException();
                enqueue(c, () -> respondToJoin(c, response));
            } else if (type.equals("roomAction")) {
                RoomAction action = json.treeToValue(node, RoomAction.class);
                if (action.epoch() < 1 || action.requestId() == null
                    || !action.requestId().matches("[A-Za-z0-9_-]{1,64}")
                    || action.zoneId() == null || action.zoneId().isBlank() || action.zoneId().length() > 64
                    || !Set.of("LOCK", "UNLOCK", "SET_CAPACITY", "KICK").contains(action.action())
                    || action.capacity() < 2 || action.capacity() > 100
                    || action.targetPlayerId() == null || action.targetPlayerId().length() > 36
                    || ("KICK".equals(action.action()) ? action.targetPlayerId().isBlank() : !action.targetPlayerId().isEmpty()))
                    throw new IllegalArgumentException();
                enqueue(c, () -> roomAction(c, action));
            } else if (type.equals("roomKnockResponse")) {
                RoomKnockResponse response = json.treeToValue(node, RoomKnockResponse.class);
                if (response.epoch() < 1 || response.requestId() == null
                    || !response.requestId().matches("[A-Za-z0-9_-]{1,64}")
                    || response.zoneId() == null || response.zoneId().isBlank() || response.zoneId().length() > 64
                    || response.knockId() == null || response.knockId().length() > 36)
                    throw new IllegalArgumentException();
                enqueue(c, () -> respondToRoomKnock(c, response));
            } else if (type.equals("roomNoteRequest")) {
                RoomNoteRequest request = json.treeToValue(node, RoomNoteRequest.class);
                if (request.epoch() < 1 || request.requestId() == null
                    || !request.requestId().matches("[A-Za-z0-9_-]{1,64}")
                    || !Set.of("LOAD", "SAVE").contains(request.action())
                    || request.baseRevision() < 0 || request.body() == null
                    || request.body().codePointCount(0, request.body().length()) > 4000
                    || request.body().codePoints().anyMatch(ch -> Character.isISOControl(ch) && ch != '\n' && ch != '\t')
                    || ("LOAD".equals(request.action()) && (!request.body().isEmpty() || request.baseRevision() != 0)))
                    throw new IllegalArgumentException();
                enqueue(c, () -> roomNote(c, request));
            } else if (type.equals("roomRecordingRequest")) {
                // Older clients omit this optional false field. The strict mapper requires all record components.
                if (!node.has("transcribe") && node.isObject())
                    ((com.fasterxml.jackson.databind.node.ObjectNode)node).put("transcribe", false);
                RoomRecordingRequest request = json.treeToValue(node, RoomRecordingRequest.class);
                if (request.epoch() < 1 || request.requestId() == null
                    || !request.requestId().matches("[A-Za-z0-9_-]{1,64}")
                    || request.zoneId() == null || request.zoneId().isBlank() || request.zoneId().length() > 80
                    || request.action() == null || !Set.of("START", "CONSENT", "WITHDRAW", "STOP").contains(request.action())
                    || request.recordingId() == null || request.recordingId().length() > 36
                    || request.sources() == null || request.sources().size() > 4
                    || request.sources().stream().anyMatch(source -> source == null || !Set.of("MICROPHONE", "CAMERA", "SCREEN", "SCREEN_AUDIO").contains(source))
                    || new HashSet<>(request.sources()).size() != request.sources().size()
                    || ("START".equals(request.action()) ? (!request.recordingId().isEmpty() || request.sources().isEmpty() || request.accepted())
                        : (!request.sources().isEmpty() || request.transcribe() || !validUuid(request.recordingId())
                            || ("CONSENT".equals(request.action()) ? false : request.accepted()))))
                    throw new IllegalArgumentException();
                enqueue(c, () -> roomRecording(c, request));
            } else if (type.equals("eventAction")) {
                EventAction action = json.treeToValue(node, EventAction.class);
                if (action.epoch() < 1 || action.requestId() == null
                    || !action.requestId().matches("[A-Za-z0-9_-]{1,64}")
                    || !Set.of("START", "STOP", "GRANT_SPEAKER", "REVOKE_SPEAKER", "RAISE_HAND", "LOWER_HAND").contains(action.action())
                    || action.targetPlayerId() == null || action.targetPlayerId().length() > 36
                    || action.title() == null || action.title().length() > 80
                    || action.description() == null || action.description().length() > 280
                    || action.resourceUrl() == null || action.resourceUrl().length() > 512
                    || action.title().chars().anyMatch(Character::isISOControl)
                    || action.description().chars().anyMatch(Character::isISOControl)
                    || (!action.resourceUrl().isEmpty() && !action.resourceUrl().matches("https?://[^\\s]+"))) throw new IllegalArgumentException();
                enqueue(c, () -> eventAction(c, action));
            } else if (type.equals("eventEngagement")) {
                EventEngagement engagement = json.treeToValue(node, EventEngagement.class);
                if (engagement.epoch() < 1 || engagement.requestId() == null
                    || !engagement.requestId().matches("[A-Za-z0-9_-]{1,64}")
                    || !Set.of("ASK_QUESTION", "ANSWER_QUESTION", "CREATE_POLL", "CREATE_QUIZ", "VOTE_POLL", "CLOSE_POLL",
                        "START_SCAVENGER_HUNT", "STOP_SCAVENGER_HUNT", "SCAVENGER_TALK", "COLLECT_SCAVENGER_ITEM").contains(engagement.action())
                    || engagement.questionId() == null || engagement.questionId().length() > 36
                    || engagement.text() == null || engagement.text().length() > 280
                    || engagement.pollQuestion() == null || engagement.pollQuestion().length() > 160
                    || engagement.pollOptions() == null || engagement.pollOptions().size() > 6
                    || engagement.pollOptions().stream().anyMatch(option -> option == null || option.length() > 80 || option.chars().anyMatch(Character::isISOControl))
                    || engagement.optionIndex() < 0 || engagement.optionIndex() > 5
                    || ("CREATE_QUIZ".equals(engagement.action())
                        && (engagement.correctOptionIndex() < 0 || engagement.correctOptionIndex() > 5))
                    || (Set.of("SCAVENGER_TALK", "COLLECT_SCAVENGER_ITEM").contains(engagement.action())
                        && (engagement.text().isBlank() || engagement.text().length() > 80
                            || !engagement.text().matches("[A-Za-z0-9_-]{1,80}")))
                    || engagement.text().chars().anyMatch(Character::isISOControl)
                    || engagement.pollQuestion().chars().anyMatch(Character::isISOControl)) throw new IllegalArgumentException();
                enqueue(c, () -> eventEngagement(c, engagement));
            } else if (type.equals("directConversationRequest")) {
                DirectConversationRequest request = json.treeToValue(node, DirectConversationRequest.class);
                if (request.epoch() < 1 || request.requestId() == null
                    || !request.requestId().matches("[A-Za-z0-9_-]{1,64}")
                    || request.targetPlayerId() == null || request.targetPlayerId().length() > 36)
                    throw new IllegalArgumentException();
                enqueue(c, () -> requestDirectConversation(c, request));
            } else if (type.equals("groupConversationRequest")) {
                GroupConversationRequest request = json.treeToValue(node, GroupConversationRequest.class);
                if (request.epoch() < 1 || request.requestId() == null
                    || !request.requestId().matches("[A-Za-z0-9_-]{1,64}")
                    || request.memberPlayerIds() == null || request.memberPlayerIds().size() < 2
                    || request.memberPlayerIds().size() > 11 || new HashSet<>(request.memberPlayerIds()).size() != request.memberPlayerIds().size()
                    || request.memberPlayerIds().stream().anyMatch(id -> id == null || id.length() > 36)
                    || request.groupName() == null || request.groupName().isBlank()
                    || request.groupName().codePointCount(0, request.groupName().length()) > 32
                    || request.groupName().chars().anyMatch(Character::isISOControl)) throw new IllegalArgumentException();
                enqueue(c, () -> requestGroupConversation(c, request));
            } else if (type.equals("groupInvitationRequest")) {
                GroupInvitationRequest request = json.treeToValue(node, GroupInvitationRequest.class);
                if (request.epoch() < 1 || request.requestId() == null
                    || !request.requestId().matches("[A-Za-z0-9_-]{1,64}")
                    || !validUuid(request.conversationId()) || request.targetPlayerId() == null
                    || request.targetPlayerId().length() > 36) throw new IllegalArgumentException();
                enqueue(c, () -> requestGroupInvitation(c, request));
            } else if (type.equals("directMessageMutationRequest")) {
                DirectMessageMutationRequest request = json.treeToValue(node, DirectMessageMutationRequest.class);
                if (request.epoch() < 1 || request.requestId() == null
                    || !request.requestId().matches("[A-Za-z0-9_-]{1,64}")
                    || !validUuid(request.conversationId()) || !validUuid(request.messageId())
                    || !Set.of("EDIT", "DELETE").contains(request.action()) || request.text() == null
                    || request.text().codePointCount(0, request.text().length()) > 500
                    || request.text().chars().anyMatch(Character::isISOControl)
                    || ("DELETE".equals(request.action()) && !request.text().isEmpty())) throw new IllegalArgumentException();
                enqueue(c, () -> mutateDirectMessage(c, request));
            } else if (type.equals("directMessageReadRequest")) {
                DirectMessageReadRequest request = json.treeToValue(node, DirectMessageReadRequest.class);
                if (request.epoch() < 1 || request.requestId() == null
                    || !request.requestId().matches("[A-Za-z0-9_-]{1,64}")
                    || !validUuid(request.conversationId()) || !validUuid(request.messageId()))
                    throw new IllegalArgumentException();
                enqueue(c, () -> markDirectMessageRead(c, request));
            } else if (type.equals("chatSend")) {
                // Existing v2 clients do not send a conversation ID for nearby/room messages.
                // Normalize that public-channel payload before strict record deserialization.
                if (!node.has("conversationId") && node.isObject())
                    ((com.fasterxml.jackson.databind.node.ObjectNode)node).put("conversationId", "");
                ChatSend chat = json.treeToValue(node, ChatSend.class);
                if (chat.clientMessageId() == null || !chat.clientMessageId().matches("[A-Za-z0-9_-]{1,64}")
                    || chat.epoch() < 1 || !Set.of("nearby", "room", "space", "dm").contains(chat.channel())
                    || chat.conversationId() == null || chat.conversationId().length() > 36
                    || ("dm".equals(chat.channel()) ? !validUuid(chat.conversationId()) : !chat.conversationId().isEmpty())
                    || chat.text() == null || chat.text().isBlank() || chat.text().codePointCount(0, chat.text().length()) > 500
                    || chat.text().chars().anyMatch(Character::isISOControl)) throw new IllegalArgumentException();
                enqueue(c, () -> chat(c, chat));
            } else if(type.equals("mediaRequest")) {
                var request=json.treeToValue(node,MediaRequest.class);
                if(request.requestId()==null||!request.requestId().matches("[A-Za-z0-9-]{1,64}")||request.policyEpoch()<1||request.dataJson()==null||request.dataJson().length()>32768||!Set.of("capabilities","createTransport","connectTransport","produce","closeProducer","consume","resumeConsumer","closeConsumer","setPreferredLayers","stats").contains(request.method()))throw new IllegalArgumentException();
                enqueue(c,()->mediaRequest(c,request));
            } else throw new IllegalArgumentException();
        } catch (Exception e) { fail(c, "INVALID_MESSAGE", "지원하지 않는 요청입니다. 다시 접속하세요."); }
    }
    private void enqueue(Connection c, Runnable command) {
        if (!offerCommand(command)) fail(c, "BUSY", "서버가 바쁩니다. 다시 접속하세요.");
    }
    private void enqueueJoin(Connection c, Runnable command) {
        if (!offerJoinCommand(command)) fail(c, "BUSY", "서버가 바쁩니다. 다시 접속하세요.");
    }
    private boolean offerCommand(Runnable command) {
        boolean accepted = commands.offer(command);
        if (!accepted) metrics.recordRejectedCommand();
        return accepted;
    }
    private boolean offerJoinCommand(Runnable command) {
        boolean accepted = joinCommands.offer(command);
        if (!accepted) metrics.recordRejectedJoinCommand();
        return accepted;
    }
    private void updateProfile(Connection c, ProfileUpdate request, String bio, List<String> links) {
        Player player = c.player;
        long now = System.currentTimeMillis();
        if (player == null || player.connection != c || player.epoch != request.epoch() || now < player.nextProfileUpdateAt) return;
        player.name = request.name().strip();
        player.avatar = request.avatar();
        player.skin = request.skin();
        player.clothing = request.clothing();
        player.hair = request.hair();
        player.bio = bio;
        player.links = List.copyOf(links);
        player.nextProfileUpdateAt = now + 1000;
    }
    private void join(Connection c, Join request) { join(c, request, null); }
    private void join(Connection c, Join request, JoinTickets.Ownership ownership) {
        if (!connections.containsKey(c.session.getId())) { queueOwnershipRelease(ownership); releaseAdmission(c); return; }
        long joinPhaseStarted = System.nanoTime();
        String resumeToken = request.resumeToken().isEmpty()
            ? c.admission == null ? "" : c.admission.resumeToken() : request.resumeToken();
        Player p = resumeToken.isEmpty() ? null : resumable.get(resumeToken);
        if (p == null) {
            // Reject guaranteed capacity failures before map preparation or a
            // distributed seat claim. Keep the later checks for async races.
            if (spacePlayerCounts.getOrDefault(c.spaceId, 0) >= c.capacity) {
                metrics.recordJoinPhase("capacity_reject", System.nanoTime() - joinPhaseStarted);
                queueOwnershipRelease(ownership); releaseAdmission(c);
                fail(c, "FULL", "공간이 가득 찼어요. 잠시 후 다시 접속해 주세요."); return;
            }
            if (players.size() >= 300) {
                metrics.recordJoinPhase("capacity_reject", System.nanoTime() - joinPhaseStarted);
                queueOwnershipRelease(ownership); releaseAdmission(c);
                fail(c, "BUSY", "서버가 바쁩니다. 잠시 후 다시 접속해 주세요."); return;
            }
        }
        var published = c.map == null ? new PublishedMaps.Published(0, defaultMap) : c.map;
        String roomId = roomId(c.spaceId,c.mapId);
        updateMap(roomId, published);
        MapDefinition map = roomMaps.get(roomId).map();
        metrics.recordJoinPhase("map_prepare", System.nanoTime() - joinPhaseStarted);
        if (p != null && (!Objects.equals(p.ownerSessionId, c.ownerSessionId) || !p.spaceId.equals(c.spaceId))) {
            queueOwnershipRelease(ownership); releaseAdmission(c); fail(c, "AUTH_REQUIRED", "이전 접속을 복원할 수 없어요. 다시 입장해 주세요."); return;
        }
        if (p != null && c.admission != null && !Objects.equals(p.seatId, c.admission.seatId())) {
            queueOwnershipRelease(ownership); releaseAdmission(c); fail(c, "AUTH_REQUIRED", "재접속 자리가 만료되었어요. 다시 입장해 주세요."); return;
        }
        if (p == null && c.principal != null && c.pendingResumeToken == null)
            c.pendingResumeToken = resumeToken.isEmpty() ? newResumeToken() : resumeToken;
        if (c.admission != null && c.principal != null && ownership == null) {
            claimSeatAsync(c, request, p == null ? c.pendingResumeToken : p.token);
            return;
        }
        if (p != null && p.connection != null && !p.connection.closed
            && (ownership == null || !ownership.newlyClaimed())) {
            queueOwnershipRelease(ownership); releaseAdmission(c); fail(c, "ALREADY_CONNECTED", "이 접속은 다른 탭에서 사용 중입니다."); return;
        }
        if (ownership != null && (c.admission == null || !ownership.spaceId().equals(c.spaceId)
            || !ownership.seatId().equals(c.admission.seatId()))) {
            queueOwnershipRelease(ownership); releaseAdmission(c);
            fail(c, "AUTH_REQUIRED", "재접속 좌석을 확인할 수 없어요. 다시 입장해 주세요."); return;
        }
        joinPhaseStarted = System.nanoTime();
        if (p == null) {
            if (spacePlayerCounts.getOrDefault(c.spaceId, 0) >= c.capacity) { queueOwnershipRelease(ownership); releaseAdmission(c); fail(c, "FULL", "공간이 가득 찼어요. 잠시 후 다시 접속해 주세요."); return; }
            if (players.size() >= 300) { queueOwnershipRelease(ownership); releaseAdmission(c); fail(c, "BUSY", "서버가 바쁩니다. 잠시 후 다시 접속해 주세요."); return; }
            double spawnX = map.spawnX(), spawnY = map.spawnY();
            if (c.admission != null && safeAdmissionSpawn(map, c.admission.spawnX(), c.admission.spawnY())) {
                spawnX = c.admission.spawnX(); spawnY = c.admission.spawnY();
            }
            p = new Player(c.principal == null ? newResumeToken() : c.pendingResumeToken,
                c.principal == null ? request.name().strip() : c.principal.displayName(),
                c.principal == null ? request.avatar() : c.principal.avatar(),
                c.principal == null ? request.skin() : c.principal.skin(),
                c.principal == null ? request.clothing() : c.principal.clothing(),
                c.principal == null ? request.hair() : c.principal.hair(),
                c.principal == null ? "" : c.principal.bio(),
                c.principal == null ? List.of() : c.principal.links(),
                spawnX, spawnY, c.guest || c.principal == null ? "" : c.principal.userId(),
                c.principal == null ? "" : c.principal.userId(), c.ownerSessionId, c.spaceId,c.mapId);
            p.moderationSubjectId = moderationSubject(c, p);
            if (c.principal != null) p.allowPokes = !c.guest && c.principal.allowPokes();
            if (c.admission != null) p.seatId = c.admission.seatId();
            players.put(p.id, p); spacePlayerCounts.merge(p.spaceId, 1, Integer::sum); resumable.put(p.token, p);
            recordAnalytics(ProductAnalytics.Metric.SPACE_JOINED);
        }
        if (p.connection != null && p.connection != c) {
            Connection previous = p.connection;
            previous.player = null;
            previous.joinRequested = true;
            previous.input.set(null);
            markEventLeave(p);
            p.microphoneOn = false;
            fail(previous, "WORLD_OWNER_LOST", "다른 탭에서 이 참가자로 접속해 연결을 넘겼어요.");
            p.connection = null;
        }
        boolean movedMap = !p.mapId.equals(c.mapId);
        JoinTransfer joinTransfer = p.joinTransfer;
        boolean hasJoinTransferSpawn = movedMap && joinTransfer != null
            && joinTransfer.mapId.equals(c.mapId) && System.currentTimeMillis() < joinTransfer.expiresAt
            && safeAdmissionSpawn(map, joinTransfer.x, joinTransfer.y);
        if (movedMap) {
            markEventLeave(p);
            p.mapId = c.mapId;
            p.worldRoomId = roomId(p.spaceId, p.mapId);
        }
        boolean hasAdmissionSpawn = c.admission != null
            && safeAdmissionSpawn(map, c.admission.spawnX(), c.admission.spawnY());
        if (hasJoinTransferSpawn) {
            p.x = joinTransfer.x; p.y = joinTransfer.y;
        } else if (hasAdmissionSpawn) {
            p.x = c.admission.spawnX(); p.y = c.admission.spawnY();
        } else if (movedMap && !Movement.canStand(map, p.x, p.y)) {
            p.x = map.spawnX(); p.y = map.spawnY();
        }
        p.joinTransfer = null;
        if (ownership != null) {
            p.ownerNodeId = ownership.nodeId(); p.ownershipFence = ownership.fence();
            p.ownershipLeaseDeadlineNanos = ownership.leaseDeadlineNanos();
        }
        p.epoch++; p.connection = c; p.detachedAt = 0; p.ackSeq = -1; p.move = null; p.microphoneOn = false;
        p.manager = !c.guest && (c.principal == null || p.ownerUserId.isBlank());
        p.mediaEpoch++;p.barrier=null;p.lastMediaState="";
        c.player = p;
        c.admissionReleased = true;
        c.pendingResumeToken = null;
        markEventAttendance(p, System.currentTimeMillis());
        resetSnapshotState(c);
        loadUserBlocks(p, c);
        loadUserModeration(p, c);
        loadSpaceAccess(p, c);
        metrics.recordJoinPhase("player_attach", System.nanoTime() - joinPhaseStarted);
        joinPhaseStarted = System.nanoTime();
        sendMapChanged(c, roomId, published);
        control(c, new Welcome("welcome", 2, p.id, p.token, p.epoch, map.revision(), 50, worldFeatures()));
        // Membership fanout is batched once after this actor drains its command queue.
        // Sending the full participant list for every join makes a burst of N joins
        // repeatedly sort and serialize a growing list for all connected clients.
        sendEventState(c);
        sendEngagementState(c);
        String joinedZone = roomNoteZone(p);
        if (!joinedZone.isBlank() && privateZone(map, joinedZone) != null) {
            RoomRuntime room = roomRuntime(roomId(p), joinedZone);
            if (room.recording != null) control(c, roomRecordingMessage(room.recording));
        }
        metrics.recordJoinPhase("initial_messages", System.nanoTime() - joinPhaseStarted);
    }
    static boolean safeAdmissionSpawn(MapDefinition map, double x, double y) {
        if (!Movement.canStand(map, x, y)) return false;
        return map.zones() == null || map.zones().stream().filter(Objects::nonNull)
            .filter(zone -> Movement.inside(zone.bounds(), x, y))
            .noneMatch(zone -> "PRIVATE".equals(zone.kind()));
    }
    private void loadUserBlocks(Player player, Connection connection) {
        player.blockDataReady = userBlockStore == null || player.ownerUserId.isBlank();
        player.blockLoadComplete = player.blockDataReady;
        player.blockedUserIds.clear();
        player.lastBlockState = null;
        if (player.blockDataReady) return;
        boolean queued = userBlockStore.load(player.ownerUserId, result -> {
            Runnable completed = () -> {
                if (player.connection != connection) return;
                if (!result.ok()) {
                    fail(connection, "BLOCKS_UNAVAILABLE", "차단 설정을 불러오지 못했어요. 다시 접속해 주세요.");
                    return;
                }
                player.blockedUserIds.addAll(result.blockedUserIds());
                applyPokePreference(player, result.allowPokes());
                player.blockDataReady = true;
                player.blockLoadComplete = true;
                player.lastBlockState = null;
                for (Player accountSession : players.values()) {
                    if (accountSession == player || !accountSession.ownerUserId.equals(player.ownerUserId)) continue;
                    accountSession.blockedUserIds.clear();
                    accountSession.blockedUserIds.addAll(result.blockedUserIds());
                    applyPokePreference(accountSession, result.allowPokes());
                    accountSession.blockDataReady = true;
                    accountSession.blockLoadComplete = true;
                    accountSession.lastBlockState = null;
                }
            };
            if (!offerCommand(completed)) fail(connection, "BUSY", "서버가 바빠 차단 설정을 적용하지 못했어요.");
        });
        if (!queued) fail(connection, "BLOCKS_BUSY", "차단 설정을 불러오는 요청이 많아요. 잠시 후 다시 접속해 주세요.");
    }
    private void loadUserModeration(Player player, Connection connection) {
        player.moderationDataReady = userModerationStore == null || player.moderationSubjectId.isBlank();
        if (player.moderationDataReady) return;
        boolean queued = userModerationStore.load(player.moderationSubjectId, result -> {
            Runnable completed = () -> {
                if (player.connection != connection) return;
                if (!result.ok()) {
                    ejectUser(player.moderationSubjectId, "AUTH_REQUIRED", "계정 상태를 확인할 수 없어 접속을 종료했어요.");
                    return;
                }
                applyUserModerationState(player.moderationSubjectId, result.state());
            };
            if (!offerCommand(completed)) fail(connection, "BUSY", "운영 조치를 확인하지 못했어요. 다시 접속해 주세요.");
        });
        if (!queued) fail(connection, "MODERATION_BUSY", "운영 조치를 확인할 수 없어요. 잠시 후 다시 접속해 주세요.");
    }
    private static String moderationSubject(Connection connection, Player player) {
        if (!player.ownerUserId.isBlank()) return "user:" + player.ownerUserId;
        if (connection.guest && connection.principal != null) return "guest:" + connection.principal.userId();
        return "";
    }
    private void loadSpaceAccess(Player player, Connection connection) {
        player.spaceAccessReady = spaceAccessStore == null || player.ownerUserId.isBlank();
        if (player.spaceAccessReady) return;
        var key = new SpaceAccessStore.Key(player.ownerUserId, player.spaceId);
        boolean queued = spaceAccessStore.load(key, result -> {
            Runnable completed = () -> {
                if (player.connection != connection) return;
                if (!result.ok() || !result.allowed()) {
                    ejectSpace(player.ownerUserId, player.spaceId,
                        result.ok() ? "SPACE_ACCESS_REVOKED" : "SPACE_ACCESS_UNAVAILABLE",
                        result.ok() ? "공간 입장 권한이 없어 접속을 종료했어요." : "공간 권한을 확인할 수 없어 접속을 종료했어요.");
                    return;
                }
                applySpaceAccessState(key, result);
            };
            if (!offerCommand(completed)) fail(connection, "BUSY", "공간 권한을 적용하지 못했어요. 다시 접속해 주세요.");
        });
        if (!queued) fail(connection, "SPACE_ACCESS_BUSY", "공간 권한을 확인할 수 없어요. 잠시 후 다시 접속해 주세요.");
    }
    private void applySpaceAccessState(SpaceAccessStore.Key key, SpaceAccessStore.Access state) {
        if (!state.ok() || !state.allowed()) {
            ejectSpace(key.userId(), key.spaceId(), state.ok() ? "SPACE_ACCESS_REVOKED" : "SPACE_ACCESS_UNAVAILABLE",
                state.ok() ? "공간 입장 권한이 없어 접속을 종료했어요." : "공간 권한을 확인할 수 없어 접속을 종료했어요.");
            return;
        }
        for (Player player : players.values())
            if (player.ownerUserId.equals(key.userId()) && player.spaceId.equals(key.spaceId())) {
                player.manager = state.manager();
                player.spaceAccessReady = true;
            }
    }
    private void ejectSpace(String userId, String spaceId, String code, String message) {
        for (Player player : new ArrayList<>(players.values())) {
            if (!player.ownerUserId.equals(userId) || !player.spaceId.equals(spaceId)) continue;
            removeTrackedPlayer(player);
            resumable.remove(player.token, player);
            queueSeatRelease(player);
            Connection connection = player.connection;
            player.connection = null;
            if (connection != null) {
                connection.player = null;
                connection.joinRequested = true;
                connection.input.set(null);
                fail(connection, code, message);
            }
        }
    }
    private void refreshSpaceAccess(long wall) {
        if (spaceAccessStore == null || spaceAccessRefreshPending || wall < nextSpaceAccessRefreshAt) return;
        Set<SpaceAccessStore.Key> active = new HashSet<>();
        for (Player player : players.values())
            if (player.connection != null && !player.connection.closed && !player.ownerUserId.isBlank())
                active.add(new SpaceAccessStore.Key(player.ownerUserId, player.spaceId));
        if (active.isEmpty()) { nextSpaceAccessRefreshAt = wall + 500; return; }
        spaceAccessRefreshPending = true;
        nextSpaceAccessRefreshAt = wall + 500;
        boolean queued = spaceAccessStore.loadMany(active, result -> {
            boolean accepted = offerCommand(() -> {
                spaceAccessRefreshPending = false;
                if (!result.ok()) {
                    for (SpaceAccessStore.Key key : active)
                        ejectSpace(key.userId(), key.spaceId(), "SPACE_ACCESS_UNAVAILABLE", "공간 권한을 확인할 수 없어 접속을 종료했어요.");
                    nextSpaceAccessRefreshAt = System.currentTimeMillis() + 1000;
                    return;
                }
                result.access().forEach(this::applySpaceAccessState);
            });
            if (!accepted) {
                spaceAccessRefreshPending = false;
                nextSpaceAccessRefreshAt = System.currentTimeMillis() + 250;
            }
        });
        if (!queued) {
            spaceAccessRefreshPending = false;
            nextSpaceAccessRefreshAt = wall + 500;
        }
    }
    private void applyUserModerationState(String userId, UserModerationStore.UserState state) {
        long now = System.currentTimeMillis();
        if (state.blockedUntil() > now) {
            ejectUser(userId, "MODERATION_KICKED", "운영 조치로 "
                + java.time.Instant.ofEpochMilli(state.blockedUntil()).toString() + "까지 입장할 수 없어요.");
            return;
        }
        for (Player player : players.values()) {
            if (!player.moderationSubjectId.equals(userId)) continue;
            if (!player.moderatedSources.equals(state.mutedSources())) {
                player.moderatedSources.clear();
                player.moderatedSources.addAll(state.mutedSources());
                if (player.moderatedSources.contains(MediaPolicy.Source.MICROPHONE))
                    player.microphoneOn = false;
                player.mediaEpoch++;
                player.lastMediaState = "";
            }
            player.chatMutedUntil = state.chatMutedUntil();
            player.moderationDataReady = true;
        }
    }
    private void ejectUser(String userId, String code, String message) {
        for (Player player : new ArrayList<>(players.values())) {
            if (!player.moderationSubjectId.equals(userId)) continue;
            removeTrackedPlayer(player);
            resumable.remove(player.token, player);
            queueSeatRelease(player);
            Connection connection = player.connection;
            player.connection = null;
            if (connection != null) {
                connection.player = null;
                connection.joinRequested = true;
                connection.input.set(null);
                fail(connection, code, message);
            }
        }
    }
    private void refreshUserModeration(long wall) {
        if (userModerationStore == null || moderationRefreshPending || wall < nextModerationRefreshAt) return;
        Set<String> activeUsers = new HashSet<>();
        for (Player player : players.values())
            if (player.connection != null && !player.connection.closed && !player.moderationSubjectId.isBlank())
                activeUsers.add(player.moderationSubjectId);
        if (activeUsers.isEmpty()) { nextModerationRefreshAt = wall + 500; return; }
        moderationRefreshPending = true;
        nextModerationRefreshAt = wall + 500;
        boolean queued = userModerationStore.loadMany(activeUsers, result -> {
            boolean accepted = offerCommand(() -> {
                moderationRefreshPending = false;
                if (!result.ok()) {
                    for (String subjectId : activeUsers)
                        ejectUser(subjectId, "MODERATION_UNAVAILABLE", "운영 조치 상태를 확인할 수 없어 접속을 종료했어요.");
                    nextModerationRefreshAt = System.currentTimeMillis() + 1000;
                    return;
                }
                result.users().forEach((subjectId, state) -> {
                    if (state.ok()) applyUserModerationState(subjectId, state.state());
                    else ejectUser(subjectId, "AUTH_REQUIRED", "계정 상태를 확인할 수 없어 접속을 종료했어요.");
                });
            });
            if (!accepted) {
                moderationRefreshPending = false;
                nextModerationRefreshAt = System.currentTimeMillis() + 250;
            }
        });
        if (!queued) {
            moderationRefreshPending = false;
            nextModerationRefreshAt = wall + 500;
        }
    }
    private void refreshUserBlocks(long wall) {
        if (userBlockStore == null) return;
        Set<String> activeUsers = new HashSet<>();
        for (Player player : players.values())
            if (player.connection != null && !player.connection.closed && player.blockLoadComplete
                && !player.ownerUserId.isBlank()) activeUsers.add(player.ownerUserId);
        blockRefreshAt.keySet().retainAll(activeUsers);
        pendingBlockRefresh.retainAll(activeUsers);
        for (String userId : activeUsers) {
            if (pendingBlockRefresh.contains(userId) || wall < blockRefreshAt.getOrDefault(userId, wall)) continue;
            blockRefreshAt.put(userId, wall + 5000);
            pendingBlockRefresh.add(userId);
            boolean queued = userBlockStore.load(userId, result -> {
                boolean accepted = offerCommand(() -> {
                    pendingBlockRefresh.remove(userId);
                    if (!result.ok()) {
                        blockRefreshAt.put(userId, System.currentTimeMillis() + 2000);
                        for (Player session : players.values())
                            if (session.ownerUserId.equals(userId) && session.connection != null)
                                session.blockDataReady = false;
                        return;
                    }
                    for (Player session : players.values()) {
                        if (!session.ownerUserId.equals(userId)) continue;
                        session.blockedUserIds.clear();
                        session.blockedUserIds.addAll(result.blockedUserIds());
                        applyPokePreference(session, result.allowPokes());
                        session.blockDataReady = true;
                        session.blockLoadComplete = true;
                        session.lastBlockState = null;
                    }
                });
                if (!accepted) pendingBlockRefresh.remove(userId);
            });
            if (!queued) {
                pendingBlockRefresh.remove(userId);
                blockRefreshAt.put(userId, wall + 1000);
            }
        }
    }
    private void publishBlockState(Player viewer) {
        if (viewer.connection == null || viewer.connection.closed || !viewer.blockDataReady) return;
        if (viewer.blockedUserIds.isEmpty()) {
            if (!Objects.equals(viewer.lastBlockState, "")) {
                viewer.lastBlockState = "";
                control(viewer.connection, new BlockState("blockState", List.of()));
            }
            return;
        }
        List<String> playerIds = players.values().stream()
            .filter(target -> target.connection != null && !target.connection.closed
                && target.spaceId.equals(viewer.spaceId))
            .filter(target -> !target.ownerUserId.isBlank() && viewer.blockedUserIds.contains(target.ownerUserId))
            .map(target -> target.id).sorted().toList();
        String signature = String.join(",", playerIds);
        if (!Objects.equals(signature, viewer.lastBlockState)) {
            viewer.lastBlockState = signature;
            control(viewer.connection, new BlockState("blockState", playerIds));
        }
    }
    private void applyPokePreference(Player player, boolean enabled) {
        if (player.allowPokes == enabled) return;
        player.allowPokes = enabled;
        if (player.connection != null && !player.connection.closed)
            control(player.connection, new PokePreferenceState("pokePreferenceState", enabled));
    }
    private boolean blockedEither(Player first, Player second) {
        return !first.ownerUserId.isBlank() && !second.ownerUserId.isBlank()
            && (first.blockedUserIds.contains(second.ownerUserId)
                || second.blockedUserIds.contains(first.ownerUserId));
    }
    private void block(Connection c, BlockAction request) {
        Player sender = c.player;
        if (sender == null || sender.connection != c) return;
        if (sender.epoch != request.epoch() || sender.barrier != null) {
            blockAck(c, request, false, "BLOCK_STALE", "공간을 옮기는 중이라 설정을 바꾸지 못했어요.");
            return;
        }
        if (userBlockStore == null || sender.ownerUserId.isBlank()) {
            blockAck(c, request, false, "BLOCK_UNAVAILABLE", "로그인한 계정에서만 차단 설정을 저장할 수 있어요.");
            return;
        }
        if (!sender.blockDataReady) {
            blockAck(c, request, false, "BLOCKS_LOADING", "차단 설정을 불러오는 중이에요. 잠시 후 다시 시도해 주세요.");
            return;
        }
        Player target = players.get(request.targetId());
        if (target == null || target == sender || target.connection == null || target.connection.closed
            || target.barrier != null || !target.spaceId.equals(sender.spaceId)
            || target.ownerUserId.isBlank() || target.ownerUserId.equals(sender.ownerUserId)) {
            blockAck(c, request, false, "BLOCK_TARGET_UNAVAILABLE", "같은 공간에 있는 다른 계정만 차단할 수 있어요.");
            return;
        }
        if (!sender.pendingBlockUserIds.add(target.ownerUserId)) {
            blockAck(c, request, false, "BLOCK_BUSY", "해당 참가자의 차단 설정을 처리 중이에요.");
            return;
        }
        boolean queued = userBlockStore.set(sender.ownerUserId, target.ownerUserId, target.name, request.blocked(), result -> {
            Runnable completed = () -> {
                sender.pendingBlockUserIds.remove(target.ownerUserId);
                if (!result.ok()) {
                    if (sender.connection == c && sender.epoch == request.epoch() && result.limitExceeded()) {
                        blockAck(c, request, false, "BLOCK_LIMIT", "차단 목록은 500명까지 저장할 수 있어요.");
                        return;
                    }
                    if (sender.connection == c && sender.epoch == request.epoch())
                        blockAck(c, request, false, "BLOCK_STORAGE_UNAVAILABLE", "차단 설정을 저장하지 못했어요. 다시 시도해 주세요.");
                    return;
                }
                for (Player accountSession : players.values()) {
                    if (!accountSession.ownerUserId.equals(sender.ownerUserId) || !accountSession.blockDataReady) continue;
                    if (request.blocked()) accountSession.blockedUserIds.add(target.ownerUserId);
                    else accountSession.blockedUserIds.remove(target.ownerUserId);
                    accountSession.lastBlockState = null;
                }
                if (sender.connection == c && sender.epoch == request.epoch())
                    blockAck(c, request, true, "", request.blocked()
                        ? target.name + "님을 차단했어요. 채팅과 가까운 통화에서 제외돼요."
                        : target.name + "님의 차단을 해제했어요.");
            };
            if (!offerCommand(completed)) {
                sender.pendingBlockUserIds.remove(target.ownerUserId);
                Connection current = sender.connection;
                if (current != null) fail(current, "BUSY", "차단 결과를 적용하지 못했어요. 다시 접속해 주세요.");
            }
        });
        if (!queued) {
            sender.pendingBlockUserIds.remove(target.ownerUserId);
            blockAck(c, request, false, "BLOCK_BUSY", "차단 저장 요청이 많아요. 잠시 후 다시 시도해 주세요.");
        }
    }
    private void blockAck(Connection c, BlockAction request, boolean accepted, String code, String message) {
        control(c, new BlockAck("blockAck", request.requestId(), request.targetId(), request.blocked(), accepted, code, message));
    }
    private void reportPlayer(Connection c, PlayerReportRequest request, String details) {
        Player reporter = c.player;
        if (reporter == null || reporter.connection != c || c.closed) return;
        if (reporter.epoch != request.epoch() || reporter.barrier != null) {
            playerReportAck(c, request, false, "REPORT_STALE", "공간을 옮기는 중이라 신고를 접수하지 못했어요.");
            return;
        }
        if (userReportStore == null || reporter.ownerUserId.isBlank()) {
            playerReportAck(c, request, false, "REPORT_LOGIN_REQUIRED", "로그인한 계정에서만 참가자를 신고할 수 있어요.");
            return;
        }
        Player target = players.get(request.targetId());
        boolean guestTarget = target != null && target.moderationSubjectId.startsWith("guest:");
        if (target == null || target == reporter || target.connection == null || target.connection.closed
            || target.barrier != null || !target.spaceId.equals(reporter.spaceId)
            || (target.ownerUserId.isBlank() && !guestTarget)
            || (!target.ownerUserId.isBlank() && target.ownerUserId.equals(reporter.ownerUserId))
            || reporter.moderationSubjectId.equals(target.moderationSubjectId)) {
            playerReportAck(c, request, false, "REPORT_TARGET_UNAVAILABLE", "같은 공간에 있는 다른 참가자만 신고할 수 있어요.");
            return;
        }
        String targetUserId = target.ownerUserId.isBlank() ? null : target.ownerUserId;
        String targetGuestId = guestTarget ? target.moderationSubjectId.substring("guest:".length()) : null;
        long now = System.currentTimeMillis();
        if (now < reporter.nextPlayerReportAt) {
            playerReportAck(c, request, false, "REPORT_COOLDOWN", "잠시 기다렸다가 다시 신고해 주세요.");
            return;
        }
        reporter.nextPlayerReportAt = now + 3000;
        if (!reporter.pendingReportedUserIds.add(target.moderationSubjectId)) {
            playerReportAck(c, request, false, "REPORT_BUSY", "해당 참가자의 신고를 처리 중이에요.");
            return;
        }
        boolean queued = userReportStore.create(reporter.ownerUserId, reporter.name, targetUserId, targetGuestId,
            target.name, reporter.spaceId, request.category(), details, result -> {
                Runnable completed = () -> {
                    reporter.pendingReportedUserIds.remove(target.moderationSubjectId);
                    if (reporter.connection == c && reporter.epoch == request.epoch())
                        playerReportAck(c, request, result.accepted(), result.code(), result.message());
                };
                if (!offerCommand(completed)) {
                    reporter.pendingReportedUserIds.remove(target.moderationSubjectId);
                    if (reporter.connection == c) fail(c, "BUSY", "신고 결과를 전달하지 못했어요. 다시 접속해 주세요.");
                }
            });
        if (!queued) {
            reporter.pendingReportedUserIds.remove(target.moderationSubjectId);
            playerReportAck(c, request, false, "REPORT_BUSY", "신고 요청이 많아요. 잠시 후 다시 시도해 주세요.");
        }
    }
    private void playerReportAck(Connection c, PlayerReportRequest request, boolean accepted, String code, String message) {
        control(c, new PlayerReportAck("playerReportAck", request.requestId(), request.targetId(), accepted, code, message));
    }
    private void setPresence(Connection c, PresenceSet request) {
        Player player = c.player;
        if (player == null || player.connection != c) return;
        if (player.epoch != request.epoch() || player.barrier != null) {
            presenceAck(c, request, false, "PRESENCE_STALE", "공간을 옮기는 중이라 상태를 바꾸지 못했어요.");
            return;
        }
        long now = System.currentTimeMillis();
        if (now < player.nextPresenceAt) {
            presenceAck(c, request, false, "PRESENCE_COOLDOWN", "상태를 너무 자주 바꾸고 있어요. 잠시 후 다시 시도해 주세요.");
            return;
        }
        player.nextPresenceAt = now + 750;
        if (!player.status.equals(request.status())) {
            player.status = request.status();
            if (!"AVAILABLE".equals(player.status)) player.microphoneOn = false;
            player.mediaEpoch++;
            player.lastMediaState = "";
            if (!"AVAILABLE".equals(player.status)) emitMedia(player, null, false, false);
            media.revoke(player.id, player.mediaEpoch, () -> {});
        }
        String message = switch (request.status()) {
            case "AWAY" -> "자리 비움으로 설정했어요. 근거리 통화와 찌르기가 꺼져요.";
            case "DND" -> "방해 금지로 설정했어요. 채팅은 계속 받을 수 있어요.";
            default -> "온라인 상태로 설정했어요.";
        };
        presenceAck(c, request, true, "", message);
        publishDndPresenceSnapshot();
    }
    private void setMicrophone(Connection c, MicrophoneSet request) {
        Player player = c.player;
        if (player == null || player.connection != c || player.epoch != request.epoch() || player.barrier != null) return;
        player.microphoneOn = request.enabled() && "AVAILABLE".equals(player.status)
            && !player.moderatedSources.contains(MediaPolicy.Source.MICROPHONE);
    }
    private void presenceAck(Connection c, PresenceSet request, boolean accepted, String code, String message) {
        control(c, new PresenceAck("presenceAck", request.requestId(), request.status(), accepted, code, message));
    }
    private void requestJoin(Connection c, JoinRequest request) {
        Player requester = c.player;
        if (requester == null || requester.connection != c || c.closed) return;
        if (requester.epoch != request.epoch() || requester.barrier != null) {
            joinRequestAck(c, request, false, "JOIN_STALE", "공간을 옮기는 중이라 합류를 요청할 수 없어요.");
            return;
        }
        if (!requester.blockDataReady) {
            joinRequestAck(c, request, false, "JOIN_BLOCKS_LOADING", "차단 설정을 불러오는 중이에요.");
            return;
        }
        if (!"AVAILABLE".equals(requester.status)) {
            joinRequestAck(c, request, false, "JOIN_PRESENCE", "온라인 상태에서만 합류를 요청할 수 있어요.");
            return;
        }
        long now = System.currentTimeMillis();
        if (now < requester.nextJoinRequestAt) {
            joinRequestAck(c, request, false, "JOIN_COOLDOWN", "잠시 기다렸다가 다시 요청해 주세요.");
            return;
        }
        Player target = players.get(request.targetId());
        if (target == null || sameJoinIdentity(requester, target) || target.connection == null || target.connection.closed
            || target.barrier != null || requester.joinTransfer != null || !sameSpace(target, requester) || !target.blockDataReady) {
            joinRequestAck(c, request, false, "JOIN_UNAVAILABLE", "같은 공간에서 합류 가능한 참가자를 찾지 못했어요.");
            return;
        }
        if (!"AVAILABLE".equals(target.status)) {
            joinRequestAck(c, request, false, "JOIN_PRESENCE", "상대가 자리를 비웠거나 방해 금지 상태예요.");
            return;
        }
        if (blockedEither(requester, target)) {
            joinRequestAck(c, request, false, "JOIN_BLOCKED", "차단 설정 때문에 합류를 요청할 수 없어요.");
            return;
        }
        MapDefinition targetMap = roomMaps.get(roomId(target)).map();
        String targetZone = Movement.zoneAt(targetMap, target.x, target.y);
        Zone targetArea = targetMap.zones().stream().filter(zone -> zone.id().equals(targetZone)).findFirst().orElse(null);
        if (targetArea != null && "PRIVATE".equals(targetArea.kind())
            && (!sameWorld(target, requester) || !targetZone.equals(Movement.zoneAt(targetMap, requester.x, requester.y)))) {
            joinRequestAck(c, request, false, "JOIN_PRIVATE", "같은 회의실 안에 있는 사람에게만 합류를 요청할 수 있어요.");
            return;
        }
        if (joinRequests.containsKey(request.requestId()) || joinRequests.values().stream()
            .anyMatch(pending -> pending.requesterId().equals(requester.id))) {
            joinRequestAck(c, request, false, "JOIN_PENDING", "이미 처리 중인 합류 요청이 있어요.");
            return;
        }
        long requestsForTarget = joinRequests.values().stream()
            .filter(pending -> pending.targetId().equals(target.id)).count();
        if (requestsForTarget >= 4) {
            joinRequestAck(c, request, false, "JOIN_BUSY", "상대가 다른 합류 요청을 확인 중이에요.");
            return;
        }
        long expiresAt = now + 30_000;
        var pending = new PendingJoin(request.requestId(), requester.id, target.id,
            requester.spaceId, requester.mapId, target.spaceId, target.mapId,
            requester.epoch, target.epoch, expiresAt);
        joinRequests.put(request.requestId(), pending);
        requester.nextJoinRequestAt = now + 5_000;
        control(target.connection, new JoinRequestEvent("joinRequestEvent", request.requestId(), requester.id,
            requester.name, expiresAt));
        joinRequestAck(c, request, true, "", "합류 요청을 보냈어요. 상대의 응답을 기다려 주세요.");
    }
    private void requestProfileDetails(Connection c, ProfileRequest request) {
        Player requester = c.player;
        if (requester == null || requester.connection != c || c.closed) return;
        long now = System.currentTimeMillis();
        if (requester.epoch != request.epoch() || requester.barrier != null) {
            profileDetails(c, request, false, "PROFILE_STALE", "참가 상태가 바뀌어 프로필을 불러오지 못했어요.");
            return;
        }
        if (now < c.nextProfileReadAt) {
            profileDetails(c, request, false, "PROFILE_COOLDOWN", "잠시 기다렸다가 다시 열어 주세요.");
            return;
        }
        c.nextProfileReadAt = now + 250;
        Player target = players.get(request.targetId());
        if (target == null || target == requester || target.connection == null || target.connection.closed
            || !sameSpace(requester, target)) {
            profileDetails(c, request, false, "PROFILE_UNAVAILABLE", "같은 공간에서 프로필을 찾을 수 없어요.");
            return;
        }
        if (!requester.blockDataReady || !target.blockDataReady) {
            profileDetails(c, request, false, "PROFILE_BLOCKS_LOADING", "차단 설정을 확인하고 있어요. 잠시 후 다시 열어 주세요.");
            return;
        }
        if (blockedEither(requester, target)) {
            profileDetails(c, request, false, "PROFILE_BLOCKED", "차단 설정 때문에 프로필을 볼 수 없어요.");
            return;
        }
        profileDetails(c, request, true, "", "", target.bio, target.links);
    }
    private void profileDetails(Connection c, ProfileRequest request, boolean accepted, String code, String message) {
        profileDetails(c, request, accepted, code, message, "", List.of());
    }
    private void profileDetails(Connection c, ProfileRequest request, boolean accepted, String code, String message,
                                String bio, List<String> links) {
        control(c, new ProfileDetails("profileDetails", request.requestId(), request.targetId(), accepted,
            bio, List.copyOf(links), code, message));
    }
    private void respondToJoin(Connection c, JoinResponse response) {
        Player target = c.player;
        if (target == null || target.connection != c || c.closed) return;
        if (target.epoch != response.epoch() || target.barrier != null) return;
        PendingJoin pending = joinRequests.get(response.requestId());
        if (pending == null || !pending.targetId().equals(target.id)) return;
        joinRequests.remove(response.requestId());
        Player requester = players.get(pending.requesterId());
        if (requester == null || requester.connection == null || requester.connection.closed
            || requester.epoch != pending.requesterEpoch() || target.epoch != pending.targetEpoch()
            || sameJoinIdentity(requester, target)
            || !sameSpace(requester, target) || !requester.spaceId.equals(pending.requesterSpaceId())
            || !requester.mapId.equals(pending.requesterMapId()) || !target.spaceId.equals(pending.targetSpaceId())
            || !target.mapId.equals(pending.targetMapId()) || !requester.blockDataReady || !target.blockDataReady
            || !"AVAILABLE".equals(requester.status) || !"AVAILABLE".equals(target.status)
            || blockedEither(requester, target) || System.currentTimeMillis() >= pending.expiresAt()) {
            joinResult(requester, pending, false, false, "JOIN_EXPIRED", "요청이 만료되었거나 참가 상태가 바뀌었어요.");
            return;
        }
        if (!response.accepted()) {
            joinResult(requester, pending, false, false, "JOIN_DECLINED", target.name + "님이 합류 요청을 거절했어요.");
            return;
        }
        MapDefinition map = roomMaps.get(roomId(target)).map();
        String targetZone = Movement.zoneAt(map, target.x, target.y);
        Zone targetArea = map.zones().stream().filter(zone -> zone.id().equals(targetZone)).findFirst().orElse(null);
        if (targetArea != null && "PRIVATE".equals(targetArea.kind())
            && (!sameWorld(requester, target) || !targetZone.equals(Movement.zoneAt(map, requester.x, requester.y)))) {
            joinResult(requester, pending, false, false, "JOIN_PRIVATE", "비공개 회의실에는 합류할 수 없어요.");
            return;
        }
        Movement.Position destination = nearestJoinPosition(map, target, requester);
        if (destination == null) {
            joinResult(requester, pending, false, false, "JOIN_NO_SPACE", "상대 근처에 안전하게 합류할 자리가 없어요.");
            return;
        }
        if (!sameWorld(requester, target)) {
            requester.move = null;
            requester.moving = false;
            requester.connection.input.set(null);
            requester.joinTransfer = new JoinTransfer(target.mapId, destination.x(), destination.y(),
                System.currentTimeMillis() + 30_000, pending);
            if (media.enabled()) beginBarrier(requester, destination.x(), destination.y(), true);
            else {
                requester.joinTransfer.resultSent = true;
                joinResult(requester, pending, true, true, target.mapId, "", "승인되어 상대가 있는 지도로 이동해요.");
            }
            return;
        }
        String oldDomain = domain(map, requester, requester.x, requester.y);
        String newDomain = domain(map, requester, destination.x(), destination.y());
        requester.move = null;
        requester.moving = false;
        requester.connection.input.set(null);
        requester.direction = target.direction;
        if (media.enabled() && !oldDomain.equals(newDomain))
            beginBarrier(requester, destination.x(), destination.y(), false);
        else {
            requester.x = destination.x();
            requester.y = destination.y();
        }
        joinResult(requester, pending, true, true, "", "합류 요청이 승인되어 상대 근처로 이동했어요.");
    }
    private Movement.Position nearestJoinPosition(MapDefinition map, Player target, Player requester) {
        String targetZone = Movement.zoneAt(map, target.x, target.y);
        for (int ring = 1; ring <= 8; ring++) {
            for (int dx = -ring; dx <= ring; dx++) for (int dy = -ring; dy <= ring; dy++) {
                if (Math.max(Math.abs(dx), Math.abs(dy)) != ring) continue;
                double x = target.x + dx * .5, y = target.y + dy * .5;
                if (Math.hypot(x - target.x, y - target.y) < .5 || !Movement.canStand(map, x, y)
                    || !targetZone.equals(Movement.zoneAt(map, x, y))) continue;
                boolean occupied = players.values().stream().anyMatch(player -> player != target && player != requester
                    && player.connection != null && !player.connection.closed && sameWorld(player, target)
                    && joinPositionOccupied(player, x, y));
                if (!occupied) return new Movement.Position(x, y);
            }
        }
        return null;
    }
    private static boolean joinPositionOccupied(Player player, double x, double y) {
        if (Math.hypot(player.x - x, player.y - y) < .48) return true;
        MediaBarrier barrier = player.barrier;
        return barrier != null && !barrier.forMap && Math.hypot(barrier.x - x, barrier.y - y) < .48;
    }
    private void expireJoinRequests(long now) {
        var iterator = joinRequests.values().iterator();
        while (iterator.hasNext()) {
            PendingJoin pending = iterator.next();
            Player requester = players.get(pending.requesterId()), target = players.get(pending.targetId());
            boolean invalid = now >= pending.expiresAt() || requester == null || target == null
                || requester.connection == null || target.connection == null
                || requester.epoch != pending.requesterEpoch() || target.epoch != pending.targetEpoch();
            if (!invalid) continue;
            iterator.remove();
            joinResult(requester, pending, false, false, "JOIN_EXPIRED", "합류 요청이 만료되었어요.");
        }
    }
    private void joinRequestAck(Connection c, JoinRequest request, boolean accepted, String code, String message) {
        control(c, new JoinRequestAck("joinRequestAck", request.requestId(), request.targetId(), accepted, code, message));
    }
    private void joinResult(Player requester, PendingJoin pending, boolean accepted, boolean moved, String code, String message) {
        joinResult(requester, pending, accepted, moved, "", code, message);
    }
    private void joinResult(Player requester, PendingJoin pending, boolean accepted, boolean moved,
                            String destinationMapId, String code, String message) {
        if (requester != null && requester.connection != null && !requester.connection.closed)
            control(requester.connection, new JoinResult("joinResult", pending.requestId(), pending.targetId(),
                accepted, moved, destinationMapId, code, message));
    }
    private static String roomId(String spaceId,String mapId){return spaceId+"|"+mapId;}
    private static String roomId(Player player){return player.worldRoomId;}
    private static String[] splitWorldRoomId(String worldRoomId) {
        int separator = worldRoomId == null ? -1 : worldRoomId.indexOf('|');
        return separator < 0 ? new String[] { "", "" }
            : new String[] { worldRoomId.substring(0, separator), worldRoomId.substring(separator + 1) };
    }
    private static boolean sameSpace(Player left,Player right){return left.spaceId.equals(right.spaceId);}
    private static boolean sameWorld(Player left,Player right){return left.spaceId.equals(right.spaceId)&&left.mapId.equals(right.mapId);}
    static boolean sameAccountIdentity(String leftUserId, String rightUserId) {
        return leftUserId != null && !leftUserId.isBlank() && leftUserId.equals(rightUserId);
    }
    private static boolean sameJoinIdentity(Player left, Player right) {
        return left == right || sameAccountIdentity(left.ownerUserId, right.ownerUserId);
    }
    private RoomKey roomKey(String worldRoomId, String zoneId) { return new RoomKey(worldRoomId, zoneId); }
    private RoomRuntime roomRuntime(String worldRoomId, String zoneId) {
        return roomRuntimes.computeIfAbsent(roomKey(worldRoomId, zoneId), ignored -> {
            RoomRuntime state = new RoomRuntime();
            String[] parts = splitWorldRoomId(worldRoomId);
            state.spaceId = parts[0];
            state.mapId = parts[1];
            PublishedMaps.Published published = roomMaps.get(worldRoomId);
            Zone zone = published == null ? null : privateZone(published.map(), zoneId);
            if (zone != null && zone.capacity() != null && zone.capacity() >= 2 && zone.capacity() <= 100)
                state.capacity = zone.capacity().intValue();
            return state;
        });
    }
    private Zone privateZone(MapDefinition map, String zoneId) {
        for (Zone zone : map.zones())
            if (zone.id().equals(zoneId) && "PRIVATE".equals(zone.kind())) return zone;
        return null;
    }
    private boolean reserveRoomEntry(Player player, MapDefinition map, double x, double y, long wall) {
        String targetZoneId = Movement.zoneAt(map, x, y);
        Zone targetZone = privateZone(map, targetZoneId);
        if (targetZone == null || targetZoneId.equals(Movement.zoneAt(map, player.x, player.y))) return true;
        RoomRuntime state = roomRuntime(roomId(player), targetZoneId);
        expireRoomKnocks(state, targetZoneId, wall);
        Long reservationUntil = state.reservations.get(player.id);
        if (reservationUntil != null && reservationUntil > wall) return true;
        if (state.locked && !state.admitted.contains(player.id)) {
            if (state.knockCooldowns.getOrDefault(player.id, 0L) > wall) return false;
            boolean alreadyPending = state.knocks.values().stream().anyMatch(knock -> knock.knock().playerId().equals(player.id));
            if (!alreadyPending) {
                Player host = players.get(state.hostPlayerId);
                if (host == null || host.connection == null || host.connection.closed) {
                    state.knockCooldowns.put(player.id, wall + 1000);
                    roomKnockResult(player, UUID.randomUUID().toString(), targetZoneId, false, "ROOM_HOST_UNAVAILABLE", "회의실 호스트가 응답할 수 없어요.");
                    return false;
                }
                String knockId = UUID.randomUUID().toString();
                long expiresAt = wall + 20_000;
                RoomKnock knock = new RoomKnock(knockId, player.id, player.name, expiresAt);
                state.knocks.put(knockId, new PendingRoomKnock(knock));
                control(host.connection, new RoomKnockEvent("roomKnockEvent", knockId, targetZoneId, player.id, player.name, expiresAt));
                roomKnockResult(player, knockId, targetZoneId, false, "ROOM_KNOCKED", "회의실 호스트에게 입장 노크를 보냈어요.");
            }
            return false;
        }
        long reserved = state.reservations.entrySet().stream().filter(entry -> entry.getValue() > wall && !entry.getKey().equals(player.id)).count();
        if (!state.occupants.contains(player.id) && state.occupants.size() + reserved >= state.capacity) {
            roomKnockResult(player, UUID.randomUUID().toString(), targetZoneId, false, "ROOM_FULL", "회의실 정원이 가득 찼어요.");
            return false;
        }
        state.reservations.put(player.id, wall + 20_000);
        return true;
    }
    private void roomAction(Connection c, RoomAction request) {
        Player player = c.player;
        if (player == null || player.connection != c || c.closed) return;
        MapDefinition map = roomMaps.get(roomId(player)).map();
        if (privateZone(map, request.zoneId()) == null) {
            control(c, new RoomActionAck("roomActionAck", request.requestId(), request.zoneId(), false,
                false, 12, "ROOM_NOT_FOUND", "회의실을 찾을 수 없어요."));
            return;
        }
        RoomRuntime state = roomRuntime(roomId(player), request.zoneId());
        boolean valid = player.epoch == request.epoch() && player.barrier == null
            && request.zoneId().equals(Movement.zoneAt(map, player.x, player.y))
            && player.id.equals(state.hostPlayerId);
        if (!valid) {
            control(c, new RoomActionAck("roomActionAck", request.requestId(), request.zoneId(), false,
                state.locked, state.capacity, "ROOM_FORBIDDEN", "현재 회의실 호스트만 설정을 변경할 수 있어요."));
            return;
        }
        long now = System.currentTimeMillis();
        long reserved = state.reservations.values().stream().filter(expiresAt -> expiresAt > now).count();
        if ("SET_CAPACITY".equals(request.action()) && request.capacity() < state.occupants.size() + reserved) {
            control(c, new RoomActionAck("roomActionAck", request.requestId(), request.zoneId(), false,
                state.locked, state.capacity, "ROOM_CAPACITY_IN_USE", "현재 참가자와 승인된 입장 예약보다 정원을 낮출 수 없어요."));
            return;
        }
        if ("KICK".equals(request.action())) {
            Player target = players.get(request.targetPlayerId());
            if (target == null || target == player || !sameWorld(target, player)
                || !request.zoneId().equals(Movement.zoneAt(map, target.x, target.y)) || target.connection == null || target.barrier != null) {
                control(c, new RoomActionAck("roomActionAck", request.requestId(), request.zoneId(), false,
                    state.locked, state.capacity, "ROOM_MEMBER_UNAVAILABLE", "회의실 참가자를 찾을 수 없어요."));
                return;
            }
            Movement.Position exit = nearestPublicStand(map, request.zoneId(), target.x, target.y);
            if (exit == null) {
                control(c, new RoomActionAck("roomActionAck", request.requestId(), request.zoneId(), false,
                    state.locked, state.capacity, "ROOM_NO_EXIT", "회의실 밖에 이동할 수 있는 위치가 없어요."));
                return;
            }
            target.connection.input.set(null);
            target.move = null;
            target.moving = false;
            if (media.enabled()) beginBarrier(target, exit.x(), exit.y(), false);
            else { target.x = exit.x(); target.y = exit.y(); target.mediaEpoch++; target.lastMediaState = ""; }
            roomKnockResult(target, UUID.randomUUID().toString(), request.zoneId(), false,
                "ROOM_EJECTED", "회의실 호스트가 회의실에서 내보냈어요.");
        } else if ("LOCK".equals(request.action())) state.locked = true;
        else if ("UNLOCK".equals(request.action())) state.locked = false;
        else state.capacity = (int)request.capacity();
        control(c, new RoomActionAck("roomActionAck", request.requestId(), request.zoneId(), true,
            state.locked, state.capacity, "", "회의실 설정을 저장했어요."));
    }
    private void respondToRoomKnock(Connection c, RoomKnockResponse response) {
        Player host = c.player;
        if (host == null || host.connection != c || c.closed || host.epoch != response.epoch() || host.barrier != null) return;
        MapDefinition map = roomMaps.get(roomId(host)).map();
        if (privateZone(map, response.zoneId()) == null) return;
        RoomRuntime state = roomRuntime(roomId(host), response.zoneId());
        if (!response.zoneId().equals(Movement.zoneAt(map, host.x, host.y))
            || !host.id.equals(state.hostPlayerId)) return;
        PendingRoomKnock pending = state.knocks.remove(response.knockId());
        if (pending == null) return;
        Player guest = players.get(pending.knock.playerId());
        if (guest == null || !sameWorld(guest, host) || guest.connection == null || guest.connection.closed) return;
        long now = System.currentTimeMillis();
        if (!response.accepted()) {
            state.knockCooldowns.put(guest.id, now + 5000);
            roomKnockResult(guest, response.knockId(), response.zoneId(), false, "ROOM_DECLINED", "회의실 호스트가 입장을 거절했어요.");
            return;
        }
        long reserved = state.reservations.entrySet().stream().filter(entry -> entry.getValue() > now).count();
        if (!state.occupants.contains(guest.id) && state.occupants.size() + reserved >= state.capacity) {
            state.knockCooldowns.put(guest.id, now + 3000);
            roomKnockResult(guest, response.knockId(), response.zoneId(), false, "ROOM_FULL", "회의실 정원이 가득 차 입장할 수 없어요.");
            return;
        }
        state.knockCooldowns.remove(guest.id);
        state.admitted.add(guest.id);
        state.reservations.put(guest.id, now + 20_000);
        roomKnockResult(guest, response.knockId(), response.zoneId(), true, "ROOM_APPROVED", "입장이 승인됐어요. 문 쪽으로 이동해 주세요.");
    }
    private void roomKnockResult(Player player, String requestId, String zoneId, boolean accepted, String code, String message) {
        if ("ROOM_FULL".equals(code) || "ROOM_HOST_UNAVAILABLE".equals(code)) {
            RoomRuntime state = roomRuntime(roomId(player), zoneId);
            long now = System.currentTimeMillis();
            String key = player.id + ":" + code;
            long last = state.entryNoticeAt.getOrDefault(key, 0L);
            if (now - last < 1000) return;
            state.entryNoticeAt.put(key, now);
        }
        if (player.connection != null && !player.connection.closed)
            control(player.connection, new RoomKnockResult("roomKnockResult", requestId, zoneId, accepted, code, message));
    }
    private void roomNote(Connection c, RoomNoteRequest request) {
        Player player = c.player;
        String zoneId = roomNoteZone(player);
        if (!roomExtrasEnabled) {
            roomNoteAck(c, request, zoneId, false, request.baseRevision(), "ROOM_EXTRAS_DISABLED", "현재 회의실 공유 메모 기능은 사용할 수 없어요.");
            return;
        }
        if (!validRoomNoteParticipant(c, player, request.epoch(), zoneId)) {
            roomNoteAck(c, request, zoneId, false, 0, "ROOM_NOTE_FORBIDDEN", "공유 메모는 로그인한 회의실 참가자만 사용할 수 있어요.");
            return;
        }
        RoomNotesStore storage = roomNotesStore;
        if (storage == null) {
            roomNoteAck(c, request, zoneId, false, 0, "ROOM_NOTE_UNAVAILABLE", "공유 메모 저장소를 사용할 수 없어요. 잠시 후 다시 시도해 주세요.");
            return;
        }
        if ("LOAD".equals(request.action())) {
            boolean queued = storage.load(player.spaceId, player.mapId, zoneId, note -> enqueueRoomNoteCallback(c, player,
                request.epoch(), zoneId, request, () -> {
                    if (note == null) {
                        roomNoteAck(c, request, zoneId, false, 0, "ROOM_NOTE_UNAVAILABLE", "공유 메모를 불러오지 못했어요. 잠시 후 다시 시도해 주세요.");
                        return;
                    }
                    control(c, note);
                    roomNoteAck(c, request, zoneId, true, note.revision(), "", "");
                }));
            if (!queued)
                roomNoteAck(c, request, zoneId, false, 0, "ROOM_NOTE_BUSY", "공유 메모 요청이 많아요. 잠시 후 다시 시도해 주세요.");
            return;
        }
        long now = System.nanoTime();
        if (now < player.nextRoomNoteSaveAt) {
            roomNoteAck(c, request, zoneId, false, request.baseRevision(), "ROOM_NOTE_RATE_LIMIT", "저장이 너무 잦아요. 잠시 후 다시 시도해 주세요.");
            return;
        }
        player.nextRoomNoteSaveAt = now + TimeUnit.MILLISECONDS.toNanos(800);
        boolean queued = storage.save(player.spaceId, player.mapId, zoneId, request.requestId(), player.ownerUserId,
            player.name, request.baseRevision(), request.body(), result -> enqueueRoomNoteCallback(c, player,
                request.epoch(), zoneId, request, () -> {
                    if (result == null) {
                        roomNoteAck(c, request, zoneId, false, request.baseRevision(), "ROOM_NOTE_UNAVAILABLE", "공유 메모를 저장하지 못했어요. 잠시 후 다시 시도해 주세요.");
                        return;
                    }
                    if (result.state() != null) control(c, result.state());
                    long revision = result.state() == null ? request.baseRevision() : result.state().revision();
                    String message = "ROOM_NOTE_CONFLICT".equals(result.code())
                        ? "다른 참가자가 먼저 저장했어요. 최신 내용을 확인한 뒤 다시 저장해 주세요."
                        : result.message();
                    roomNoteAck(c, request, zoneId, result.accepted(), revision, result.code(), message);
                }));
        if (!queued)
            roomNoteAck(c, request, zoneId, false, request.baseRevision(), "ROOM_NOTE_BUSY", "공유 메모 요청이 많아요. 잠시 후 다시 시도해 주세요.");
    }
    private void enqueueRoomNoteCallback(Connection c, Player player, long epoch, String zoneId,
                                         RoomNoteRequest request, Runnable completed) {
        boolean queued = offerCommand(() -> {
            if (!validRoomNoteParticipant(c, player, epoch, zoneId)) return;
            completed.run();
        });
        if (!queued)
            roomNoteAck(c, request, zoneId, false, request.baseRevision(), "ROOM_NOTE_BUSY", "서버가 바빠서 공유 메모 응답을 처리하지 못했어요. 다시 시도해 주세요.");
    }
    private String roomNoteZone(Player player) {
        if (player == null) return "";
        PublishedMaps.Published published = roomMaps.get(roomId(player));
        if (published == null) return "";
        return Movement.zoneAt(published.map(), player.x, player.y);
    }
    private boolean validRoomNoteParticipant(Connection c, Player player, long epoch, String zoneId) {
        if (player == null || player.connection != c || c.player != player || c.closed
            || player.epoch != epoch || player.barrier != null || !player.spaceAccessReady
            || player.ownerUserId == null || player.ownerUserId.isBlank() || zoneId == null || zoneId.isBlank())
            return false;
        PublishedMaps.Published published = roomMaps.get(roomId(player));
        return published != null && zoneId.equals(Movement.zoneAt(published.map(), player.x, player.y))
            && privateZone(published.map(), zoneId) != null;
    }
    private void roomNoteAck(Connection c, RoomNoteRequest request, String zoneId, boolean accepted,
                             long revision, String code, String message) {
        if (c != null && !c.closed)
            control(c, new RoomNoteAck("roomNoteAck", request.requestId(), zoneId == null ? "" : zoneId,
                accepted, Math.max(0, revision), code, message));
    }
    private void broadcastRoomNote(RoomNotesStore.Relay relay) {
        RoomNoteState note = relay.state();
        if (note == null || !relay.zoneId().equals(note.zoneId())) return;
        for (Player player : players.values()) {
            if (!player.spaceId.equals(relay.spaceId()) || !player.mapId.equals(relay.mapId())
                || player.ownerUserId == null || player.ownerUserId.isBlank() || !player.spaceAccessReady || player.connection == null
                || player.connection.closed || player.barrier != null || !relay.zoneId().equals(roomNoteZone(player))) continue;
            control(player.connection, note);
        }
    }
    private void roomRecording(Connection c, RoomRecordingRequest request) {
        if (!roomExtrasEnabled) {
            roomRecordingAck(c, request, null, false, "ROOM_EXTRAS_DISABLED", "현재 회의실 녹화 기능은 사용할 수 없어요.");
            return;
        }
        Player player = c.player;
        if (!validRoomNoteParticipant(c, player, request.epoch(), request.zoneId())) {
            roomRecordingAck(c, request, null, false, "ROOM_RECORDING_FORBIDDEN", "로그인한 비공개 회의실 참가자만 녹화를 사용할 수 있어요.");
            return;
        }
        RoomRuntime state = roomRuntime(roomId(player), request.zoneId());
        long now = System.currentTimeMillis();
        switch (request.action()) {
            case "START" -> {
                if (!media.enabled()) {
                    roomRecordingAck(c, request, null, false, "ROOM_RECORDING_UNAVAILABLE", "녹화 서버를 사용할 수 없어요.");
                    return;
                }
                if (!player.id.equals(state.hostPlayerId)) {
                    roomRecordingAck(c, request, state.recording, false, "ROOM_RECORDING_HOST_REQUIRED", "회의실 호스트만 녹화를 요청할 수 있어요.");
                    return;
                }
                if (isRoomRecordingActive(state.recording)) {
                    roomRecordingAck(c, request, state.recording, false, "ROOM_RECORDING_ACTIVE", "이미 녹화 동의를 진행 중이거나 녹화 중이에요.");
                    return;
                }
                if (request.sources().contains("SCREEN_AUDIO") && !request.sources().contains("SCREEN")) {
                    roomRecordingAck(c, request, null, false, "ROOM_RECORDING_SOURCE_INVALID", "화면 소리는 화면 녹화와 함께 선택해야 해요.");
                    return;
                }
                if (request.transcribe() && !request.sources().contains("MICROPHONE")) {
                    roomRecordingAck(c, request, null, false, "ROOM_RECORDING_TRANSCRIPTION_SOURCE_REQUIRED", "음성 자막을 만들려면 마이크 녹음을 선택해야 해요.");
                    return;
                }
                MapDefinition map = roomMaps.get(roomId(player)).map();
                var roster = players.values().stream()
                    .filter(member -> roomId(member).equals(roomId(player))
                        && request.zoneId().equals(Movement.zoneAt(map, member.x, member.y)))
                    .sorted(Comparator.comparing(member -> member.id)).toList();
                if (roster.isEmpty() || roster.size() > 100 || !roster.contains(player)) {
                    roomRecordingAck(c, request, null, false, "ROOM_RECORDING_ROSTER_INVALID", "회의실 참가자를 확인할 수 없어요.");
                    return;
                }
                String domain = null;
                var participants = new LinkedHashMap<String, RoomRecordingParticipantRuntime>();
                for (Player member : roster) {
                    if (!validRoomNoteParticipant(member.connection, member, member.epoch, request.zoneId())
                        || member.barrier != null) {
                        roomRecordingAck(c, request, null, false, "ROOM_RECORDING_ROSTER_INVALID", "모든 참가자가 로그인한 상태로 회의실에 있어야 해요.");
                        return;
                    }
                    MediaPolicy.Person person = mediaPerson(map, member, member.x, member.y);
                    if (!person.enabled() || request.sources().stream().map(MediaPolicy.Source::valueOf)
                        .anyMatch(source -> !MediaPolicy.sourceAllowed(person, source))) {
                        roomRecordingAck(c, request, null, false, "ROOM_RECORDING_MEDIA_BLOCKED", "운영 설정이나 연결 상태 때문에 녹화할 수 없는 참가자가 있어요.");
                        return;
                    }
                    if (domain == null) domain = person.domain();
                    else if (!domain.equals(person.domain())) {
                        roomRecordingAck(c, request, null, false, "ROOM_RECORDING_DOMAIN_CHANGED", "참가자의 미디어 구역이 일치하지 않아요.");
                        return;
                    }
                    participants.put(member.id, new RoomRecordingParticipantRuntime(member.id, member.ownerUserId,
                        member.name, member.epoch, member.mediaEpoch, "PENDING", 0));
                }
                RoomRecordingSession session = new RoomRecordingSession(UUID.randomUUID().toString(), request.zoneId(),
                    roomId(player), player.spaceId, player.mapId, map.revision(), domain,
                    List.copyOf(request.sources()), request.transcribe(), player.id, player.ownerUserId, player.name, now, now + 120_000, participants);
                state.recording = session;
                broadcastRoomRecording(state, session);
                roomRecordingAck(c, request, session, true, "", "참가자에게 녹화 동의를 요청했어요.");
            }
            case "CONSENT" -> {
                RoomRecordingSession session = state.recording;
                RoomRecordingParticipantRuntime participant = recordingParticipant(session, player, request.recordingId(), request.zoneId());
                if (session == null || !"AWAITING_CONSENT".equals(session.status) || participant == null) {
                    roomRecordingAck(c, request, session, false, "ROOM_RECORDING_REQUEST_EXPIRED", "현재 응답할 녹화 요청이 없어요.");
                    return;
                }
                participant.decision = request.accepted() ? "ACCEPTED" : "DECLINED";
                participant.respondedAt = now;
                if (!request.accepted()) {
                    session.status = "DECLINED";
                    session.endedAt = now;
                    broadcastRoomRecording(state, session);
                    roomRecordingAck(c, request, session, true, "", "참가자가 동의하지 않아 녹화를 시작하지 않았어요.");
                    return;
                }
                if (session.participants.values().stream().allMatch(item -> "ACCEPTED".equals(item.decision)))
                    beginRoomRecording(state, session, now);
                else broadcastRoomRecording(state, session);
                roomRecordingAck(c, request, session, true, "", "녹화 동의가 기록됐어요.");
            }
            case "WITHDRAW" -> {
                RoomRecordingSession session = state.recording;
                RoomRecordingParticipantRuntime participant = recordingParticipant(session, player, request.recordingId(), request.zoneId());
                if (session == null || participant == null || !isRoomRecordingActive(session)) {
                    roomRecordingAck(c, request, session, false, "ROOM_RECORDING_NOT_ACTIVE", "철회할 녹화가 없어요.");
                    return;
                }
                participant.decision = "WITHDRAWN";
                participant.respondedAt = now;
                requestStopRoomRecording(state, session, "STOPPED", now);
                roomRecordingAck(c, request, session, true, "", "동의 철회를 기록하고 녹화를 종료할게요.");
            }
            case "STOP" -> {
                RoomRecordingSession session = state.recording;
                if (session == null || !isRoomRecordingActive(session) || !player.id.equals(state.hostPlayerId)) {
                    roomRecordingAck(c, request, session, false, "ROOM_RECORDING_HOST_REQUIRED", "진행 중인 녹화를 종료할 회의실 호스트가 필요해요.");
                    return;
                }
                if (!session.recordingId.equals(request.recordingId())) {
                    roomRecordingAck(c, request, session, false, "ROOM_RECORDING_STALE", "녹화 상태가 바뀌었어요.");
                    return;
                }
                requestStopRoomRecording(state, session, "STOPPED", now);
                roomRecordingAck(c, request, session, true, "", "녹화를 종료하고 파일을 저장하고 있어요.");
            }
            default -> roomRecordingAck(c, request, state.recording, false, "ROOM_RECORDING_ACTION_INVALID", "녹화 요청을 처리할 수 없어요.");
        }
    }
    private RoomRecordingParticipantRuntime recordingParticipant(RoomRecordingSession session, Player player,
                                                                  String recordingId, String zoneId) {
        if (session == null || !session.recordingId.equals(recordingId) || !session.zoneId.equals(zoneId)) return null;
        RoomRecordingParticipantRuntime participant = session.participants.get(player.id);
        if (participant == null || !participant.userId.equals(player.ownerUserId)
            || participant.epoch != player.epoch || participant.mediaEpoch != player.mediaEpoch
            || !"ACCEPTED".equals(participant.decision) && !"PENDING".equals(participant.decision)) return null;
        return participant;
    }
    private boolean isRoomRecordingActive(RoomRecordingSession session) {
        return session != null && Set.of("AWAITING_CONSENT", "STARTING", "RECORDING", "STOPPING").contains(session.status);
    }
    private void beginRoomRecording(RoomRuntime state, RoomRecordingSession session, long now) {
        if (state.recording != session || !"AWAITING_CONSENT".equals(session.status)) return;
        if (!roomRecordingRosterMatches(state, session)) {
            session.status = "FAILED"; session.endedAt = now;
            broadcastRoomRecording(state, session);
            return;
        }
        session.status = "STARTING";
        session.startPending = true;
        broadcastRoomRecording(state, session);
        var participants = session.participants.values().stream()
            .map(item -> new MediaGateway.RecordingParticipant(item.playerId,
                RecordingMetadataId.resolve(auth.preview(), "user", item.userId), item.name, item.mediaEpoch)).toList();
        RoomKey key = roomKey(state.spaceId + "|" + state.mapId, session.zoneId);
        media.startRecording(session.recordingId, session.domain,
            RecordingMetadataId.resolve(auth.preview(), "space", session.spaceId),
            RecordingMetadataId.resolve(auth.preview(), "map", session.mapId),
            RecordingMetadataId.resolve(auth.preview(), "revision", session.mapRevision), session.zoneId,
            RecordingMetadataId.resolve(auth.preview(), "user", session.requestedByUserId),
            session.sources, session.transcribe, participants, reply -> {
            if (!offerCommand(() -> finishRoomRecordingStart(key, session, reply))) {
                if (reply.ok()) media.stopRecording(session.recordingId, ignored -> {});
            }
        });
    }
    private void finishRoomRecordingStart(RoomKey key, RoomRecordingSession session, MediaGateway.Reply reply) {
        RoomRuntime state = roomRuntimes.get(key);
        if (state == null || state.recording != session) {
            if (reply.ok()) media.stopRecording(session.recordingId, ignored -> {});
            return;
        }
        session.startPending = false;
        if (!reply.ok()) {
            session.status = "FAILED";
            session.failureCode = reply.code() != null && reply.code().matches("[A-Z0-9_]{1,64}") ? reply.code() : "";
            session.endedAt = System.currentTimeMillis();
            broadcastRoomRecording(state, session);
            return;
        }
        session.failureCode = "";
        try {
            JsonNode result = json.readTree(reply.dataJson());
            if (!result.path("active").asBoolean(false)) throw new IllegalStateException("recording did not become active");
            session.trackCount = Math.max(0, Math.min(400, result.path("trackCount").asLong()));
            if (session.trackCount < 1) throw new IllegalStateException("recording has no tracks");
        } catch (Exception invalid) {
            session.stopWanted = true; session.stopStatus = "FAILED"; session.status = "STOPPING";
            media.stopRecording(session.recordingId, stopped -> offerCommand(() -> finishRoomRecordingStop(key, session, stopped)));
            broadcastRoomRecording(state, session);
            return;
        }
        if (session.stopWanted || !roomRecordingRosterMatches(state, session)) {
            if (!session.stopWanted) { session.stopWanted = true; session.stopStatus = "STOPPED"; }
            session.status = "STOPPING";
            broadcastRoomRecording(state, session);
            media.stopRecording(session.recordingId, stopped -> {
                if (!offerCommand(() -> finishRoomRecordingStop(key, session, stopped))) { /* media service retains the finalized artifact */ }
            });
            return;
        }
        session.status = "RECORDING";
        session.startedAt = System.currentTimeMillis();
        broadcastRoomRecording(state, session);
    }
    private void requestStopRoomRecording(RoomRuntime state, RoomRecordingSession session, String finalStatus, long now) {
        if (state.recording != session || !isRoomRecordingActive(session)) return;
        if ("STOPPING".equals(session.status)) return;
        if ("AWAITING_CONSENT".equals(session.status)) {
            session.status = finalStatus;
            session.endedAt = now;
            broadcastRoomRecording(state, session);
            return;
        }
        if (!session.stopWanted) {
            session.stopWanted = true;
            session.stopStatus = finalStatus;
        }
        session.status = "STOPPING";
        broadcastRoomRecording(state, session);
        if (session.startPending) return;
        RoomKey key = roomKey(state.spaceId + "|" + state.mapId, session.zoneId);
        media.stopRecording(session.recordingId, reply -> {
            if (!offerCommand(() -> finishRoomRecordingStop(key, session, reply)))
                org.slf4j.LoggerFactory.getLogger(getClass()).warn("Could not queue the completed recording stop event");
        });
    }
    private void finishRoomRecordingStop(RoomKey key, RoomRecordingSession session, MediaGateway.Reply reply) {
        RoomRuntime state = roomRuntimes.get(key);
        if (state == null || state.recording != session) return;
        if (reply.ok()) {
            try {
                JsonNode result = json.readTree(reply.dataJson());
                session.trackCount = Math.max(session.trackCount, Math.min(400, result.path("trackCount").asLong()));
            } catch (Exception ignored) { }
            session.status = session.stopStatus.isBlank() ? "STOPPED" : session.stopStatus;
        } else {
            session.status = "FAILED";
            session.failureCode = reply.code() != null && reply.code().matches("[A-Z0-9_]{1,64}") ? reply.code() : "";
        }
        session.endedAt = System.currentTimeMillis();
        broadcastRoomRecording(state, session);
    }
    private boolean roomRecordingRosterMatches(RoomRuntime state, RoomRecordingSession session) {
        MapDefinition map = roomMaps.get(session.worldRoomId) == null ? null : roomMaps.get(session.worldRoomId).map();
        if (map == null || !session.requestedByPlayerId.equals(state.hostPlayerId)) return false;
        var live = players.values().stream()
            .filter(member -> roomId(member).equals(session.worldRoomId)
                && session.zoneId.equals(Movement.zoneAt(map, member.x, member.y)))
            .toList();
        if (live.size() != session.participants.size()) return false;
        for (Player member : live) {
            RoomRecordingParticipantRuntime participant = session.participants.get(member.id);
            if (participant == null || !participant.userId.equals(member.ownerUserId)
                || participant.epoch != member.epoch || participant.mediaEpoch != member.mediaEpoch
                || !validRoomNoteParticipant(member.connection, member, member.epoch, session.zoneId)
                || member.barrier != null || !"AVAILABLE".equals(member.status)) return false;
            if (!session.domain.equals(mediaPerson(map, member, member.x, member.y).domain())) return false;
        }
        return true;
    }
    private void broadcastRoomRecording(RoomRuntime state, RoomRecordingSession session) {
        if (session == null) return;
        RoomRecordingState message = roomRecordingMessage(session);
        for (Player player : players.values()) {
            if (!roomId(player).equals(session.worldRoomId) || player.connection == null || player.connection.closed
                || !session.zoneId.equals(roomNoteZone(player))) continue;
            control(player.connection, message);
        }
    }
    private RoomRecordingState roomRecordingMessage(RoomRecordingSession session) {
        List<RoomRecordingParticipant> participants = session.participants.values().stream()
            .map(item -> new RoomRecordingParticipant(item.playerId, item.name, item.decision, item.respondedAt)).toList();
        return new RoomRecordingState("roomRecordingState", session.recordingId,
            session.zoneId, session.status, session.sources, session.requestedByPlayerId, session.requestedByName,
            session.requestedAt, session.startedAt, session.endedAt, 30, session.trackCount, session.failureCode, session.transcribe, participants);
    }
    private void roomRecordingAck(Connection c, RoomRecordingRequest request, RoomRecordingSession session,
                                  boolean accepted, String code, String message) {
        if (c == null || c.closed) return;
        control(c, new RoomRecordingAck("roomRecordingAck", request.requestId(),
            session == null ? "" : session.recordingId, accepted,
            session == null ? "" : session.status, code, message));
    }
    private void markEventAttendance(Player player, long wall) {
        EventRuntime state = events.get(player.spaceId);
        if (state == null || !state.active || !state.attendanceEnabled || state.eventId.isBlank() || player.connection == null || player.connection.closed) return;
        if (!state.attendeePlayerIds.contains(player.id) || !state.eventId.equals(player.attendanceEventId)) {
            state.attendeePlayerIds.add(player.id);
            player.attendanceEventId = state.eventId;
            player.attendanceTouchedAt = wall;
            if (eventPersistence != null)
                eventPersistence.enter(state.eventId, player.id, player.ownerUserId, player.name);
            state.revision++;
            return;
        }
        if (eventPersistence != null && wall - player.attendanceTouchedAt >= 5_000) {
            player.attendanceTouchedAt = wall;
            eventPersistence.touch(state.eventId, player.id);
        }
    }
    private void markEventLeave(Player player) {
        if (eventPersistence != null && !player.attendanceEventId.isBlank())
            eventPersistence.leave(player.attendanceEventId, player.id);
        player.attendanceEventId = "";
        player.attendanceTouchedAt = 0;
    }
    private void clearLiveEventAttendance(String spaceId, String eventId) {
        for (Player player : players.values()) {
            if (player.spaceId.equals(spaceId) && eventId.equals(player.attendanceEventId)) markEventLeave(player);
        }
    }
    private void eventAction(Connection c, EventAction request) {
        Player actor = c.player;
        if (actor == null || actor.connection != c || actor.epoch != request.epoch()) {
            eventAck(c, request, false, "EVENT_STALE", "발표 상태가 바뀌었어요.");
            return;
        }
        EventRuntime state = events.computeIfAbsent(actor.spaceId, id -> new EventRuntime());
        if ("RAISE_HAND".equals(request.action()) || "LOWER_HAND".equals(request.action())) {
            if (!state.active) {
                eventAck(c, request, false, "EVENT_INACTIVE", "진행 중인 발표가 없어요.");
                return;
            }
            boolean changed = "RAISE_HAND".equals(request.action())
                ? state.raisedHandPlayerIds.add(actor.id)
                : state.raisedHandPlayerIds.remove(actor.id);
            if (changed) state.revision++;
            broadcastEventState(actor.spaceId, true);
            eventAck(c, request, true, "", "RAISE_HAND".equals(request.action()) ? "손을 들었어요." : "손을 내렸어요.");
            return;
        }
        if (!actor.manager) {
            eventAck(c, request, false, "EVENT_FORBIDDEN", "공간 운영자만 발표를 관리할 수 있어요.");
            return;
        }
        switch (request.action()) {
            case "START" -> {
                state.active = true;
                state.eventId = UUID.randomUUID().toString();
                state.startedAt = System.currentTimeMillis();
                state.attendanceEnabled = request.attendanceEnabled();
                state.attendeePlayerIds.clear();
                state.title = request.title().strip().isEmpty() ? "전체 발표" : request.title().strip();
                state.description = request.description().strip();
                state.resourceUrl = request.resourceUrl().strip();
                state.hostPlayerId = actor.id;
                state.speakerPlayerIds.clear();
                state.speakerPlayerIds.add(actor.id);
                state.raisedHandPlayerIds.clear();
                clearEngagement(state);
                if (eventPersistence != null)
                    eventPersistence.start(state.eventId, actor.spaceId, actor.ownerUserId, state.title, state.description,
                        state.resourceUrl, state.startedAt);
                for (Player player : players.values())
                    if (player.connection != null && !player.connection.closed && player.spaceId.equals(actor.spaceId))
                        markEventAttendance(player, state.startedAt);
                state.revision++;
                broadcastEventState(actor.spaceId, true);
                broadcastEngagementState(actor.spaceId, true);
                eventAck(c, request, true, "", "발표 모드를 시작했어요.");
            }
            case "STOP" -> {
                state.active = false;
                state.title = "";
                state.description = "";
                state.resourceUrl = "";
                state.hostPlayerId = "";
                state.speakerPlayerIds.clear();
                state.raisedHandPlayerIds.clear();
                clearEngagement(state);
                if (eventPersistence != null && !state.eventId.isBlank()) eventPersistence.stop(state.eventId, System.currentTimeMillis());
                clearLiveEventAttendance(actor.spaceId, state.eventId);
                state.revision++;
                broadcastEventState(actor.spaceId, true);
                broadcastEngagementState(actor.spaceId, true);
                eventAck(c, request, true, "", "발표 모드를 종료했어요.");
            }
            case "GRANT_SPEAKER", "REVOKE_SPEAKER" -> {
                if (!state.active) {
                    eventAck(c, request, false, "EVENT_INACTIVE", "발표를 먼저 시작해 주세요.");
                    return;
                }
                Player target = players.get(request.targetPlayerId());
                if (target == null || target.connection == null || !target.spaceId.equals(actor.spaceId)) {
                    eventAck(c, request, false, "EVENT_TARGET_MISSING", "같은 공간의 참가자를 찾을 수 없어요.");
                    return;
                }
                boolean changed = "GRANT_SPEAKER".equals(request.action())
                    ? state.speakerPlayerIds.size() < 8 && state.speakerPlayerIds.add(target.id)
                    : state.speakerPlayerIds.remove(target.id);
                if (!changed && "GRANT_SPEAKER".equals(request.action()) && state.speakerPlayerIds.size() >= 8) {
                    eventAck(c, request, false, "EVENT_SPEAKER_LIMIT", "발표자는 최대 8명까지 지정할 수 있어요.");
                    return;
                }
                state.raisedHandPlayerIds.remove(target.id);
                state.revision++;
                broadcastEventState(actor.spaceId, true);
                eventAck(c, request, true, "", "GRANT_SPEAKER".equals(request.action()) ? "발표자로 지정했어요." : "발표자 권한을 해제했어요.");
            }
            default -> eventAck(c, request, false, "EVENT_ACTION", "발표 동작을 확인해 주세요.");
        }
    }
    private void eventEngagement(Connection c, EventEngagement request) {
        Player actor = c.player;
        if (actor == null || actor.connection != c || actor.epoch != request.epoch()) {
            engagementAck(c, request, false, "EVENT_STALE", "발표 상태가 바뀌었어요.", "");
            return;
        }
        EventRuntime state = events.computeIfAbsent(actor.spaceId, id -> new EventRuntime());
        if (!state.active) {
            engagementAck(c, request, false, "EVENT_INACTIVE", "진행 중인 발표가 없어요.", "");
            return;
        }
        switch (request.action()) {
            case "ASK_QUESTION" -> {
                long now = System.currentTimeMillis();
                String actorKey = eventActorKey(actor);
                if (now - state.questionAt.getOrDefault(actorKey, 0L) < 3000) {
                    engagementAck(c, request, false, "QUESTION_RATE", "질문을 너무 빠르게 보내고 있어요.", "");
                    return;
                }
                String text = request.text().strip();
                if (text.isEmpty()) {
                    engagementAck(c, request, false, "QUESTION_EMPTY", "질문 내용을 입력해 주세요.", "");
                    return;
                }
                if (state.questions.size() >= 100) {
                    engagementAck(c, request, false, "QUESTION_LIMIT", "질문 대기열이 가득 찼어요.", "");
                    return;
                }
                String id = UUID.randomUUID().toString();
                state.questions.put(id, new EventQuestionRuntime(id, actor.id, actor.ownerUserId, actor.name, text));
                state.questionAt.put(actorKey, now);
                if (eventPersistence != null && !state.eventId.isBlank())
                    eventPersistence.question(state.eventId, id, actor.ownerUserId, actor.name, text);
                state.revision++;
                broadcastEngagementState(actor.spaceId, true);
                engagementAck(c, request, true, "", "질문을 등록했어요.", id);
            }
            case "ANSWER_QUESTION" -> {
                if (!actor.manager) {
                    engagementAck(c, request, false, "EVENT_FORBIDDEN", "공간 운영자만 질문에 답변할 수 있어요.", "");
                    return;
                }
                EventQuestionRuntime question = state.questions.get(request.questionId());
                String answer = request.text().strip();
                if (question == null) {
                    engagementAck(c, request, false, "QUESTION_MISSING", "질문을 찾을 수 없어요.", "");
                    return;
                }
                if (answer.isEmpty()) {
                    engagementAck(c, request, false, "ANSWER_EMPTY", "답변 내용을 입력해 주세요.", question.id);
                    return;
                }
                question.answered = true;
                question.answer = answer;
                question.answererName = actor.name;
                if (eventPersistence != null && !state.eventId.isBlank())
                    eventPersistence.answer(state.eventId, question.id, actor.name, answer);
                state.revision++;
                broadcastEngagementState(actor.spaceId, true);
                engagementAck(c, request, true, "", "답변을 게시했어요.", question.id);
            }
            case "CREATE_POLL", "CREATE_QUIZ" -> {
                if (!actor.manager) {
                    engagementAck(c, request, false, "EVENT_FORBIDDEN", "공간 운영자만 투표와 퀴즈를 만들 수 있어요.", "");
                    return;
                }
                boolean quiz = "CREATE_QUIZ".equals(request.action());
                String question = request.pollQuestion().strip();
                List<String> options = request.pollOptions().stream().map(String::strip).filter(option -> !option.isEmpty()).distinct().toList();
                if (question.isEmpty() || options.size() < 2 || options.size() > 6
                    || (quiz && (request.correctOptionIndex() < 0 || request.correctOptionIndex() >= options.size()))) {
                    engagementAck(c, request, false, "POLL_INVALID", "질문과 선택지 두 개 이상을 입력하고 퀴즈 정답을 지정해 주세요.", "");
                    return;
                }
                if (state.poll != null && !state.poll.closed) {
                    engagementAck(c, request, false, "POLL_ACTIVE", "진행 중인 투표를 먼저 종료해 주세요.", state.poll.id);
                    return;
                }
                if (state.pollCount >= 100) {
                    engagementAck(c, request, false, "POLL_LIMIT", "행사 하나에는 퀴즈와 투표를 100개까지 만들 수 있어요.", "");
                    return;
                }
                state.poll = new EventPollRuntime(UUID.randomUUID().toString(), question, options, quiz,
                    quiz ? (int) request.correctOptionIndex() : -1);
                state.pollCount++;
                if (eventPersistence != null && !state.eventId.isBlank())
                    eventPersistence.poll(state.eventId, state.poll.id, question, options, quiz,
                        state.poll.correctOptionIndex);
                state.revision++;
                broadcastEngagementState(actor.spaceId, true);
                engagementAck(c, request, true, "", "투표를 시작했어요.", state.poll.id);
            }
            case "VOTE_POLL" -> {
                EventPollRuntime poll = state.poll;
                if (poll == null || poll.closed) {
                    engagementAck(c, request, false, "POLL_INACTIVE", "진행 중인 투표가 없어요.", "");
                    return;
                }
                if (request.optionIndex() < 0 || request.optionIndex() >= poll.options.size()) {
                    engagementAck(c, request, false, "POLL_OPTION", "선택지를 확인해 주세요.", poll.id);
                    return;
                }
                String voterKey = eventActorKey(actor);
                if (poll.votes.containsKey(voterKey)) {
                    engagementAck(c, request, false, "POLL_DUPLICATE", "이미 투표했어요.", poll.id);
                    return;
                }
                int optionIndex = (int) request.optionIndex();
                poll.votes.put(voterKey, optionIndex);
                poll.voterNames.put(voterKey, actor.name);
                poll.counts[optionIndex]++;
                boolean correct = poll.quiz && optionIndex == poll.correctOptionIndex;
                if (eventPersistence != null) eventPersistence.vote(poll.id,
                    actor.ownerUserId == null || actor.ownerUserId.isBlank() ? "GUEST" : "USER",
                    actor.ownerUserId == null || actor.ownerUserId.isBlank() ? actor.id : actor.ownerUserId,
                    actor.ownerUserId, optionIndex, correct);
                state.revision++;
                broadcastEngagementState(actor.spaceId, true);
                engagementAck(c, request, true, "", "투표를 반영했어요.", poll.id);
            }
            case "CLOSE_POLL" -> {
                if (!actor.manager) {
                    engagementAck(c, request, false, "EVENT_FORBIDDEN", "공간 운영자만 투표를 종료할 수 있어요.", "");
                    return;
                }
                if (state.poll == null || state.poll.closed) {
                    engagementAck(c, request, false, "POLL_INACTIVE", "진행 중인 투표가 없어요.", "");
                    return;
                }
                state.poll.closed = true;
                if (state.poll.quiz) {
                    for (Map.Entry<String, Integer> vote : state.poll.votes.entrySet()) {
                        if (vote.getValue() == state.poll.correctOptionIndex) {
                            state.quizScores.merge(vote.getKey(), 1, Integer::sum);
                            state.quizScoreNames.put(vote.getKey(), state.poll.voterNames.getOrDefault(vote.getKey(), "참가자"));
                        }
                    }
                }
                if (eventPersistence != null) eventPersistence.closePoll(state.poll.id);
                state.revision++;
                broadcastEngagementState(actor.spaceId, true);
                engagementAck(c, request, true, "", "투표를 종료했어요.", state.poll.id);
            }
            case "START_SCAVENGER_HUNT" -> startScavengerHunt(c, actor, state, request);
            case "STOP_SCAVENGER_HUNT" -> stopScavengerHunt(c, actor, state, request);
            case "SCAVENGER_TALK" -> talkToScavengerNpc(c, actor, state, request);
            case "COLLECT_SCAVENGER_ITEM" -> collectScavengerItem(c, actor, state, request);
            default -> engagementAck(c, request, false, "EVENT_ACTION", "참여 동작을 확인해 주세요.", "");
        }
    }
    private void startScavengerHunt(Connection c, Player actor, EventRuntime state, EventEngagement request) {
        if (!actor.manager) {
            engagementAck(c, request, false, "EVENT_FORBIDDEN", "공간 운영자만 수집 퀘스트를 시작할 수 있어요.", "");
            return;
        }
        if (state.scavenger != null && state.scavenger.active) {
            engagementAck(c, request, false, "SCAVENGER_ALREADY_STARTED", "이 행사에서 수집 퀘스트를 이미 시작했어요.", "");
            return;
        }
        PublishedMaps.Published published = roomMaps.get(roomId(actor));
        if (published == null) {
            engagementAck(c, request, false, "SCAVENGER_MAP_MISSING", "현재 맵을 확인할 수 없어요.", "");
            return;
        }
        MapDefinition map = published.map();
        List<MapObject> items = ScavengerObjectCountsCache.scavengerObjects(map, "SCAVENGER_ITEM");
        List<MapObject> npcs = ScavengerObjectCountsCache.scavengerObjects(map, "NPC");
        if (items.isEmpty() || npcs.isEmpty()) {
            engagementAck(c, request, false, "SCAVENGER_LAYOUT", "현재 맵에 수집 퀘스트 표식과 NPC가 각각 하나 이상 필요해요.", "");
            return;
        }
        if (items.size() > 100 || npcs.size() > 100) {
            engagementAck(c, request, false, "SCAVENGER_LIMIT", "수집 표식과 NPC는 맵마다 각각 100개까지 사용할 수 있어요.", "");
            return;
        }
        LinkedHashMap<String, EventScavengerItem> targets = new LinkedHashMap<>();
        for (MapObject item : items) {
            MapInteraction interaction = item.interaction();
            targets.put(item.id(), new EventScavengerItem(item.id(), interaction.title(), Objects.toString(interaction.body(), "")));
        }
        LinkedHashSet<String> npcIds = new LinkedHashSet<>();
        for (MapObject npc : npcs) npcIds.add(npc.id());
        state.scavenger = new EventScavengerRuntime(map.id(), map.revision(), map.name(), targets, npcIds);
        state.revision++;
        broadcastEngagementState(actor.spaceId, true);
        engagementAck(c, request, true, "", "NPC에게 말을 걸어 단서를 받고 수집 퀘스트를 시작하세요.", "");
    }
    private void stopScavengerHunt(Connection c, Player actor, EventRuntime state, EventEngagement request) {
        if (!actor.manager) {
            engagementAck(c, request, false, "EVENT_FORBIDDEN", "공간 운영자만 수집 퀘스트를 종료할 수 있어요.", "");
            return;
        }
        EventScavengerRuntime hunt = state.scavenger;
        if (hunt == null || !hunt.active) {
            engagementAck(c, request, false, "SCAVENGER_INACTIVE", "진행 중인 수집 퀘스트가 없어요.", "");
            return;
        }
        hunt.active = false;
        state.revision++;
        broadcastEngagementState(actor.spaceId, true);
        engagementAck(c, request, true, "", "수집 퀘스트를 종료했어요.", "");
    }
    private void talkToScavengerNpc(Connection c, Player actor, EventRuntime state, EventEngagement request) {
        EventScavengerRuntime hunt = state.scavenger;
        if (hunt == null || !hunt.active) {
            engagementAck(c, request, false, "SCAVENGER_INACTIVE", "진행 중인 수집 퀘스트가 없어요.", "");
            return;
        }
        MapDefinition map = scavengerMap(actor, hunt);
        if (map == null) {
            engagementAck(c, request, false, "SCAVENGER_MAP_CHANGED", "퀘스트 맵이 바뀌었어요. 운영자에게 다시 시작해 달라고 요청해 주세요.", "");
            return;
        }
        MapObject npc = map.objects().stream().filter(item -> item.id().equals(request.text())
            && hunt.npcObjectIds.contains(item.id()) && item.interaction() != null
            && "NPC".equals(item.interaction().kind())).findFirst().orElse(null);
        if (npc == null) {
            engagementAck(c, request, false, "SCAVENGER_NPC_INVALID", "퀘스트 맵에 있는 NPC와 대화해 주세요.", "");
            return;
        }
        if (Math.hypot(actor.x - npc.x(), actor.y - npc.y()) > 1.5) {
            engagementAck(c, request, false, "SCAVENGER_TOO_FAR", "NPC 가까이 다가가 말을 걸어 주세요.", "");
            return;
        }
        String key = eventActorKey(actor);
        boolean unlocked = hunt.unlockedParticipantKeys.add(key);
        if (unlocked) {
            hunt.participantNames.put(key, actor.name);
            state.revision++;
            broadcastEngagementState(actor.spaceId, true);
        }
        engagementAck(c, request, true, "", unlocked ? "NPC가 수집 단서를 알려줬어요." : "수집 단서를 다시 확인했어요.", npc.id());
    }
    private void collectScavengerItem(Connection c, Player actor, EventRuntime state, EventEngagement request) {
        EventScavengerRuntime hunt = state.scavenger;
        if (hunt == null || !hunt.active) {
            engagementAck(c, request, false, "SCAVENGER_INACTIVE", "진행 중인 수집 퀘스트가 없어요.", "");
            return;
        }
        MapDefinition map = scavengerMap(actor, hunt);
        if (map == null) {
            engagementAck(c, request, false, "SCAVENGER_MAP_CHANGED", "퀘스트가 진행되는 맵으로 이동해 주세요.", "");
            return;
        }
        String key = eventActorKey(actor);
        if (!hunt.unlockedParticipantKeys.contains(key)) {
            engagementAck(c, request, false, "SCAVENGER_LOCKED", "먼저 퀘스트 맵의 NPC에게 말을 걸어 주세요.", "");
            return;
        }
        EventScavengerItem target = hunt.items.get(request.text());
        MapObject item = map.objects().stream().filter(candidate -> candidate.id().equals(request.text())
            && candidate.interaction() != null && "SCAVENGER_ITEM".equals(candidate.interaction().kind()))
            .findFirst().orElse(null);
        if (target == null || item == null) {
            engagementAck(c, request, false, "SCAVENGER_ITEM_INVALID", "이 맵의 수집 퀘스트 표식이 아니에요.", "");
            return;
        }
        if (Math.hypot(actor.x - item.x(), actor.y - item.y()) > 1.5) {
            engagementAck(c, request, false, "SCAVENGER_TOO_FAR", "표식 가까이 다가가 다시 눌러 주세요.", item.id());
            return;
        }
        EventScavengerProgress progress = hunt.progress.computeIfAbsent(key,
            ignored -> new EventScavengerProgress(actor.name));
        progress.name = actor.name;
        if (!progress.collectedObjectIds.add(item.id())) {
            engagementAck(c, request, false, "SCAVENGER_DUPLICATE", "이 표식은 이미 모았어요.", item.id());
            return;
        }
        hunt.participantNames.put(key, actor.name);
        state.revision++;
        broadcastEngagementState(actor.spaceId, true);
        engagementAck(c, request, true, "", progress.collectedObjectIds.size() == hunt.items.size()
            ? "모든 표식을 모았어요. 완주 보너스 5점을 받았어요!"
            : "표식을 모았어요. +1점", item.id());
    }
    private MapDefinition scavengerMap(Player actor, EventScavengerRuntime hunt) {
        PublishedMaps.Published published = roomMaps.get(roomId(actor));
        if (published == null || !published.map().id().equals(hunt.mapId)
            || !published.map().revision().equals(hunt.mapRevision)) return null;
        return published.map();
    }
    private void engagementAck(Connection c, EventEngagement request, boolean accepted, String code, String message, String itemId) {
        control(c, new EventEngagementAck("eventEngagementAck", request.requestId(), request.action(), accepted, itemId, code, message));
    }
    private static String eventActorKey(Player actor) {
        return actor.ownerUserId == null || actor.ownerUserId.isBlank()
            ? "player:" + actor.id
            : "user:" + actor.ownerUserId;
    }
    private void broadcastEngagementState(String spaceId, boolean force) {
        EventRuntime state = events.computeIfAbsent(spaceId, id -> new EventRuntime());
        if (!force && state.engagementBroadcastedRevision == state.revision) return;
        state.engagementBroadcastedRevision = state.revision;
        for (Player player : players.values())
            if (player.connection != null && player.spaceId.equals(spaceId)) control(player.connection, engagementState(state, player));
    }
    private void sendEngagementState(Connection connection) {
        EventRuntime state = events.computeIfAbsent(connection.spaceId, id -> new EventRuntime());
        control(connection, engagementState(state, connection.player));
    }
    private EventEngagementState engagementState(EventRuntime state, Player viewer) {
        List<EventQuestion> questions = state.questions.values().stream().map(EventQuestionRuntime::view).toList();
        EventPollRuntime poll = state.poll;
        String viewerKey = viewer == null ? "" : eventActorKey(viewer);
        int myOptionIndex = poll == null ? -1 : poll.votes.getOrDefault(viewerKey, -1);
        int myQuizScore = viewer == null ? 0 : state.quizScores.getOrDefault(viewerKey, 0);
        List<EventQuizScore> quizScores = poll != null && poll.quiz && poll.closed
            ? state.quizScores.entrySet().stream()
                .sorted(Map.Entry.<String, Integer>comparingByValue().reversed()
                    .thenComparing(entry -> state.quizScoreNames.getOrDefault(entry.getKey(), "참가자"))
                    .thenComparing(Map.Entry::getKey))
                .limit(20)
                .map(entry -> new EventQuizScore(state.quizScoreNames.getOrDefault(entry.getKey(), "참가자"), entry.getValue()))
                .toList()
            : List.of();
        EventScavengerRuntime hunt = state.scavenger;
        EventScavengerProgress myProgress = hunt == null ? null : hunt.progress.get(viewerKey);
        boolean scavengerUnlocked = hunt != null && hunt.unlockedParticipantKeys.contains(viewerKey);
        List<EventScavengerItem> scavengerItems = hunt != null && scavengerUnlocked
            ? List.copyOf(hunt.items.values()) : List.of();
        List<String> scavengerCollected = myProgress == null ? List.of()
            : List.copyOf(myProgress.collectedObjectIds);
        int scavengerScore = scavengerScore(myProgress, hunt == null ? 0 : hunt.items.size());
        List<EventQuizScore> scavengerScores = hunt == null ? List.of()
            : hunt.progress.entrySet().stream()
                .map(entry -> Map.entry(entry.getKey(), new EventQuizScore(entry.getValue().name,
                    scavengerScore(entry.getValue(), hunt.items.size()))))
                .filter(entry -> entry.getValue().score() > 0)
                .sorted(Map.Entry.<String, EventQuizScore>comparingByValue(
                    Comparator.comparingLong(EventQuizScore::score).reversed()
                        .thenComparing(EventQuizScore::name)))
                .limit(20).map(Map.Entry::getValue).toList();
        long availableItems = 0, availableNpcs = 0;
        if (viewer != null && viewer.manager && (hunt == null || !hunt.active)) {
            PublishedMaps.Published current = roomMaps.get(roomId(viewer));
            if (current != null) {
                var counts = scavengerObjectCounts.forMap(roomId(viewer), current);
                availableItems = counts.availableItems();
                availableNpcs = counts.availableNpcs();
            }
        }
        return new EventEngagementState("eventEngagementState", state.active, questions,
            poll == null ? "" : poll.id, poll == null ? "" : poll.question, poll == null ? List.of() : List.copyOf(poll.options),
            poll == null || (poll.quiz && !poll.closed) ? List.of()
                : Arrays.stream(poll.counts).mapToLong(value -> value).boxed().toList(), poll == null || poll.closed,
            poll != null && poll.quiz ? "QUIZ" : "POLL",
            poll != null && poll.quiz && poll.closed ? poll.correctOptionIndex : -1,
            myOptionIndex, myQuizScore, quizScores,
            hunt != null, hunt != null && hunt.active, hunt == null ? "" : hunt.mapId,
            hunt == null ? "" : hunt.mapName, availableItems, availableNpcs,
            scavengerUnlocked, scavengerItems, scavengerCollected, scavengerScore,
            hunt != null && scavengerUnlocked && myProgress != null
                && myProgress.collectedObjectIds.size() == hunt.items.size(), scavengerScores);
    }
    private static int scavengerScore(EventScavengerProgress progress, int itemCount) {
        if (progress == null) return 0;
        int collected = progress.collectedObjectIds.size();
        return collected + (itemCount > 0 && collected == itemCount ? 5 : 0);
    }
    private void clearEngagement(EventRuntime state) {
        state.questions.clear();
        state.questionAt.clear();
        state.poll = null;
        state.pollCount = 0;
        state.quizScores.clear();
        state.quizScoreNames.clear();
        state.scavenger = null;
    }
    private void eventAck(Connection c, EventAction request, boolean accepted, String code, String message) {
        control(c, new EventActionAck("eventActionAck", request.requestId(), request.action(), accepted, code, message));
    }
    private void broadcastEventState(String spaceId, boolean force) {
        EventRuntime state = events.computeIfAbsent(spaceId, id -> new EventRuntime());
        refreshEventParticipants(spaceId, state);
        if (!force && state.broadcastedRevision == state.revision) return;
        EventState view = eventState(state);
        state.broadcastedRevision = state.revision;
        for (Player player : players.values())
            if (player.connection != null && player.spaceId.equals(spaceId)) control(player.connection, view);
    }
    private void sendEventState(Connection connection) {
        EventRuntime state = events.computeIfAbsent(connection.spaceId, id -> new EventRuntime());
        refreshEventParticipants(connection.spaceId, state);
        control(connection, eventState(state));
    }
    private void refreshEventParticipants(String spaceId, EventRuntime state) {
        List<EventParticipant> current = state.active ? players.values().stream()
            .filter(player -> player.connection != null && !player.connection.closed && player.spaceId.equals(spaceId))
            .map(player -> {
                PublishedMaps.Published published = roomMaps.get(roomId(player));
                String mapName = published == null ? player.mapId : published.map().name();
                return new EventParticipant(player.id, player.name, player.mapId, mapName);
            })
            .sorted(Comparator.comparing(EventParticipant::name, String.CASE_INSENSITIVE_ORDER)
                .thenComparing(EventParticipant::playerId))
            .limit(100)
            .toList() : List.of();
        if (!current.equals(state.participants)) {
            state.participants = current;
            state.revision++;
        }
    }
    private EventState eventState(EventRuntime state) {
        return new EventState("eventState", state.active, state.eventId, state.startedAt, state.attendanceEnabled,
            eventPersistence != null, state.attendeePlayerIds.size(), state.title, state.description, state.resourceUrl,
            state.hostPlayerId, List.copyOf(state.speakerPlayerIds), List.copyOf(state.raisedHandPlayerIds),
            List.copyOf(state.participants));
    }
    private SpaceParticipants refreshSpaceParticipants(String spaceId, Connection exclude) {
        List<SpaceParticipant> participants = players.values().stream()
            .filter(player -> player.connection != null && !player.connection.closed
                && player.blockDataReady && player.moderationDataReady && player.spaceAccessReady
                && player.spaceId.equals(spaceId))
            .map(player -> {
                PublishedMaps.Published published = roomMaps.get(roomId(player));
                String mapName = published == null ? player.mapId : published.map().name();
                return new SpaceParticipant(player.id, player.name, player.avatar, player.skin, player.clothing,
                    player.hair, player.status, player.mapId, mapName,
                    !player.ownerUserId.isBlank() && player.blockDataReady && player.moderationDataReady && player.spaceAccessReady,
                    player.allowPokes);
            })
            .sorted(Comparator.comparing(SpaceParticipant::name, String.CASE_INSENSITIVE_ORDER)
                .thenComparing(SpaceParticipant::playerId))
            .limit(100)
            .toList();
        SpaceParticipants previous = spaceParticipantViews.get(spaceId);
        if (previous != null && previous.participants().equals(participants)) return previous;
        if (participants.isEmpty()) {
            spaceParticipantViews.remove(spaceId);
            return null;
        }
        long revision = previous == null ? 1 : previous.revision() + 1;
        SpaceParticipants current = new SpaceParticipants("spaceParticipants", revision, participants);
        spaceParticipantViews.put(spaceId, current);
        String encoded;
        try { encoded = json.writeValueAsString(current); }
        catch (Exception invalid) {
            for (Player player : players.values()) {
                Connection viewer = player.connection;
                if (viewer != null && !viewer.closed && player.spaceId.equals(spaceId) && viewer != exclude)
                    disconnect(viewer);
            }
            return current;
        }
        for (Player player : players.values()) {
            Connection viewer = player.connection;
            if (viewer == null || viewer.closed || !player.spaceId.equals(spaceId) || viewer == exclude) continue;
            controlEncoded(viewer, encoded);
        }
        return current;
    }
    private void broadcastDirtySpaceParticipants() {
        Set<String> activeSpaces = players.values().stream()
            .filter(player -> player.connection != null && !player.connection.closed)
            .map(player -> player.spaceId)
            .collect(java.util.stream.Collectors.toCollection(HashSet::new));
        activeSpaces.addAll(spaceParticipantViews.keySet());
        for (String spaceId : activeSpaces) refreshSpaceParticipants(spaceId, null);
    }
    private void broadcastDirtyEventStates() {
        for (var entry : events.entrySet()) broadcastEventState(entry.getKey(), false);
    }
    private void normalizeEvents() {
        events.entrySet().removeIf(entry -> {
            String spaceId = entry.getKey();
            EventRuntime state = entry.getValue();
            Set<String> live = players.values().stream().filter(player -> player.connection != null && player.spaceId.equals(spaceId))
                .map(player -> player.id).collect(java.util.stream.Collectors.toSet());
            boolean changed = state.speakerPlayerIds.removeIf(id -> !live.contains(id));
            changed |= state.raisedHandPlayerIds.removeIf(id -> !live.contains(id));
            if (state.active && !live.contains(state.hostPlayerId)) {
                state.active = false;
                state.title = "";
                state.description = "";
                state.resourceUrl = "";
                state.hostPlayerId = "";
                state.speakerPlayerIds.clear();
                state.raisedHandPlayerIds.clear();
                clearEngagement(state);
                if (eventPersistence != null && !state.eventId.isBlank()) eventPersistence.stop(state.eventId, System.currentTimeMillis());
                clearLiveEventAttendance(spaceId, state.eventId);
                changed = true;
            }
            if (changed) { state.revision++; broadcastEventState(spaceId, true); broadcastEngagementState(spaceId, true); }
            return !state.active && state.speakerPlayerIds.isEmpty() && state.raisedHandPlayerIds.isEmpty() && live.isEmpty();
        });
    }
    private void expireRoomKnocks(RoomRuntime state, String zoneId, long wall) {
        var iterator = state.knocks.values().iterator();
        while (iterator.hasNext()) {
            PendingRoomKnock pending = iterator.next();
            if (pending.knock.expiresAt() > wall) continue;
            iterator.remove();
            Player guest = players.get(pending.knock.playerId());
            state.knockCooldowns.put(pending.knock.playerId(), wall + 3000);
            if (guest != null) roomKnockResult(guest, pending.knock.knockId(), zoneId, false, "ROOM_KNOCK_EXPIRED", "회의실 입장 노크가 만료됐어요.");
        }
        state.reservations.entrySet().removeIf(entry -> {
            if (entry.getValue() > wall) return false;
            if (!state.occupants.contains(entry.getKey())) state.admitted.remove(entry.getKey());
            return true;
        });
    }
    private Movement.Position nearestPublicStand(MapDefinition map, String roomZoneId, double fromX, double fromY) {
        Movement.Position nearest = null;
        double best = Double.POSITIVE_INFINITY;
        for (double y = .5; y < map.height(); y += .5) for (double x = .5; x < map.width(); x += .5) {
            if (!Movement.canStand(map, x, y)) continue;
            String zoneId = Movement.zoneAt(map, x, y);
            if (roomZoneId.equals(zoneId) || privateZone(map, zoneId) != null) continue;
            double dx = x - fromX, dy = y - fromY, distance = dx * dx + dy * dy;
            if (distance < best) { best = distance; nearest = new Movement.Position(x, y); }
        }
        return nearest;
    }
    private void syncRoomOccupancy(long wall) {
        for (Player member : players.values()) {
            String roomId=roomId(member);
            MapDefinition map = roomMaps.containsKey(roomId) ? roomMaps.get(roomId).map() : null;
            if (map == null) continue;
            String zoneId = Movement.zoneAt(map, member.x, member.y);
            if (privateZone(map, zoneId) != null) roomRuntime(roomId, zoneId);
        }
        roomRuntimes.entrySet().removeIf(entry -> {
            RoomKey key = entry.getKey();
            RoomRuntime state = entry.getValue();
            MapDefinition map = roomMaps.containsKey(key.spaceId()) ? roomMaps.get(key.spaceId()).map() : null;
            if (map == null || privateZone(map, key.zoneId()) == null) {
                if (isRoomRecordingActive(state.recording)) requestStopRoomRecording(state, state.recording, "STOPPED", wall);
                endRoomNoteMeeting(state, key.zoneId(), wall);
                return true;
            }
            expireRoomKnocks(state, key.zoneId(), wall);
            state.occupants.removeIf(id -> {
                Player member = players.get(id);
                return member == null || !roomId(member).equals(key.spaceId()) || !key.zoneId().equals(Movement.zoneAt(map, member.x, member.y));
            });
            state.admitted.removeIf(id -> !state.reservations.containsKey(id) && !state.occupants.contains(id));
            for (Player member : players.values()) {
                if (roomId(member).equals(key.spaceId()) && key.zoneId().equals(Movement.zoneAt(map, member.x, member.y))) {
                    if (state.occupants.add(member.id)) state.reservations.remove(member.id);
                    state.knocks.values().removeIf(knock -> knock.knock().playerId().equals(member.id));
                }
            }
            Player host = players.get(state.hostPlayerId);
            boolean hostAvailable = host != null && state.occupants.contains(host.id)
                && host.connection != null && !host.connection.closed && host.barrier == null;
            if (!state.occupants.isEmpty() && !hostAvailable) {
                String successor = state.occupants.stream()
                    .map(players::get)
                    .filter(Objects::nonNull)
                    .filter(candidate -> candidate.connection != null && !candidate.connection.closed && candidate.barrier == null)
                    .map(candidate -> candidate.id)
                    .findFirst()
                    .orElse("");
                if (!successor.isEmpty()) state.hostPlayerId = successor;
                else if (!state.occupants.contains(state.hostPlayerId)) state.hostPlayerId = "";
            }
            RoomRecordingSession recording = state.recording;
            if (isRoomRecordingActive(recording)) {
                if ("AWAITING_CONSENT".equals(recording.status) && wall >= recording.consentExpiresAt) {
                    requestStopRoomRecording(state, recording, "EXPIRED", wall);
                } else if ("RECORDING".equals(recording.status) && wall - recording.startedAt >= TimeUnit.HOURS.toMillis(1)) {
                    requestStopRoomRecording(state, recording, "EXPIRED", wall);
                } else if (!"STOPPING".equals(recording.status) && !roomRecordingRosterMatches(state, recording)) {
                    requestStopRoomRecording(state, recording, "STOPPED", wall);
                }
            }
            if (!state.occupants.isEmpty()) {
                state.noteMeetingActive = true;
                RoomNotesStore storage = roomNotesStore;
                if (storage != null && !state.notePresenceRegistered) {
                    storage.resume(state.spaceId, state.mapId, key.zoneId());
                    state.notePresenceRegistered = true;
                    state.nextRoomNoteTouchAt = wall + 5_000;
                } else if (storage != null && wall >= state.nextRoomNoteTouchAt) {
                    storage.touch(state.spaceId, state.mapId, key.zoneId());
                    state.nextRoomNoteTouchAt = wall + 5_000;
                }
            }
            if (state.occupants.isEmpty()) {
                endRoomNoteMeeting(state, key.zoneId(), wall);
                state.locked = false; state.hostPlayerId = ""; state.admitted.clear(); state.reservations.clear();
                state.knocks.clear(); state.entryNoticeAt.clear(); state.knockCooldowns.clear();
                Zone zone = privateZone(map, key.zoneId());
                state.capacity = zone == null || zone.capacity() == null || zone.capacity() < 2 || zone.capacity() > 100
                    ? 12 : zone.capacity().intValue();
            }
            return false;
        });
    }
    private void endRoomNoteMeeting(RoomRuntime state, String zoneId, long endedAt) {
        if (!state.noteMeetingActive && !state.notePresenceRegistered) return;
        state.noteMeetingActive = false;
        RoomNotesStore storage = roomNotesStore;
        if (storage != null && state.notePresenceRegistered && !state.spaceId.isBlank() && !state.mapId.isBlank())
            storage.end(state.spaceId, state.mapId, zoneId, endedAt);
        state.notePresenceRegistered = false;
        state.nextRoomNoteTouchAt = 0;
    }
    private RoomView roomView(RoomRuntime state, Zone zone, String viewerId) {
        var knocks = !state.hostPlayerId.isBlank() && viewerId.equals(state.hostPlayerId)
            ? state.knocks.values().stream().map(PendingRoomKnock::knock).toList()
            : List.<RoomKnock>of();
        return new RoomView(zone.id(), zone.name(), state.locked, state.capacity, state.occupants.size(), state.hostPlayerId, knocks);
    }
    private RoomViewCatalog roomViewCatalog(String roomId, MapDefinition map) {
        List<Zone> zones = map.zones().stream().filter(zone -> "PRIVATE".equals(zone.kind())).toList();
        List<RoomRuntime> states = new ArrayList<>(zones.size());
        List<RoomView> sharedViews = new ArrayList<>(zones.size());
        for (Zone zone : zones) {
            RoomRuntime state = roomRuntime(roomId, zone.id());
            states.add(state);
            sharedViews.add(roomView(state, zone, ""));
        }

        Map<String, List<RoomView>> hostViews = new HashMap<>();
        for (int index = 0; index < zones.size(); index++) {
            RoomRuntime state = states.get(index);
            if (state.hostPlayerId.isBlank() || state.knocks.isEmpty()) continue;
            List<RoomView> views = hostViews.computeIfAbsent(
                state.hostPlayerId, ignored -> new ArrayList<>(sharedViews));
            views.set(index, roomView(state, zones.get(index), state.hostPlayerId));
        }
        Map<String, List<RoomView>> immutableHostViews = new HashMap<>(hostViews.size());
        hostViews.forEach((hostId, views) -> immutableHostViews.put(hostId, List.copyOf(views)));
        return new RoomViewCatalog(List.copyOf(sharedViews), Map.copyOf(immutableHostViews));
    }
    private void step() {
        long stepStarted = System.nanoTime();
        try {
            long phaseStarted = System.nanoTime();
            for (int i = 0; i < 512; i++) { Runnable command = commands.poll(); if (command == null) break; command.run(); }
            metrics.recordTickPhase("commands", System.nanoTime() - phaseStarted);

            phaseStarted = System.nanoTime();
            boolean processedJoinCommands = false;
            int joinBudget = Math.max(1, Math.min(512, maxJoinsPerTick));
            for (int i = 0; i < joinBudget; i++) {
                Runnable command = joinCommands.poll();
                if (command == null) break;
                processedJoinCommands = true;
                long joinCommandStarted = System.nanoTime();
                try { command.run(); }
                finally { metrics.recordJoinCommand(System.nanoTime() - joinCommandStarted); }
            }
            metrics.recordTickPhase("joins", System.nanoTime() - phaseStarted);

            phaseStarted = System.nanoTime();
            long now = System.nanoTime();
            long wall = System.currentTimeMillis();
            Iterator<Player> it = players.values().iterator();
            while (it.hasNext()) {
                Player p = it.next();
                String playerRoomId = roomId(p);
                MapDefinition map = roomMaps.get(playerRoomId).map();
                Movement.CollisionGrid collisionGrid = roomMovementGrids.get(playerRoomId);
                if (collisionGrid == null) {
                    collisionGrid = new Movement.CollisionGrid(map);
                    roomMovementGrids.put(playerRoomId, collisionGrid);
                }
                if (p.ownershipLeaseDeadlineNanos > 0 && now >= p.ownershipLeaseDeadlineNanos) {
                    markEventLeave(p);
                    Connection expired = p.connection;
                    p.connection = null;
                    if (expired != null) {
                        expired.player = null;
                        expired.joinRequested = true;
                        expired.input.set(null);
                        fail(expired, "WORLD_OWNER_LOST", "월드 연결 소유권이 만료되어 접속을 종료했어요. 다시 입장해 주세요.");
                    }
                    resumable.remove(p.token, p);
                    queueSeatRelease(p);
                    it.remove();
                    decrementSpacePlayerCount(p.spaceId);
                    continue;
                }
                if (p.connection != null && p.connection.closed) {
                    markEventLeave(p);
                    p.connection = null; p.detachedAt = wall; p.move = null; p.moving = false;
                    p.microphoneOn = false;
                }
                if (p.connection == null) {
                    if (wall - p.detachedAt > 15_000) {
                        resumable.remove(p.token); queueSeatRelease(p); it.remove(); decrementSpacePlayerCount(p.spaceId);
                    }
                    continue;
                }
                markEventAttendance(p, wall);
                if (p.joinTransfer != null && wall >= p.joinTransfer.expiresAt) {
                    p.joinTransfer = null;
                    if (p.barrier != null && p.barrier.forMap) p.barrier = null;
                }
                if (p.joinTransfer != null && !p.joinTransfer.resultSent
                    && (p.barrier == null || p.barrier.confirmed || now >= p.barrier.deadline)) {
                    p.joinTransfer.resultSent = true;
                    joinResult(p, p.joinTransfer.pending, true, true, p.joinTransfer.mapId,
                        "", "승인되어 상대가 있는 지도로 이동해요.");
                }
                if(p.barrier!=null) {
                    if(!p.barrier.forMap&&(p.barrier.confirmed||now>=p.barrier.deadline)) {
                        p.x=p.barrier.x;p.y=p.barrier.y;p.barrier=null;
                    } else { p.move=null;p.moving=false;p.connection.input.set(null);continue; }
                }
                if (p.joinTransfer != null) {
                    p.move = null; p.moving = false; p.connection.input.set(null); continue;
                }
                TimedInput input = p.connection.input.getAndSet(null);
                if (input != null && input.move.epoch() == p.epoch && input.move.seq() > p.ackSeq) {
                    p.move = input.move; p.ackSeq = input.move.seq(); p.lastInputAt = input.received;
                }
                p.moving = false;
                if (p.move != null && now - p.lastInputAt < 300_000_000L) {
                    Move m = p.move;
                    if (m.dx() != 0 || m.dy() != 0) p.sitting = false;
                    var next = Movement.step(collisionGrid, p.x, p.y, m.dx(), m.dy(), m.running(), .05);
                    if (!reserveRoomEntry(p, map, next.x(), next.y(), wall)) continue;
                    if(media.enabled()&&!domain(map,p,p.x,p.y).equals(domain(map,p,next.x(),next.y()))) { beginBarrier(p,next.x(),next.y(),false);continue; }
                    p.moving = next.x() != p.x || next.y() != p.y;
                    p.x = next.x(); p.y = next.y();
                    if (m.dy() != 0) p.direction = m.dy() > 0 ? "down" : "up";
                    else if (m.dx() != 0) p.direction = m.dx() > 0 ? "right" : "left";
                }
            }
            seatLeaseSnapshot = players.values().stream()
                .filter(p -> p.seatId != null && !p.seatId.isBlank() && p.ticketUserId != null && !p.ticketUserId.isBlank()
                    && p.ownerNodeId != null && !p.ownerNodeId.isBlank() && p.ownershipFence > 0)
                .map(p -> new JoinTickets.SeatLease(p.spaceId, p.seatId, p.token, p.ticketUserId, p.ownerSessionId,
                    p.ownerNodeId, p.ownershipFence))
                .toList();
            normalizeEvents();
            metrics.recordTickPhase("simulation", System.nanoTime() - phaseStarted);

            phaseStarted = System.nanoTime();
            // Coalesce roster fanout until queued work drains and the final join
            // batch's tick completes; otherwise each bounded batch rebuilds the roster.
            if (commands.isEmpty() && joinCommands.isEmpty() && !processedJoinCommands)
                broadcastDirtySpaceParticipants();
            broadcastDirtyEventStates();
            syncRoomOccupancy(wall);
            metrics.recordTickPhase("room_state", System.nanoTime() - phaseStarted);

            phaseStarted = System.nanoTime();
            for(var entry:new ArrayList<>(pendingMaps.entrySet())) {
                var members=players.values().stream().filter(p->roomId(p).equals(entry.getKey())&&p.connection!=null).toList();
                for(var p:members)if(p.barrier==null||!p.barrier.forMap)beginBarrier(p,p.x,p.y,true);
                if(members.stream().allMatch(p->p.barrier.confirmed||now>=p.barrier.deadline)){pendingMaps.remove(entry.getKey());applyMap(entry.getKey(),entry.getValue());}
            }
            expireJoinRequests(wall);
            refreshUserBlocks(wall);
            refreshUserModeration(wall);
            refreshSpaceAccess(wall);
            if (wall >= nextDndPresenceSnapshotAt) {
                nextDndPresenceSnapshotAt = wall + 2_000;
                publishDndPresenceSnapshot();
            }
            tick++;
            metrics.recordTickPhase("maintenance", System.nanoTime() - phaseStarted);
            if (tick % 2 != 0) return;

            phaseStarted = System.nanoTime();
            publishMedia(wall);
            metrics.recordTickPhase("media_policy", System.nanoTime() - phaseStarted);
            phaseStarted = System.nanoTime();
            var rooms = new HashMap<String, List<Player>>();
            for (Player p : players.values()) if (p.connection != null && p.blockDataReady && p.moderationDataReady && p.spaceAccessReady)
                rooms.computeIfAbsent(roomId(p), id -> new ArrayList<>()).add(p);
            var snapshotEncoder = new WorldSnapshotEncoder(json);
            var currentStates = new IdentityHashMap<List<PlayerView>, Map<String, PlayerView>>();
            var deltaStates = new IdentityHashMap<List<PlayerView>, IdentityHashMap<Map<String, PlayerView>, SnapshotDelta>>();
            boolean joinBurstInProgress = processedJoinCommands || !joinCommands.isEmpty();
            long snapshotViewNanos = 0;
            long snapshotFanoutNanos = 0;
            long snapshotPrepareNanos = 0;
            long snapshotEncodeNanos = 0;
            long snapshotQueueNanos = 0;
            for (var room : rooms.values()) {
                long snapshotViewStarted = System.nanoTime();
                String currentRoomId = roomId(room.getFirst());
                MapDefinition map = roomMaps.get(currentRoomId).map();
                RoomViewCatalog roomViewCatalog = roomViewCatalog(currentRoomId, map);
                var interest = new WorldInterest.Index<PlayerView>();
                for (Player player : room) {
                    var view = new PlayerView(player.id, player.name, player.avatar, player.skin, player.clothing, player.hair,
                        Math.round(player.x * 256) / 256.0, Math.round(player.y * 256) / 256.0, player.direction, player.moving,
                        Movement.zoneAt(map, player.x, player.y), wall < player.emojiUntil ? player.emoji : "", player.emojiUntil,
                        player.sitting, player.status, player.microphoneOn,
                        !player.ownerUserId.isBlank() && player.blockDataReady && player.moderationDataReady && player.spaceAccessReady,
                        player.bio, player.links, player.manager);
                    interest.add(view.x(), view.y(), view);
                }
                snapshotViewNanos += System.nanoTime() - snapshotViewStarted;
                long snapshotFanoutStarted = System.nanoTime();
                for (Player p : room) {
                    long snapshotPrepareStarted = System.nanoTime();
                    List<PlayerView> visibleViews = interest.visibleTo(p.x, p.y);
                    Map<String, PlayerView> currentState = currentStates.computeIfAbsent(visibleViews, candidates -> {
                        var currentPlayers = new LinkedHashMap<String, PlayerView>();
                        candidates.forEach(view -> currentPlayers.put(view.id(), view));
                        return Map.copyOf(currentPlayers);
                    });
                    Connection c = p.connection;
                    if (c.pendingSnapshotTick >= 0) {
                        if (now - c.pendingSnapshotAt < 1_500_000_000L) {
                            publishBlockState(p);
                            snapshotPrepareNanos += System.nanoTime() - snapshotPrepareStarted;
                            continue;
                        }
                        clearSnapshotState(c);
                        if (++c.snapshotSyncFailures >= MAX_SNAPSHOT_SYNC_FAILURES) {
                            disconnect(c);
                            continue;
                        }
                    }
                    // Wait until the bounded join queue drains before serializing snapshots.
                    // Sending partial full rosters for each batch repeatedly encodes the
                    // growing player list; the first post-burst full state already contains
                    // every participant, while established clients receive a normal delta.
                    if (joinBurstInProgress) {
                        publishBlockState(p);
                        snapshotPrepareNanos += System.nanoTime() - snapshotPrepareStarted;
                        continue;
                    }
                    c.snapshotStates.put(tick, currentState);
                    while (c.snapshotStates.size() > 32)
                        c.snapshotStates.remove(c.snapshotStates.keySet().iterator().next());
                    boolean full = c.acknowledgedSnapshotPlayers == null;
                    long baseTick = full ? -1 : c.acknowledgedSnapshotTick;
                    List<PlayerView> snapshotPlayers;
                    List<String> removedPlayerIds;
                    if (full) {
                        snapshotPlayers = visibleViews;
                        removedPlayerIds = List.of();
                    } else {
                        Map<String, PlayerView> acknowledgedPlayers = c.acknowledgedSnapshotPlayers;
                        IdentityHashMap<Map<String, PlayerView>, SnapshotDelta> byAcknowledgedState =
                            deltaStates.computeIfAbsent(visibleViews, ignored -> new IdentityHashMap<>());
                        SnapshotDelta delta = byAcknowledgedState.computeIfAbsent(acknowledgedPlayers, previous ->
                            new SnapshotDelta(
                                visibleViews.stream()
                                    .filter(view -> !Objects.equals(previous.get(view.id()), view)).toList(),
                                previous.keySet().stream()
                                    .filter(id -> !currentState.containsKey(id)).toList()));
                        snapshotPlayers = delta.players();
                        removedPlayerIds = delta.removedPlayerIds();
                    }
                    snapshotPrepareNanos += System.nanoTime() - snapshotPrepareStarted;
                    c.pendingSnapshotTick = tick;
                    c.pendingSnapshotAt = now;
                    long snapshotEncodeStarted = System.nanoTime();
                    String payload = snapshotEncoder.encode(new Snapshot("snapshot", tick, wall, full, baseTick, p.ackSeq,
                        snapshotPlayers, removedPlayerIds, map.revision(), roomViewCatalog.forViewer(p.id)));
                    snapshotEncodeNanos += System.nanoTime() - snapshotEncodeStarted;
                    long snapshotQueueStarted = System.nanoTime();
                    if (!c.sender.offer(payload, true)) disconnect(c);
                    publishBlockState(p);
                    snapshotQueueNanos += System.nanoTime() - snapshotQueueStarted;
                }
                snapshotFanoutNanos += System.nanoTime() - snapshotFanoutStarted;
            }
            metrics.recordTickPhase("snapshot_view", snapshotViewNanos);
            metrics.recordTickPhase("snapshot_fanout", snapshotFanoutNanos);
            metrics.recordTickPhase("snapshot_prepare", snapshotPrepareNanos);
            metrics.recordTickPhase("snapshot_encode", snapshotEncodeNanos);
            metrics.recordTickPhase("snapshot_queue", snapshotQueueNanos);
            metrics.recordTickPhase("snapshots", System.nanoTime() - phaseStarted);

            phaseStarted = System.nanoTime();
            var occupied = new HashSet<String>();
            for (Player p : players.values()) occupied.add(roomId(p));
            roomMaps.keySet().removeIf(room -> !occupied.contains(room));
            roomMovementGrids.keySet().removeIf(room -> !occupied.contains(room));
            mapChangedPayloads.keySet().removeIf(room -> !occupied.contains(room));
            scavengerObjectCounts.retainRooms(occupied);
            var applied = new LinkedHashMap<String, WorldMapPublicationStore.AppliedMap>();
            for (Player p : players.values()) if (p.connection != null) {
                PublishedMaps.Published published = roomMaps.get(roomId(p));
                if (published != null) {
                    String key = p.spaceId + "\u0000" + p.mapId;
                    applied.put(key, new WorldMapPublicationStore.AppliedMap(p.spaceId, p.mapId, published.sequence()));
                }
            }
            mapPublicationSnapshot = List.copyOf(applied.values());
            metrics.recordTickPhase("publication", System.nanoTime() - phaseStarted);
        } catch (Exception e) {
            org.slf4j.LoggerFactory.getLogger(getClass()).error("World tick failed ({})", e.getClass().getSimpleName());
        }
        finally { metrics.recordTick(System.nanoTime() - stepStarted, players.size()); }
    }

    private void removeTrackedPlayer(Player player) {
        if (players.remove(player.id, player)) decrementSpacePlayerCount(player.spaceId);
    }

    private void decrementSpacePlayerCount(String spaceId) {
        int remaining = spacePlayerCounts.getOrDefault(spaceId, 0) - 1;
        if (remaining <= 0) spacePlayerCounts.remove(spaceId);
        else spacePlayerCounts.put(spaceId, remaining);
    }
    private void sweep() {
        long now = System.nanoTime();
        for (Connection c : connections.values()) {
            if (c.sender.stalled(now) || (c.player == null && now - c.created > 5_000_000_000L)) disconnect(c);
        }
    }
    private void publishDndPresenceSnapshot() {
        if (dndPresence == null) return;
        List<WorldDndPresence.Entry> active = players.values().stream()
            .filter(player -> player.connection != null && !player.connection.closed
                && player.ownerUserId != null && !player.ownerUserId.isBlank())
            .map(player -> new WorldDndPresence.Entry(player.ownerUserId, player.id, player.status))
            .toList();
        dndPresence.replace(active);
    }
    private void checkSessions() {
        // Redis I/O never runs on the room actor or socket send pool.
        WorldMapPublicationStore publicationStore = mapPublicationStore;
        if (publicationStore != null) try {
            publicationStore.heartbeat(worldNodeId, mapPublicationSnapshot);
        } catch (RuntimeException unavailable) {
            long now = System.currentTimeMillis();
            if (now >= nextMapPublicationWarningAt) {
                nextMapPublicationWarningAt = now + 10_000;
                org.slf4j.LoggerFactory.getLogger(getClass()).warn(
                    "World map publication heartbeat failed ({}); pending map ACKs will retry",
                    unavailable.getClass().getSimpleName());
            }
        }
        try {
            var checked = new HashMap<String, Boolean>();
            for (Connection c : connections.values()) {
                if (c.principal == null) continue;
                boolean active = checked.computeIfAbsent(c.ownerSessionId, id -> auth.active(id, c.principal));
                if (!active) fail(c, "AUTH_REQUIRED", "로그인이 만료되었어요. 나간 뒤 다시 로그인해 주세요.");
            }
            var rooms = new HashSet<String>();
            for (Connection c : connections.values()) if (c.principal != null && rooms.add(roomId(c.spaceId,c.mapId))) {
                var published = auth.map(c.spaceId,c.mapId);
                if (published != null) offerCommand(() -> updateMap(roomId(c.spaceId,c.mapId), published));
            }
            long wall = System.currentTimeMillis();
            if (wall >= nextSeatRenewAt) {
                nextSeatRenewAt = wall + 2_000;
                Map<String, List<JoinTickets.SeatLease>> bySpace = new HashMap<>();
                for (JoinTickets.SeatLease lease : seatLeaseSnapshot) {
                    if (releasingSeatIds.contains(lease.spaceId() + ":" + lease.seatId())) continue;
                    bySpace.computeIfAbsent(lease.spaceId(), ignored -> new ArrayList<>()).add(lease);
                }
                for (var entry : bySpace.entrySet()) {
                    JoinTickets.SeatRenewal renewal = auth.renewSeats(entry.getKey(), entry.getValue());
                    Set<String> ownedSeats = new HashSet<>();
                    for (JoinTickets.SeatLease lease : entry.getValue()) ownedSeats.add(lease.seatId() + ":" + lease.fence());
                    Set<String> rejectedSeats = renewal.rejectedSeatIds();
                    String renewedSpaceId = entry.getKey();
                    offerCommand(() -> {
                        long lostAt = System.nanoTime() - 1;
                        for (Player player : players.values()) {
                            if (!player.spaceId.equals(renewedSpaceId)) continue;
                            String key = player.seatId + ":" + player.ownershipFence;
                            if (rejectedSeats.contains(player.seatId)) player.ownershipLeaseDeadlineNanos = lostAt;
                            else if (ownedSeats.contains(key)) player.ownershipLeaseDeadlineNanos = renewal.leaseDeadlineNanos();
                        }
                    });
                    if (!rejectedSeats.isEmpty()) for (Connection c : connections.values())
                        if (c.principal != null && c.spaceId.equals(renewedSpaceId) && c.player != null
                            && rejectedSeats.contains(c.player.seatId))
                            fail(c, "WORLD_OWNER_LOST", "월드 연결 소유권을 확인할 수 없어 접속을 종료했어요. 다시 입장해 주세요.");
                }
            }
            JoinTickets.Admission admission;
            while ((admission = pendingAdmissionReleases.poll()) != null) auth.release(admission);
            JoinTickets.Ownership ownership;
            while ((ownership = pendingOwnershipReleases.poll()) != null) auth.releaseOwnership(ownership);
            JoinTickets.SeatLease seat;
            while ((seat = pendingSeatReleases.poll()) != null) {
                try { auth.releaseSeat(seat); }
                finally { releasingSeatIds.remove(seat.spaceId() + ":" + seat.seatId()); }
            }
        } catch (RuntimeException unavailable) {
            // Stop the batch on a Redis outage instead of blocking once per connected user.
            for (Connection c : connections.values()) if (c.principal != null)
                fail(c, "AUTH_UNAVAILABLE", "로그인 상태를 확인할 수 없어요. 잠시 후 다시 입장해 주세요.");
        }
    }
    private void updateMap(String worldRoomId, PublishedMaps.Published published) {
        var previous = roomMaps.get(worldRoomId);
        if (previous != null && previous.sequence() >= published.sequence()) return;
        if(media.enabled()&&previous!=null&&players.values().stream().anyMatch(p->roomId(p).equals(worldRoomId)&&p.connection!=null)) {
            var pending=pendingMaps.get(worldRoomId);if(pending==null||pending.sequence()<published.sequence())pendingMaps.put(worldRoomId,published);
            return;
        }
        applyMap(worldRoomId,published);
    }
    private void applyMap(String worldRoomId, PublishedMaps.Published published) {
        long endedAt = System.currentTimeMillis();
        for (var entry : roomRuntimes.entrySet())
            if (entry.getKey().spaceId().equals(worldRoomId)) {
                if (isRoomRecordingActive(entry.getValue().recording)) requestStopRoomRecording(entry.getValue(), entry.getValue().recording, "STOPPED", endedAt);
                endRoomNoteMeeting(entry.getValue(), entry.getKey().zoneId(), endedAt);
            }
        roomRuntimes.keySet().removeIf(key -> key.spaceId().equals(worldRoomId));
        roomMaps.put(worldRoomId, published); var map = published.map();
        roomMovementGrids.put(worldRoomId, new Movement.CollisionGrid(map));
        for (Player p : players.values()) if (roomId(p).equals(worldRoomId)) {
            if (!Movement.canStand(map,p.x,p.y)) { p.x=map.spawnX(); p.y=map.spawnY(); }
            p.move=null;p.moving=false;p.epoch++;p.ackSeq=-1;
            if(p.barrier==null)p.mediaEpoch++;
            p.barrier=null;p.lastMediaState="";
            if(p.connection!=null){resetSnapshotState(p.connection);p.connection.input.set(null);sendMapChanged(p.connection,worldRoomId,published);control(p.connection,new Welcome("welcome",2,p.id,p.token,p.epoch,map.revision(),50,worldFeatures()));}
        }
    }
    private void sendMapChanged(Connection connection, String worldRoomId, PublishedMaps.Published published) {
        try {
            if (published.map() == defaultMap) controlEncoded(connection, defaultMapChangedPayload);
            else {
                CachedMapChange cached = mapChangedPayloads.get(worldRoomId);
                if (cached == null || cached.sequence() != published.sequence()) {
                    cached = new CachedMapChange(published.sequence(), encodeMapChangedPayload(published.map()));
                    mapChangedPayloads.put(worldRoomId, cached);
                }
                controlEncoded(connection, cached.payload());
            }
        } catch (Exception invalid) { disconnect(connection); }
    }
    private String encodeMapChangedPayload(MapDefinition map) {
        try { return json.writeValueAsString(new MapChanged("mapChanged", clientMapView(map))); }
        catch (Exception invalid) { throw new IllegalStateException("Unable to encode the published world map", invalid); }
    }
    private MapDefinition clientMapView(MapDefinition map) {
        List<MapObject> objects = map.objects().stream().map(item -> {
            MapInteraction interaction = item.interaction();
            if (interaction == null || !"SCAVENGER_ITEM".equals(interaction.kind())) return item;
            MapInteraction redacted = new MapInteraction(interaction.kind(), interaction.title(), "",
                interaction.url(), interaction.assetId(), interaction.radius(), interaction.volume());
            return new MapObject(item.id(), item.asset(), item.x(), item.y(), item.scale(), item.direction(), redacted);
        }).toList();
        return new MapDefinition(map.schemaVersion(), map.id(), map.revision(), map.name(), map.width(), map.height(),
            map.spawnX(), map.spawnY(), map.collisions(), objects, map.zones(), map.floors(), map.walls(),
            map.labels(), map.portals());
    }
    private MediaPolicy.Person mediaPerson(MapDefinition map,Player p,double x,double y) {
        String zoneId=Movement.zoneAt(map,x,y);var zone=map.zones().stream().filter(z->z.id().equals(zoneId)).findFirst().orElse(null);
        Set<String> blocked = new HashSet<>();
        if (p.blockDataReady && !p.blockedUserIds.isEmpty())
            for (Player target : players.values())
                if (sameWorld(target,p) && !target.ownerUserId.isBlank()
                    && p.blockedUserIds.contains(target.ownerUserId)) blocked.add(target.id);
        EventRuntime event = events.get(p.spaceId);
        String zoneKind = zone == null ? "PUBLIC" : zone.kind();
        // PRIVATE rooms keep their independent room policy and SILENT zones remain media-free.
        boolean eventMode = event != null && event.active && ("PUBLIC".equals(zoneKind) || "STAGE".equals(zoneKind));
        boolean eventSpeaker = eventMode && eventSpeakerAllowed(map, zoneKind, event.speakerPlayerIds.contains(p.id));
        String kind = eventMode ? "EVENT" : zoneKind;
        MediaPolicy.Scope scope = eventMode ? MediaPolicy.Scope.EVENT : switch (zoneKind) {
            case "PRIVATE" -> MediaPolicy.Scope.PRIVATE_ROOM;
            case "SILENT" -> MediaPolicy.Scope.SILENT;
            default -> MediaPolicy.Scope.NEARBY;
        };
        var domain = new MediaPolicy.Domain(p.spaceId,p.mapId,map.revision(),zoneId,scope,
            eventMode && event != null ? event.eventId : "");
        return new MediaPolicy.Person(p.id,domain,kind,x,y,p.mediaEpoch,
            p.connection!=null&&!p.connection.closed&&p.barrier==null&&p.blockDataReady&&p.moderationDataReady&&p.spaceAccessReady&&"AVAILABLE".equals(p.status),blocked,false,p.moderatedSources,eventSpeaker);
    }
    static boolean eventSpeakerAllowed(MapDefinition map, String zoneKind, boolean designatedSpeaker) {
        if (!designatedSpeaker) return false;
        boolean stageDefined = map.zones().stream().anyMatch(zone -> "STAGE".equals(zone.kind()));
        return !stageDefined || "STAGE".equals(zoneKind);
    }
    private String domain(MapDefinition map,Player p,double x,double y){return mediaPerson(map,p,x,y).domain();}
    private void beginBarrier(Player p,double x,double y,boolean forMap) {
        p.mediaEpoch++;p.move=null;p.moving=false;
        var barrier=new MediaBarrier(p.mediaEpoch,x,y,forMap,System.nanoTime()+2_200_000_000L);p.barrier=barrier;
        emitMedia(p,null,false,false);
        media.revoke(p.id,p.mediaEpoch,()->offerCommand(()->{if(p.barrier==barrier)barrier.confirmed=true;}));
    }
    private void publishMedia(long wall) {
        if(!media.enabled())return;
        var people=players.values().stream().filter(p->p.connection!=null).map(p->mediaPerson(roomMaps.get(roomId(p)).map(),p,p.x,p.y)).toList();
        var decision=mediaPolicy.update(people,wall);
        var epochs=new HashMap<String,Long>();people.forEach(p->epochs.put(p.id(),p.policyEpoch()));
        media.publish(people,decision,applied->offerCommand(()->{
            var byId=new HashMap<String,MediaGateway.Applied>();if(applied!=null)applied.forEach(a->byId.put(a.id(),a));
            epochs.forEach((id,epoch)->{var p=players.get(id);if(p!=null&&p.connection!=null&&p.mediaEpoch==epoch&&p.barrier==null){var value=byId.get(id);emitMedia(p,value,applied!=null&&value!=null&&value.epoch()==epoch,decision.limited().contains(id));}});
        }));
    }
    private void emitMedia(Player p,MediaGateway.Applied applied,boolean available,boolean limited) {
        if(p.connection==null)return;var person=mediaPerson(roomMaps.get(roomId(p)).map(),p,p.x,p.y);
        EventRuntime event = events.get(p.spaceId);
        boolean eventMode = person.eventMode();
        boolean eventSpeaker = person.eventSpeaker();
        EnumSet<MediaPolicy.Source> effectiveModeration = EnumSet.noneOf(MediaPolicy.Source.class);
        effectiveModeration.addAll(p.moderatedSources);
        if (eventMode && !eventSpeaker) effectiveModeration.addAll(EnumSet.allOf(MediaPolicy.Source.class));
        var moderatedSources=effectiveModeration.stream().map(Enum::name).sorted().toList();
        var state=new MediaState("mediaState",p.mediaEpoch,person.domain(),person.kind(),available,p.barrier!=null,limited,MediaPolicy.ENTER_DISTANCE,MediaPolicy.EXIT_DISTANCE,moderatedSources,available?applied.peers():List.of(),available?applied.offers():List.of(),available?applied.engineId():"",eventMode,eventSpeaker,eventMode&&event!=null?event.title:"");
        try{String encoded=json.writeValueAsString(state);if(!encoded.equals(p.lastMediaState)){p.lastMediaState=encoded;if(!p.connection.sender.offer(encoded,false))disconnect(p.connection);}}catch(Exception ignored){disconnect(p.connection);}
    }
    private void mediaRequest(Connection c,MediaRequest request) {
        Player p=c.player;
        if(p==null||p.connection!=c||c.closed)return;
        if (!p.moderationDataReady) { control(c,new MediaReply("mediaReply",request.requestId(),false,"{}","MEDIA_MODERATION_LOADING","운영 조치 상태를 확인하고 있어요."));return; }
        if (!"AVAILABLE".equals(p.status)) { control(c,new MediaReply("mediaReply",request.requestId(),false,"{}","MEDIA_PRESENCE","상태를 온라인으로 바꾸면 근거리 통화를 사용할 수 있어요."));return; }
        if(p.mediaEpoch!=request.policyEpoch()||p.barrier!=null){control(c,new MediaReply("mediaReply",request.requestId(),false,"{}","MEDIA_STALE","대화 구역을 옮기고 있어요."));return;}
        if(c.mediaPending>=8){control(c,new MediaReply("mediaReply",request.requestId(),false,"{}","MEDIA_BUSY","통화 요청이 많아요. 잠시 후 다시 시도해 주세요."));return;}
        c.mediaPending++;
        media.request(p.id,p.mediaEpoch,request.method(),request.dataJson(),reply->offerCommand(()->{
            c.mediaPending--;if(p.connection!=c||c.closed)return;
            if(p.mediaEpoch!=request.policyEpoch()||p.barrier!=null)control(c,new MediaReply("mediaReply",request.requestId(),false,"{}","MEDIA_STALE","대화 구역이 바뀌었어요."));
            else control(c,new MediaReply("mediaReply",request.requestId(),reply.ok(),reply.dataJson(),reply.code(),reply.message()));
        }));
    }
    private void poke(Connection c, Poke request) {
        Player sender = c.player;
        if (sender == null || sender.connection != c) return;
        if (!sender.blockDataReady) {
            pokeAck(c, request, false, "POKE_BLOCKS_LOADING", "차단 설정을 불러오는 중이에요. 잠시 후 다시 시도해 주세요.");
            return;
        }
        if (sender.epoch != request.epoch() || sender.barrier != null) {
            pokeAck(c, request, false, "POKE_STALE", "공간을 옮기는 중이라 지금은 찌를 수 없어요.");
            return;
        }
        if (!"AVAILABLE".equals(sender.status)) {
            pokeAck(c, request, false, "POKE_STATUS", "상태를 온라인으로 바꾸면 찌를 수 있어요.");
            return;
        }
        long now = System.currentTimeMillis();
        Player target = players.get(request.targetId());
        if (target == null || target == sender || target.connection == null || target.connection.closed
            || target.barrier != null || !sameWorld(target, sender) || !target.blockDataReady
            || !"AVAILABLE".equals(target.status)) {
            pokeAck(c, request, false, "POKE_UNAVAILABLE", "지금은 그 사람을 찌를 수 없어요.");
            return;
        }
        MapDefinition map = roomMaps.get(roomId(sender)).map();
        String senderZone = Movement.zoneAt(map, sender.x, sender.y);
        String targetZone = Movement.zoneAt(map, target.x, target.y);
        Zone senderArea = map.zones().stream().filter(zone -> zone.id().equals(senderZone)).findFirst().orElse(null);
        Zone targetArea = map.zones().stream().filter(zone -> zone.id().equals(targetZone)).findFirst().orElse(null);
        boolean senderPrivate = senderArea != null && "PRIVATE".equals(senderArea.kind());
        boolean targetPrivate = targetArea != null && "PRIVATE".equals(targetArea.kind());
        double dx = target.x - sender.x, dy = target.y - sender.y;
        if (dx * dx + dy * dy > 9 || ((senderPrivate || targetPrivate) && !senderZone.equals(targetZone))) {
            pokeAck(c, request, false, "POKE_TOO_FAR", "같은 공간에서 3타일 안에 있는 사람만 찌를 수 있어요.");
            return;
        }
        if (blockedEither(sender, target)) {
            pokeAck(c, request, false, "POKE_BLOCKED", "차단 설정 때문에 서로 상호작용할 수 없어요.");
            return;
        }
        if (!target.allowPokes) {
            pokeAck(c, request, false, "POKE_DISABLED", "상대가 지금은 찌르기를 받지 않아요.");
            return;
        }
        control(target.connection, new PokeEvent("pokeEvent", request.requestId(), sender.id, sender.name,
            target.id, now));
        pokeAck(c, request, true, "", target.name + "님을 콕 찔렀어요.");
    }
    private void pokeAck(Connection c, Poke request, boolean accepted, String code, String message) {
        control(c, new PokeAck("pokeAck", request.requestId(), request.targetId(), accepted, code, message));
    }
    private void chat(Connection c, ChatSend request) {
        Player sender = c.player;
        if (sender == null || sender.connection != c || c.closed) return;
        if (!sender.spaceAccessReady) {
            chatAck(c, request, false, "CHAT_SPACE_ACCESS_LOADING", "공간 입장 권한을 확인하고 있어요. 잠시 후 다시 보내 주세요.");
            return;
        }
        if (!sender.moderationDataReady) {
            chatAck(c, request, false, "CHAT_MODERATION_LOADING", "운영 조치 상태를 확인하고 있어요. 잠시 후 다시 보내 주세요.");
            return;
        }
        if (sender.chatMutedUntil > System.currentTimeMillis()) {
            chatAck(c, request, false, "CHAT_RESTRICTED", "운영 조치로 채팅이 일시 제한된 참가자예요.");
            return;
        }
        if (!sender.blockDataReady) {
            chatAck(c, request, false, "CHAT_BLOCKS_LOADING", "차단 설정을 불러오는 중이에요. 잠시 후 다시 시도해 주세요.");
            return;
        }
        MapDefinition map = "dm".equals(request.channel()) ? null : roomMaps.get(roomId(sender)).map();
        String zoneId = map == null ? "" : Movement.zoneAt(map, sender.x, sender.y);
        String text = request.text().strip();
        String messageZoneId = "space".equals(request.channel()) ? "" : zoneId;
        String requestKey = chatRequestKey(request);
        ChatEvent duplicate = sender.recentChats.get(requestKey);
        if (duplicate != null) {
            if (!duplicate.text().equals(text) || !duplicate.channel().equals(request.channel())
                || !duplicate.conversationId().equals(request.conversationId())
                || !duplicate.zoneId().equals(messageZoneId)) {
                chatAck(c, request, false, "CHAT_IDEMPOTENCY_CONFLICT", "이미 사용한 요청 ID예요. 새 요청 ID로 다시 보내 주세요.");
                return;
            }
            control(c, duplicate);
            chatAck(c, request, true, "", "");
            return;
        }
        if (sender.pendingChats.contains(requestKey)) return;
        if (sender.epoch != request.epoch() || sender.barrier != null) {
            chatAck(c, request, false, "CHAT_STALE", "공간을 옮기는 중이에요. 다시 보내 주세요.");
            return;
        }
        long now = System.nanoTime();
        if (now - sender.chatWindowStart >= 10_000_000_000L) {
            sender.chatWindowStart = now;
            sender.chatCount = 0;
        }
        if (++sender.chatCount > 8) {
            chatAck(c, request, false, "CHAT_RATE_LIMIT", "메시지를 너무 빠르게 보내고 있어요. 잠시 후 다시 시도해 주세요.");
            return;
        }
        if (text.isEmpty() || text.codePointCount(0, text.length()) > 500) {
            chatAck(c, request, false, "CHAT_INVALID", "메시지는 1자 이상 500자 이하로 입력해 주세요.");
            return;
        }
        if ("dm".equals(request.channel())) {
            if (sender.ownerUserId.isBlank() || directMessageStore == null) {
                chatAck(c, request, false, "DM_UNAVAILABLE", "로그인한 계정에서만 1:1 메시지를 보낼 수 있어요.");
                return;
            }
            ChatEvent event = new ChatEvent("chatEvent", UUID.randomUUID().toString(), request.clientMessageId(),
                "dm", request.conversationId(), sender.id, sender.name, sender.avatar, sender.skin, sender.clothing,
                sender.hair, text, System.currentTimeMillis(), "", 0, 0, false);
            sender.pendingChats.add(requestKey);
            boolean queued = directMessageStore.enqueue(directMessageOriginNodeId(), sender.ownerUserId, event, result -> {
                Runnable completed = () -> completeDirectMessage(sender, request, requestKey, result);
                if (!offerCommand(completed)) {
                    sender.pendingChats.remove(requestKey);
                    Connection current = sender.connection;
                    if (current != null) chatAck(current, request, false, "CHAT_BUSY", "월드가 바빠 메시지를 확인하지 못했어요. 다시 시도해 주세요.");
                }
            });
            if (!queued) {
                sender.pendingChats.remove(requestKey);
                chatAck(c, request, false, "CHAT_BUSY", "메시지 저장 요청이 많아요. 잠시 후 다시 시도해 주세요.");
            }
            return;
        }
        Zone zone = map.zones().stream().filter(value -> value.id().equals(zoneId)).findFirst().orElse(null);
        String kind = zone == null ? "PUBLIC" : zone.kind();
        if ("room".equals(request.channel()) && !"PRIVATE".equals(kind)) {
            chatAck(c, request, false, "CHAT_NO_ROOM", "독립 회의실 안에서만 회의실 채팅을 보낼 수 있어요.");
            return;
        }
        if ("nearby".equals(request.channel()) && "PRIVATE".equals(kind)) {
            chatAck(c, request, false, "CHAT_ROOM_REQUIRED", "회의실에서는 회의실 채팅을 사용해 주세요.");
            return;
        }
        if ("space".equals(request.channel()) && "PRIVATE".equals(kind)) {
            chatAck(c, request, false, "CHAT_PRIVATE_NO_SPACE", "독립 회의실에서는 공간 전체 채팅을 사용할 수 없어요.");
            return;
        }
        ChatEvent event = new ChatEvent("chatEvent", UUID.randomUUID().toString(), request.clientMessageId(),
            request.channel(), "", sender.id, sender.name, sender.avatar, sender.skin, sender.clothing, sender.hair,
            text, System.currentTimeMillis(), "space".equals(request.channel()) ? "" : zoneId, 0, 0, false);
        var recipients = players.values().stream().filter(target -> {
            if (target.connection == null || target.connection.closed || target.barrier != null || !target.blockDataReady
                || !target.moderationDataReady || !target.spaceAccessReady
                || !target.spaceId.equals(sender.spaceId) || blockedEither(sender, target)) return false;
            if ("space".equals(request.channel())) {
                PublishedMaps.Published targetPublished = roomMaps.get(roomId(target));
                if (targetPublished == null) return false;
                String targetZoneId = Movement.zoneAt(targetPublished.map(), target.x, target.y);
                return privateZone(targetPublished.map(), targetZoneId) == null;
            }
            if (!sameWorld(target, sender)) return false;
            String targetZoneId = Movement.zoneAt(map, target.x, target.y);
            if ("room".equals(request.channel())) return zoneId.equals(targetZoneId);
            Zone targetZone = map.zones().stream().filter(value -> value.id().equals(targetZoneId)).findFirst().orElse(null);
            String targetKind = targetZone == null ? "PUBLIC" : targetZone.kind();
            if (!kind.equals(targetKind)) return false;
            if ("SILENT".equals(kind) && !zoneId.equals(targetZoneId)) return false;
            double dx = target.x - sender.x, dy = target.y - sender.y;
            return dx * dx + dy * dy <= 36;
        }).toList();
        if (chatPersistence != null && !sender.ownerUserId.isBlank()) {
            List<String> userIds = recipients.stream().map(target -> target.ownerUserId).filter(id -> !id.isBlank()).distinct().toList();
            String mapRevision = map.revision();
            double senderX = sender.x, senderY = sender.y;
            sender.pendingChats.add(requestKey);
            boolean queued = chatPersistence.enqueue(sender.spaceId, sender.ownerUserId, event, userIds, result -> {
                Runnable completed = () -> completeChat(sender, request, requestKey, recipients, mapRevision, kind, senderX, senderY, result);
                if (!offerCommand(completed)) {
                    sender.pendingChats.remove(requestKey);
                    Connection current = sender.connection;
                    if (current != null) chatAck(current, request, false, "CHAT_BUSY", "월드가 바빠 메시지를 확인하지 못했어요. 다시 시도해 주세요.");
                }
            });
            if (!queued) {
                sender.pendingChats.remove(requestKey);
                chatAck(c, request, false, "CHAT_BUSY", "채팅 저장 요청이 많아요. 잠시 후 다시 시도해 주세요.");
            }
            return;
        }
        fanoutChat(sender, request, event, recipients, map, kind, sender.x, sender.y);
    }
    private void completeChat(Player sender, ChatSend request, String requestKey, List<Player> recipients, String mapRevision, String senderKind,
                              double senderX, double senderY, ChatPersistence.StoreResult result) {
        sender.pendingChats.remove(requestKey);
        Connection current = sender.connection;
        if (!result.ok()) {
            if (current != null) chatAck(current, request, false, result.code(), result.message());
            return;
        }
        ChatEvent stored = result.event();
        if (result.inserted()) {
            PublishedMaps.Published latest = roomMaps.get(roomId(sender));
            if (latest != null && latest.map().revision().equals(mapRevision)) {
                MapDefinition map = latest.map();
                for (Player recipient : recipients) {
                    if (authorizedAtDelivery(sender, recipient, sender.spaceId, request.channel(), stored.zoneId(), map,
                        senderKind, senderX, senderY)) control(recipient.connection, stored);
                }
            }
        } else if (current != null && !current.closed) {
            control(current, stored);
        }
        sender.recentChats.put(requestKey, stored);
        while (sender.recentChats.size() > 64) sender.recentChats.remove(sender.recentChats.keySet().iterator().next());
        if (current != null && !current.closed) chatAck(current, request, true, "", "");
    }
    private void fanoutChat(Player sender, ChatSend request, ChatEvent event, List<Player> recipients,
                            MapDefinition map, String senderKind, double senderX, double senderY) {
        for (Player recipient : recipients) {
            if (authorizedAtDelivery(sender, recipient, sender.spaceId, request.channel(), event.zoneId(), map,
                senderKind, senderX, senderY)) control(recipient.connection, event);
        }
        sender.recentChats.put(chatRequestKey(request), event);
        while (sender.recentChats.size() > 64) sender.recentChats.remove(sender.recentChats.keySet().iterator().next());
        if (sender.connection != null) chatAck(sender.connection, request, true, "", "");
    }
    private boolean authorizedAtDelivery(Player sender, Player recipient, String spaceId, String channel, String zoneId,
                                        MapDefinition map, String senderKind, double senderX, double senderY) {
        if (recipient.connection == null || recipient.connection.closed || recipient.barrier != null
            || !recipient.blockDataReady || !recipient.moderationDataReady || !recipient.spaceAccessReady || !recipient.spaceId.equals(spaceId)
            || blockedEither(sender, recipient)) return false;
        if ("space".equals(channel)) {
            PublishedMaps.Published targetPublished = roomMaps.get(roomId(recipient));
            if (targetPublished == null) return false;
            String targetZone = Movement.zoneAt(targetPublished.map(), recipient.x, recipient.y);
            return privateZone(targetPublished.map(), targetZone) == null;
        }
        if (!sameWorld(sender, recipient)) return false;
        String zone = Movement.zoneAt(map, recipient.x, recipient.y);
        if ("room".equals(channel)) return zoneId.equals(zone);
        Zone target = map.zones().stream().filter(value -> value.id().equals(zone)).findFirst().orElse(null);
        String targetKind = target == null ? "PUBLIC" : target.kind();
        if (!senderKind.equals(targetKind) || ("SILENT".equals(senderKind) && !zoneId.equals(zone))) return false;
        double dx = recipient.x - senderX, dy = recipient.y - senderY;
        return dx * dx + dy * dy <= 36;
    }
    private void chatAck(Connection c, ChatSend request, boolean accepted, String code, String message) {
        control(c, new ChatAck("chatAck", request.clientMessageId(), accepted, code, message));
    }
    private void requestDirectConversation(Connection c, DirectConversationRequest request) {
        Player requester = c.player;
        if (requester == null || requester.connection != c || c.closed) return;
        if (requester.epoch != request.epoch() || requester.barrier != null) {
            directConversationResult(c, request, false, "", "DM_STALE", "공간을 옮기는 중이라 대화를 시작할 수 없어요.");
            return;
        }
        if (requester.ownerUserId.isBlank() || directMessageStore == null) {
            directConversationResult(c, request, false, "", "DM_UNAVAILABLE", "로그인한 계정에서만 1:1 대화를 사용할 수 있어요.");
            return;
        }
        if (!requester.blockDataReady) {
            directConversationResult(c, request, false, "", "DM_BLOCKS_LOADING", "차단 설정을 불러오는 중이에요.");
            return;
        }
        long now = System.currentTimeMillis();
        if (now < requester.nextDirectRequestAt) {
            directConversationResult(c, request, false, "", "DM_RATE_LIMIT", "잠시 후 다시 대화를 시작해 주세요.");
            return;
        }
        requester.nextDirectRequestAt = now + 1000;
        Player target = players.get(request.targetPlayerId());
        if (target == null || target == requester || target.connection == null || target.connection.closed
            || target.barrier != null || !target.spaceId.equals(requester.spaceId) || !target.blockDataReady
            || target.ownerUserId.isBlank() || target.ownerUserId.equals(requester.ownerUserId)) {
            directConversationResult(c, request, false, "", "DM_TARGET_UNAVAILABLE", "같은 공간에 있는 다른 로그인 참가자만 대화를 시작할 수 있어요.");
            return;
        }
        if (blockedEither(requester, target)) {
            directConversationResult(c, request, false, "", "DM_BLOCKED", "차단 설정 때문에 대화를 시작할 수 없어요.");
            return;
        }
        boolean queued = directMessageStore.open(requester.ownerUserId, target.ownerUserId, result -> {
            Runnable completed = () -> {
                if (requester.connection != c || requester.epoch != request.epoch() || c.closed) return;
                if (!result.ok()) directConversationResult(c, request, false, "", result.code(), result.message());
                else directConversationResult(c, request, true, result.conversationId(), "", "");
            };
            if (!offerCommand(completed) && requester.connection == c)
                fail(c, "BUSY", "대화 결과를 확인하지 못했어요. 다시 접속해 주세요.");
        });
        if (!queued) directConversationResult(c, request, false, "", "DM_BUSY", "대화 요청이 많아요. 잠시 후 다시 시도해 주세요.");
    }
    private void directConversationResult(Connection c, DirectConversationRequest request, boolean accepted,
                                         String conversationId, String code, String message) {
        control(c, new DirectConversationResult("directConversationResult", request.requestId(),
            request.targetPlayerId(), accepted, conversationId, code, message));
    }
    private void requestGroupConversation(Connection c, GroupConversationRequest request) {
        Player requester = c.player;
        if (requester == null || requester.connection != c || c.closed) return;
        if (requester.epoch != request.epoch() || requester.barrier != null) {
            groupConversationResult(c, request, false, "", "DM_STALE", "공간을 옮기는 중이라 그룹 대화를 시작할 수 없어요.");
            return;
        }
        if (requester.ownerUserId.isBlank() || directMessageStore == null) {
            groupConversationResult(c, request, false, "", "DM_UNAVAILABLE", "로그인한 계정에서만 그룹 대화를 사용할 수 있어요.");
            return;
        }
        if (!requester.blockDataReady) {
            groupConversationResult(c, request, false, "", "DM_BLOCKS_LOADING", "차단 설정을 불러오는 중이에요.");
            return;
        }
        long now = System.currentTimeMillis();
        if (now < requester.nextDirectRequestAt) {
            groupConversationResult(c, request, false, "", "DM_RATE_LIMIT", "잠시 후 다시 그룹 대화를 시작해 주세요.");
            return;
        }
        requester.nextDirectRequestAt = now + 1000;
        Set<String> accountIds = new HashSet<>();
        accountIds.add(requester.ownerUserId);
        for (String playerId : request.memberPlayerIds()) {
            Player invitee = players.get(playerId);
            if (invitee == null || invitee == requester || invitee.connection == null || invitee.connection.closed
                || invitee.barrier != null || !invitee.spaceId.equals(requester.spaceId) || !invitee.blockDataReady
                || invitee.ownerUserId.isBlank() || !accountIds.add(invitee.ownerUserId)) {
                groupConversationResult(c, request, false, "", "GROUP_MEMBER_UNAVAILABLE", "선택한 참가자를 그룹에 추가할 수 없어요.");
                return;
            }
            if (blockedEither(requester, invitee)) {
                groupConversationResult(c, request, false, "", "GROUP_BLOCKED", "차단 설정 때문에 그룹 대화를 만들 수 없어요.");
                return;
            }
        }
        List<String> userIds = new ArrayList<>(accountIds);
        boolean queued = directMessageStore.openGroup(requester.ownerUserId, userIds, request.requestId(),
            request.groupName().strip(), result -> {
                Runnable completed = () -> {
                    if (requester.connection != c || requester.epoch != request.epoch() || c.closed) return;
                    groupConversationResult(c, request, result.ok(), result.conversationId(), result.code(), result.message());
                };
                if (!offerCommand(completed) && requester.connection == c)
                    fail(c, "BUSY", "그룹 대화 결과를 확인하지 못했어요. 다시 접속해 주세요.");
            });
        if (!queued) groupConversationResult(c, request, false, "", "DM_BUSY", "그룹 대화 요청이 많아요. 잠시 후 다시 시도해 주세요.");
    }
    private void groupConversationResult(Connection c, GroupConversationRequest request, boolean accepted,
                                         String conversationId, String code, String message) {
        control(c, new DirectConversationResult("directConversationResult", request.requestId(),
            "", accepted, conversationId, code, message));
    }
    private void requestGroupInvitation(Connection c, GroupInvitationRequest request) {
        Player requester = c.player;
        if (requester == null || requester.connection != c || c.closed) return;
        if (requester.epoch != request.epoch() || requester.barrier != null) {
            groupInvitationAck(c, request, false, "", "GROUP_STALE", "공간을 옮기는 중이라 초대할 수 없어요.");
            return;
        }
        if (requester.ownerUserId.isBlank() || directMessageStore == null) {
            groupInvitationAck(c, request, false, "", "DM_UNAVAILABLE", "로그인한 계정에서만 그룹 초대를 보낼 수 있어요.");
            return;
        }
        if (!requester.blockDataReady) {
            groupInvitationAck(c, request, false, "", "DM_BLOCKS_LOADING", "차단 설정을 불러오는 중이에요.");
            return;
        }
        long now = System.currentTimeMillis();
        if (now < requester.nextDirectRequestAt) {
            groupInvitationAck(c, request, false, "", "DM_RATE_LIMIT", "잠시 후 다시 그룹 초대를 보내 주세요.");
            return;
        }
        Player invitee = players.get(request.targetPlayerId());
        if (invitee == null || invitee == requester || invitee.connection == null || invitee.connection.closed
            || invitee.barrier != null || !invitee.spaceId.equals(requester.spaceId) || !invitee.blockDataReady
            || invitee.ownerUserId.isBlank()) {
            groupInvitationAck(c, request, false, "", "GROUP_MEMBER_UNAVAILABLE", "같은 공간에 있는 로그인 참가자만 초대할 수 있어요.");
            return;
        }
        if (blockedEither(requester, invitee)) {
            groupInvitationAck(c, request, false, "", "GROUP_BLOCKED", "차단 설정 때문에 초대할 수 없어요.");
            return;
        }
        requester.nextDirectRequestAt = now + 1000;
        boolean queued = directMessageStore.inviteGroupMember(requester.ownerUserId, invitee.ownerUserId,
            request.conversationId(), request.requestId(), result -> {
                Runnable completed = () -> {
                    if (requester.connection != c || requester.epoch != request.epoch() || c.closed) return;
                    groupInvitationAck(c, request, result.ok(), result.invitationId(), result.code(), result.message());
                    if (!result.ok() || !result.shouldNotify()) return;
                    GroupInvitationEvent event = new GroupInvitationEvent("groupInvitationEvent", result.invitationId(),
                        result.conversationId(), result.groupName(), requester.name, result.expiresAt());
                    for (Player online : players.values()) {
                        if (online.connection != null && !online.connection.closed
                            && online.ownerUserId.equals(result.inviteeUserId())) control(online.connection, event);
                    }
                };
                if (!offerCommand(completed) && requester.connection == c)
                    fail(c, "BUSY", "초대 결과를 확인하지 못했어요. 다시 접속해 주세요.");
            });
        if (!queued) groupInvitationAck(c, request, false, "", "DM_BUSY", "초대 요청이 많아요. 잠시 후 다시 시도해 주세요.");
    }
    private void groupInvitationAck(Connection c, GroupInvitationRequest request, boolean accepted,
                                    String invitationId, String code, String message) {
        control(c, new GroupInvitationAck("groupInvitationAck", request.requestId(), invitationId,
            request.conversationId(), request.targetPlayerId(), accepted, code, message));
    }
    private void mutateDirectMessage(Connection c, DirectMessageMutationRequest request) {
        Player actor = c.player;
        if (actor == null || actor.connection != c || c.closed) return;
        if (actor.epoch != request.epoch() || actor.barrier != null) {
            directMessageMutationAck(c, request, false, 0, "DM_STALE", "공간을 옮기는 중이라 메시지를 변경할 수 없어요.");
            return;
        }
        if (actor.ownerUserId.isBlank() || directMessageStore == null) {
            directMessageMutationAck(c, request, false, 0, "DM_UNAVAILABLE", "로그인한 계정에서만 메시지를 변경할 수 있어요.");
            return;
        }
        if (!actor.blockDataReady) {
            directMessageMutationAck(c, request, false, 0, "DM_BLOCKS_LOADING", "차단 설정을 불러오는 중이에요.");
            return;
        }
        long now = System.currentTimeMillis();
        if (now < actor.nextDirectMutationAt) {
            directMessageMutationAck(c, request, false, 0, "DM_RATE_LIMIT", "잠시 후 다시 시도해 주세요.");
            return;
        }
        actor.nextDirectMutationAt = now + 800;
        String text = "EDIT".equals(request.action()) ? request.text().strip() : "";
        boolean queued = directMessageStore.mutate(directMessageOriginNodeId(), actor.ownerUserId,
            request.conversationId(), request.messageId(),
            request.requestId(), request.action(), text, result -> {
                Runnable completed = () -> {
                    if (!result.ok()) {
                        if (actor.connection == c && actor.epoch == request.epoch() && !c.closed)
                            directMessageMutationAck(c, request, false, 0, result.code(), result.message());
                        return;
                    }
                    ChatEvent updated = result.event();
                    for (Player session : players.values()) {
                        session.recentChats.replaceAll((key, previous) ->
                            previous.messageId().equals(updated.messageId())
                                ? new ChatEvent(previous.type(), previous.messageId(), previous.clientMessageId(),
                                    previous.channel(), previous.conversationId(), previous.senderId(), previous.senderName(),
                                    previous.avatar(), previous.skin(), previous.clothing(), previous.hair(), updated.text(),
                                    previous.sentAt(), previous.zoneId(), updated.revision(), updated.editedAt(), updated.deleted())
                                : previous);
                    }
                    DirectMessageMutationEvent event = new DirectMessageMutationEvent("directMessageMutationEvent",
                        updated.conversationId(), updated.messageId(), updated.text(), updated.revision(),
                        updated.editedAt(), updated.deleted());
                    for (Player recipient : players.values()) {
                        if (recipient.connection == null || recipient.connection.closed || recipient.barrier != null
                            || !recipient.blockDataReady || !result.memberUserIds().contains(recipient.ownerUserId)
                            || recipient.blockedUserIds.contains(actor.ownerUserId)
                            || actor.blockedUserIds.contains(recipient.ownerUserId)) continue;
                        control(recipient.connection, event);
                    }
                    publishDirectMessageRelay(result.fanoutEventId());
                    if (actor.connection == c && actor.epoch == request.epoch() && !c.closed)
                        directMessageMutationAck(c, request, true, updated.revision(), "", result.message());
                };
                if (!offerCommand(completed) && actor.connection == c)
                    fail(c, "BUSY", "메시지 변경 결과를 확인하지 못했어요. 다시 접속해 주세요.");
            });
        if (!queued)
            directMessageMutationAck(c, request, false, 0, "DM_BUSY", "메시지 변경 요청이 많아요. 잠시 후 다시 시도해 주세요.");
    }
    private void markDirectMessageRead(Connection c, DirectMessageReadRequest request) {
        Player actor = c.player;
        if (actor == null || actor.connection != c || c.closed) return;
        if (actor.epoch != request.epoch() || actor.barrier != null) {
            directMessageReadAck(c, request, false, "DM_STALE", "공간을 옮기는 중이라 읽음 상태를 반영할 수 없어요.");
            return;
        }
        if (actor.ownerUserId.isBlank() || directMessageStore == null) {
            directMessageReadAck(c, request, false, "DM_UNAVAILABLE", "로그인한 계정에서만 메시지 읽음을 표시할 수 있어요.");
            return;
        }
        long now = System.currentTimeMillis();
        if (now < actor.nextDirectReadAt) {
            directMessageReadAck(c, request, false, "DM_READ_RATE_LIMIT", "읽음 상태를 처리 중이에요.");
            return;
        }
        actor.nextDirectReadAt = now + 200;
        boolean queued = directMessageStore.markRead(directMessageOriginNodeId(), actor.ownerUserId,
            request.conversationId(), request.messageId(), result -> {
            Runnable completed = () -> {
                if (actor.connection != c || actor.epoch != request.epoch() || c.closed) return;
                if (!result.ok()) {
                    directMessageReadAck(c, request, false, result.code(), result.message());
                    return;
                }
                DirectMessageReadEvent event = new DirectMessageReadEvent("directMessageReadEvent",
                    result.conversationId(), result.messageId(), result.sentAt(), result.readerMembershipId());
                for (Player recipient : players.values()) {
                    if (recipient.connection == null || recipient.connection.closed || recipient.barrier != null
                        || !recipient.blockDataReady || !result.memberUserIds().contains(recipient.ownerUserId)
                        || actor.ownerUserId.equals(recipient.ownerUserId)
                        || recipient.blockedUserIds.contains(actor.ownerUserId)
                        || actor.blockedUserIds.contains(recipient.ownerUserId)) continue;
                    control(recipient.connection, event);
                }
                publishDirectMessageRelay(result.fanoutEventId());
                directMessageReadAck(c, request, true, "", "");
            };
            if (!offerCommand(completed) && actor.connection == c)
                directMessageReadAck(c, request, false, "WORLD_BUSY", "읽음 상태를 확인하지 못했어요. 다시 시도해 주세요.");
        });
        if (!queued)
            directMessageReadAck(c, request, false, "DM_BUSY", "읽음 상태 요청이 많아요. 잠시 후 다시 시도해 주세요.");
    }
    private void directMessageReadAck(Connection c, DirectMessageReadRequest request, boolean accepted,
                                      String code, String message) {
        control(c, new DirectMessageReadAck("directMessageReadAck", request.requestId(),
            request.conversationId(), request.messageId(), accepted, code, message));
    }
    private void directMessageMutationAck(Connection c, DirectMessageMutationRequest request, boolean accepted,
                                          long revision, String code, String message) {
        control(c, new DirectMessageMutationAck("directMessageMutationAck", request.requestId(),
            request.conversationId(), request.messageId(), accepted, revision, code, message));
    }
    private void completeDirectMessage(Player sender, ChatSend request, String requestKey,
                                       DirectMessageStore.StoreResult result) {
        sender.pendingChats.remove(requestKey);
        Connection current = sender.connection;
        if (!result.ok()) {
            if (current != null && !current.closed) chatAck(current, request, false, result.code(), result.message());
            return;
        }
        ChatEvent stored = result.event();
        if (current != null && !current.closed) control(current, stored);
        if (result.recipientUserIds().stream().noneMatch(sender.blockedUserIds::contains)) {
            for (Player recipient : players.values()) {
                if (recipient.connection == null || recipient.connection.closed || !recipient.blockDataReady || !recipient.moderationDataReady || !recipient.spaceAccessReady
                    || !result.recipientUserIds().contains(recipient.ownerUserId)
                    || recipient.blockedUserIds.contains(sender.ownerUserId)) continue;
                control(recipient.connection, stored);
            }
            publishDirectMessageRelay(result.fanoutEventId());
        }
        sender.recentChats.put(requestKey, stored);
        while (sender.recentChats.size() > 64) sender.recentChats.remove(sender.recentChats.keySet().iterator().next());
        if (current != null && !current.closed) chatAck(current, request, true, "", "");
    }
    private String directMessageOriginNodeId() {
        DirectMessageFanout fanout = directMessageFanout;
        return fanout == null ? "00000000-0000-0000-0000-000000000000" : fanout.nodeId();
    }
    private void publishDirectMessageRelay(long eventId) {
        DirectMessageFanout fanout = directMessageFanout;
        if (fanout != null) fanout.publish(eventId);
    }
    private boolean receiveDirectMessageRelay(DirectMessageFanout.Relay relay) {
        DirectMessageFanout fanout = directMessageFanout;
        if (fanout != null && fanout.nodeId().equals(relay.originNodeId())) return true;
        if (!offerCommand(() -> applyDirectMessageRelay(relay))) {
            org.slf4j.LoggerFactory.getLogger(getClass()).warn("Deferring live DM fan-out because world command queue is full");
            return false;
        }
        return true;
    }
    private void applyDirectMessageRelay(DirectMessageFanout.Relay relay) {
        try {
            switch (relay.type()) {
                case "ignored" -> { }
                case "message" -> {
                    ChatEvent event = json.treeToValue(relay.payload(), ChatEvent.class);
                    if (!"dm".equals(event.channel())) return;
                    for (Player recipient : players.values()) {
                        if (recipient.connection == null || recipient.connection.closed || recipient.barrier != null
                            || !recipient.blockDataReady || !recipient.moderationDataReady || !recipient.spaceAccessReady
                            || !relay.memberUserIds().contains(recipient.ownerUserId)
                            || recipient.blockedUserIds.contains(relay.actorUserId())) continue;
                        control(recipient.connection, event);
                    }
                }
                case "mutation" -> {
                    DirectMessageMutationEvent event = json.treeToValue(relay.payload(), DirectMessageMutationEvent.class);
                    for (Player session : players.values()) {
                        session.recentChats.replaceAll((key, previous) -> previous.messageId().equals(event.messageId())
                            ? new ChatEvent(previous.type(), previous.messageId(), previous.clientMessageId(), previous.channel(),
                                previous.conversationId(), previous.senderId(), previous.senderName(), previous.avatar(),
                                previous.skin(), previous.clothing(), previous.hair(), event.text(), previous.sentAt(),
                                previous.zoneId(), event.revision(), event.editedAt(), event.deleted()) : previous);
                    }
                    for (Player recipient : players.values()) {
                        if (recipient.connection == null || recipient.connection.closed || recipient.barrier != null
                            || !recipient.blockDataReady || !relay.memberUserIds().contains(recipient.ownerUserId)
                            || recipient.blockedUserIds.contains(relay.actorUserId())) continue;
                        control(recipient.connection, event);
                    }
                }
                case "read" -> {
                    DirectMessageReadEvent event = json.treeToValue(relay.payload(), DirectMessageReadEvent.class);
                    for (Player recipient : players.values()) {
                        if (recipient.connection == null || recipient.connection.closed || recipient.barrier != null
                            || !recipient.blockDataReady || relay.actorUserId().equals(recipient.ownerUserId)
                            || !relay.memberUserIds().contains(recipient.ownerUserId)
                            || recipient.blockedUserIds.contains(relay.actorUserId())) continue;
                        control(recipient.connection, event);
                    }
                }
                default -> org.slf4j.LoggerFactory.getLogger(getClass()).warn("Ignoring unknown live DM fan-out event");
            }
        } catch (Exception invalid) {
            org.slf4j.LoggerFactory.getLogger(getClass()).warn("Ignoring malformed live DM fan-out event: {}",
                invalid.getClass().getSimpleName());
        }
    }
    private static String chatRequestKey(ChatSend request) {
        return request.channel() + ":" + request.conversationId() + ":" + request.clientMessageId();
    }
    private static boolean validUuid(String value) {
        if (value == null || value.length() > 36) return false;
        try { return UUID.fromString(value).toString().equalsIgnoreCase(value); }
        catch (IllegalArgumentException invalid) { return false; }
    }
    private void control(Connection c, Object payload) {
        try { controlEncoded(c, json.writeValueAsString(payload)); }
        catch (Exception e) { disconnect(c); }
    }
    private void controlEncoded(Connection c, String payload) {
        if (!c.sender.offer(payload, false)) disconnect(c);
    }
    private void acknowledgeSnapshot(Connection c, SnapshotAck ack) {
        if (c.player == null || c.player.connection != c || ack.tick() <= c.acknowledgedSnapshotTick
            || ack.tick() != c.pendingSnapshotTick) return;
        if (!ack.applied()) {
            clearSnapshotState(c);
            if (++c.snapshotSyncFailures >= MAX_SNAPSHOT_SYNC_FAILURES) disconnect(c);
            return;
        }
        Map<String, PlayerView> state = c.snapshotStates.remove(ack.tick());
        if (state == null) {
            clearSnapshotState(c);
            if (++c.snapshotSyncFailures >= MAX_SNAPSHOT_SYNC_FAILURES) disconnect(c);
            return;
        }
        c.acknowledgedSnapshotPlayers = state;
        c.acknowledgedSnapshotTick = ack.tick();
        c.pendingSnapshotTick = -1;
        c.pendingSnapshotAt = 0;
        c.snapshotSyncFailures = 0;
        c.snapshotStates.keySet().removeIf(tick -> tick <= ack.tick());
    }
    private void resetSnapshotState(Connection c) {
        clearSnapshotState(c);
        c.snapshotSyncFailures = 0;
    }
    private void clearSnapshotState(Connection c) {
        c.snapshotStates.clear();
        c.acknowledgedSnapshotPlayers = null;
        c.acknowledgedSnapshotTick = -1;
        c.pendingSnapshotTick = -1;
        c.pendingSnapshotAt = 0;
    }
    private void fail(Connection c, String code, String message) {
        recordAnalytics(ProductAnalytics.Metric.WORLD_REJECTION);
        control(c, new ErrorMessage("error", code, message));
        ticker.schedule(() -> disconnect(c), 100, TimeUnit.MILLISECONDS);
    }
    private void recordAnalytics(ProductAnalytics.Metric metric) {
        ProductAnalytics analytics = productAnalytics;
        if (analytics != null) analytics.record(metric);
    }
    private void releaseAdmission(Connection c) {
        if (c.admissionReleased) return;
        c.admissionReleased = true;
        if (c.admission != null && !c.admission.reusedSeat()) pendingAdmissionReleases.offer(c.admission);
    }
    private void queueSeatRelease(Player player) {
        if (player.seatId != null && !player.seatId.isBlank() && !player.ticketUserId.isBlank()
            && !player.ownerNodeId.isBlank() && player.ownershipFence > 0) {
            releasingSeatIds.add(player.spaceId + ":" + player.seatId);
            pendingSeatReleases.offer(new JoinTickets.SeatLease(player.spaceId, player.seatId, player.token,
                player.ticketUserId, player.ownerSessionId, player.ownerNodeId, player.ownershipFence));
        }
    }
    private void queueOwnershipRelease(JoinTickets.Ownership ownership) {
        if (ownership != null && ownership.newlyClaimed()) pendingOwnershipReleases.offer(ownership);
    }
    private void claimSeatAsync(Connection c, Join request, String resumeToken) {
        try {
            authChecks.execute(() -> {
                JoinTickets.Ownership ownership;
                try {
                    boolean sameSessionTabHandoff = c.admission.reusedSeat() && request.resumeToken().isEmpty();
                    ownership = auth.claimSeat(c.spaceId, c.admission.seatId(), resumeToken,
                        c.principal.userId(), c.ownerSessionId, worldNodeId, sameSessionTabHandoff);
                } catch (RuntimeException unavailable) {
                    if (!offerCommand(() -> {
                        releaseAdmission(c);
                        if (connections.containsKey(c.session.getId()))
                            fail(c, "SPACE_CAPACITY_UNAVAILABLE", "공간 정원을 확인할 수 없어 접속을 종료했어요. 잠시 후 다시 입장해 주세요.");
                    })) fail(c, "SPACE_CAPACITY_UNAVAILABLE", "공간 정원을 확인할 수 없어 접속을 종료했어요. 잠시 후 다시 입장해 주세요.");
                    return;
                }
                if (ownership == null) {
                    if (!offerCommand(() -> {
                        releaseAdmission(c);
                        if (connections.containsKey(c.session.getId()))
                            fail(c, "WORLD_OWNER_BUSY", "이 참가자의 이전 월드 연결이 아직 살아 있어요. 이전 연결이 정리된 뒤 다시 입장해 주세요.");
                    })) fail(c, "WORLD_OWNER_BUSY", "이 참가자의 이전 월드 연결이 아직 살아 있어요. 이전 연결이 정리된 뒤 다시 입장해 주세요.");
                    return;
                }
                if (!offerJoinCommand(() -> join(c, request, ownership))) {
                    auth.releaseOwnership(ownership);
                    fail(c, "BUSY", "월드가 바쁩니다. 잠시 후 다시 접속해 주세요.");
                }
            });
        } catch (RejectedExecutionException unavailable) {
            releaseAdmission(c);
            fail(c, "SPACE_CAPACITY_UNAVAILABLE", "공간 정원을 확인할 수 없어 접속을 종료했어요. 잠시 후 다시 입장해 주세요.");
        }
    }
    private static String newResumeToken() { return UUID.randomUUID() + "-" + UUID.randomUUID(); }
    private void disconnect(Connection c) {
        if (connections.remove(c.session.getId(), c)) {
            releaseAdmission(c);
            // Detach is observed on the next tick even if the command queue is full.
            c.closed = true;
            Player player = c.player;
            if (dndPresence != null && player != null && !player.ownerUserId.isBlank())
                dndPresence.remove(player.ownerUserId, player.id);
            closes.execute(() -> { try { c.sender.close(); } finally { socketSlots.release(); } });
        }
    }
    @Override public void afterConnectionClosed(WebSocketSession session, CloseStatus status) {
        Connection c = connections.get(session.getId()); if (c != null) disconnect(c);
    }
    @Override public void handleTransportError(WebSocketSession session, Throwable exception) {
        Connection c = connections.get(session.getId()); if (c != null) disconnect(c);
    }
    @PreDestroy public void shutdown() {
        WorldMapPublicationStore publicationStore = mapPublicationStore;
        if (publicationStore != null) try { publicationStore.removeNode(worldNodeId); }
        catch (RuntimeException unavailable) { org.slf4j.LoggerFactory.getLogger(getClass()).warn("Could not expire world map publication targets during shutdown", unavailable); }
        authChecks.shutdownNow(); ticker.shutdownNow(); connections.values().forEach(c -> c.sender.close()); sends.shutdownNow(); closes.shutdownNow();
    }
    private List<String> worldFeatures() {
        if (!roomExtrasEnabled) return WORLD_FEATURES;
        ArrayList<String> features = new ArrayList<>(WORLD_FEATURES);
        features.addAll(ROOM_EXTRA_FEATURES);
        return List.copyOf(features);
    }
    private static final class Connection {
        final WebSocketSession session; final SessionSender sender;
        final TownPrincipal principal;
        final boolean guest;
        final String ownerSessionId;
        final String spaceId;
        final String mapId;
        final int capacity;
        final PublishedMaps.Published map;
        final JoinTickets.Admission admission;
        String pendingResumeToken;
        final AtomicReference<TimedInput> input = new AtomicReference<>();
        final LinkedHashMap<Long, Map<String, PlayerView>> snapshotStates = new LinkedHashMap<>();
        Map<String, PlayerView> acknowledgedSnapshotPlayers;
        long acknowledgedSnapshotTick = -1, pendingSnapshotTick = -1, pendingSnapshotAt;
        int snapshotSyncFailures;
        final long created = System.nanoTime();
        volatile Player player; volatile boolean closed;
        volatile boolean joinRequested; long windowStart; int messages,mediaPending;
        long nextProfileReadAt;
        Connection(WebSocketSession session, SessionSender sender) {
            this.session = session; this.sender = sender;
            this.principal = (TownPrincipal)session.getAttributes().get(WorldAuthentication.PRINCIPAL);
            this.guest = Boolean.TRUE.equals(session.getAttributes().get(WorldAuthentication.GUEST));
            this.ownerSessionId = (String)session.getAttributes().get(WorldAuthentication.SESSION_ID);
            var admission = (JoinTickets.Admission)session.getAttributes().get(WorldAuthentication.ADMISSION);
            this.spaceId = admission == null ? "preview" : admission.spaceId();
            this.mapId = admission == null ? "preview" : admission.mapId();
            this.capacity = admission == null ? 100 : admission.capacity();
            this.map = (PublishedMaps.Published)session.getAttributes().get(WorldAuthentication.MAP);
            this.admission = admission;
        }
        boolean admissionReleased;
    }
    private record TimedInput(Move move, long received) {}
    private record SnapshotDelta(List<PlayerView> players, List<String> removedPlayerIds) {}
    private record RoomViewCatalog(List<RoomView> shared, Map<String, List<RoomView>> hostViews) {
        List<RoomView> forViewer(String playerId) { return hostViews.getOrDefault(playerId, shared); }
    }
    private record CachedMapChange(long sequence, String payload) {}
    private record RoomKey(String spaceId, String zoneId) {}
    private record PendingRoomKnock(RoomKnock knock) {}
    private static final class RoomRuntime {
        String spaceId = "", mapId = "";
        boolean noteMeetingActive, notePresenceRegistered;
        long nextRoomNoteTouchAt;
        int capacity = 12;
        boolean locked;
        String hostPlayerId = "";
        RoomRecordingSession recording;
        final LinkedHashSet<String> occupants = new LinkedHashSet<>();
        final Set<String> admitted = new HashSet<>();
        final Map<String, Long> reservations = new HashMap<>();
        final Map<String, Long> entryNoticeAt = new HashMap<>();
        final Map<String, Long> knockCooldowns = new HashMap<>();
        final LinkedHashMap<String, PendingRoomKnock> knocks = new LinkedHashMap<>();
    }
    private static final class RoomRecordingParticipantRuntime {
        final String playerId, userId, name;
        final long epoch, mediaEpoch;
        String decision;
        long respondedAt;
        RoomRecordingParticipantRuntime(String playerId, String userId, String name, long epoch, long mediaEpoch,
                                        String decision, long respondedAt) {
            this.playerId = playerId; this.userId = userId; this.name = name;
            this.epoch = epoch; this.mediaEpoch = mediaEpoch; this.decision = decision; this.respondedAt = respondedAt;
        }
    }
    private static final class RoomRecordingSession {
        final String recordingId, zoneId, worldRoomId, domain, spaceId, mapId, mapRevision,
            requestedByPlayerId, requestedByUserId, requestedByName;
        final List<String> sources;
        final boolean transcribe;
        final long requestedAt, consentExpiresAt;
        final LinkedHashMap<String, RoomRecordingParticipantRuntime> participants;
        String status = "AWAITING_CONSENT", stopStatus = "", failureCode = "";
        long startedAt, endedAt, trackCount;
        boolean startPending, stopWanted;
        RoomRecordingSession(String recordingId, String zoneId, String worldRoomId, String spaceId, String mapId,
                             String mapRevision, String domain, List<String> sources, boolean transcribe,
                             String requestedByPlayerId, String requestedByUserId, String requestedByName, long requestedAt,
                             long consentExpiresAt, LinkedHashMap<String, RoomRecordingParticipantRuntime> participants) {
            this.recordingId = recordingId; this.zoneId = zoneId; this.domain = domain;
            this.worldRoomId = worldRoomId;
            this.spaceId = spaceId; this.mapId = mapId; this.mapRevision = mapRevision;
            this.sources = sources; this.transcribe = transcribe; this.requestedByPlayerId = requestedByPlayerId;
            this.requestedByUserId = requestedByUserId; this.requestedByName = requestedByName; this.requestedAt = requestedAt;
            this.consentExpiresAt = consentExpiresAt; this.participants = participants;
        }
    }
    private record PendingJoin(String requestId, String requesterId, String targetId,
                               String requesterSpaceId, String requesterMapId,
                               String targetSpaceId, String targetMapId,
                               long requesterEpoch, long targetEpoch, long expiresAt) {}
    private static final class JoinTransfer {
        final String mapId;
        final double x, y;
        final long expiresAt;
        final PendingJoin pending;
        boolean resultSent;
        JoinTransfer(String mapId, double x, double y, long expiresAt, PendingJoin pending) {
            this.mapId = mapId; this.x = x; this.y = y; this.expiresAt = expiresAt; this.pending = pending;
        }
    }
    private static final class Player {
        final String id = UUID.randomUUID().toString(); final String token;
        String name; long avatar; String skin, clothing, hair, bio; List<String> links; String seatId = "";
        JoinTransfer joinTransfer;
        final String ticketUserId;
        String ownerNodeId = ""; long ownershipFence, ownershipLeaseDeadlineNanos;
        final String ownerSessionId;
        final String spaceId;
        String mapId;
        String worldRoomId;
        Connection connection; Move move; double x, y;
        long epoch, ackSeq = -1, lastInputAt, detachedAt, emojiUntil, nextEmoteAt, nextPresenceAt, nextProfileUpdateAt;
        boolean moving, sitting, microphoneOn; String direction = "down", emoji = "";
        String status = "AVAILABLE";
        boolean allowPokes;
        long nextJoinRequestAt, nextDirectRequestAt, nextDirectMutationAt, nextDirectReadAt, nextPlayerReportAt, nextRoomNoteSaveAt;
        boolean blockDataReady, blockLoadComplete, moderationDataReady, spaceAccessReady;
        boolean manager;
        String lastBlockState;
        final Set<String> blockedUserIds = new HashSet<>();
        final Set<String> pendingBlockUserIds = ConcurrentHashMap.newKeySet();
        final Set<String> pendingReportedUserIds = ConcurrentHashMap.newKeySet();
        long mediaEpoch;MediaBarrier barrier;String lastMediaState="";
        String attendanceEventId=""; long attendanceTouchedAt;
        final Set<MediaPolicy.Source> moderatedSources = EnumSet.noneOf(MediaPolicy.Source.class);
        long chatWindowStart; int chatCount;
        final LinkedHashMap<String, ChatEvent> recentChats = new LinkedHashMap<>();
        final Set<String> pendingChats = ConcurrentHashMap.newKeySet();
        final String ownerUserId;
        String moderationSubjectId = "";
        long chatMutedUntil;
        Player(String token, String name, long avatar, String skin, String clothing, String hair, String bio, List<String> links, double x, double y,
               String ownerUserId, String ticketUserId, String ownerSessionId, String spaceId, String mapId) {
            this.token = token; this.name = name; this.avatar = avatar; this.skin = skin; this.clothing = clothing; this.hair = hair; this.bio = bio == null ? "" : bio; this.links = links == null ? List.of() : List.copyOf(links);
            this.x = x; this.y = y; this.ownerUserId = ownerUserId; this.ticketUserId = ticketUserId; this.ownerSessionId = ownerSessionId;
            this.spaceId = spaceId; this.mapId = mapId; this.worldRoomId = WorldHandler.roomId(spaceId, mapId);
        }
    }
    private static final class EventRuntime {
        boolean active;
        String eventId = "";
        long startedAt;
        boolean attendanceEnabled = true;
        String title = "";
        String description = "";
        String resourceUrl = "";
        String hostPlayerId = "";
        final LinkedHashSet<String> speakerPlayerIds = new LinkedHashSet<>();
        final LinkedHashSet<String> raisedHandPlayerIds = new LinkedHashSet<>();
        final LinkedHashSet<String> attendeePlayerIds = new LinkedHashSet<>();
        List<EventParticipant> participants = List.of();
        final LinkedHashMap<String, EventQuestionRuntime> questions = new LinkedHashMap<>();
        final Map<String, Long> questionAt = new HashMap<>();
        final Map<String, Integer> quizScores = new HashMap<>();
        final Map<String, String> quizScoreNames = new HashMap<>();
        EventPollRuntime poll;
        EventScavengerRuntime scavenger;
        int pollCount;
        long revision;
        long broadcastedRevision = -1;
        long engagementBroadcastedRevision = -1;
    }
    private static final class EventQuestionRuntime {
        final String id, askerPlayerId, askerUserId, askerName, text;
        boolean answered;
        String answer = "", answererName = "";
        EventQuestionRuntime(String id, String askerPlayerId, String askerUserId, String askerName, String text) {
            this.id = id; this.askerPlayerId = askerPlayerId; this.askerUserId = askerUserId; this.askerName = askerName; this.text = text;
        }
        EventQuestion view() { return new EventQuestion(id, askerPlayerId, askerName, text, answered, answer, answererName); }
    }
    private static final class EventPollRuntime {
        final String id, question;
        final List<String> options;
        final int[] counts;
        final Map<String, Integer> votes = new HashMap<>();
        final Map<String, String> voterNames = new HashMap<>();
        final boolean quiz;
        final int correctOptionIndex;
        boolean closed;
        EventPollRuntime(String id, String question, List<String> options, boolean quiz, int correctOptionIndex) {
            this.id = id; this.question = question; this.options = List.copyOf(options); this.counts = new int[options.size()];
            this.quiz = quiz; this.correctOptionIndex = correctOptionIndex;
        }
    }
    private static final class EventScavengerRuntime {
        final String mapId, mapRevision, mapName;
        final LinkedHashMap<String, EventScavengerItem> items;
        final Set<String> npcObjectIds;
        final Set<String> unlockedParticipantKeys = new HashSet<>();
        final Map<String, String> participantNames = new HashMap<>();
        final LinkedHashMap<String, EventScavengerProgress> progress = new LinkedHashMap<>();
        boolean active = true;
        EventScavengerRuntime(String mapId, String mapRevision, String mapName,
                              LinkedHashMap<String, EventScavengerItem> items, Set<String> npcObjectIds) {
            this.mapId = mapId; this.mapRevision = mapRevision; this.mapName = mapName;
            this.items = new LinkedHashMap<>(items); this.npcObjectIds = Set.copyOf(npcObjectIds);
        }
    }
    private static final class EventScavengerProgress {
        String name;
        final LinkedHashSet<String> collectedObjectIds = new LinkedHashSet<>();
        EventScavengerProgress(String name) { this.name = name; }
    }
    private static final class MediaBarrier {
        final long epoch,deadline;final double x,y;final boolean forMap;boolean confirmed;
        MediaBarrier(long epoch,double x,double y,boolean forMap,long deadline){this.epoch=epoch;this.x=x;this.y=y;this.forMap=forMap;this.deadline=deadline;}
    }
}
