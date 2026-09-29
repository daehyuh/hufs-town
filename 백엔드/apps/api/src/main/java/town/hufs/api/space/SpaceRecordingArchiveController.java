package town.hufs.api.space;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import jakarta.annotation.PreDestroy;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.http.ContentDisposition;
import org.springframework.http.HttpHeaders;
import org.springframework.http.HttpStatus;
import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;
import org.springframework.security.core.annotation.AuthenticationPrincipal;
import org.springframework.web.bind.annotation.*;
import org.springframework.web.servlet.mvc.method.annotation.StreamingResponseBody;
import town.hufs.auth.TownPrincipal;

import java.io.InputStream;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.charset.StandardCharsets;
import java.time.Duration;
import java.util.ArrayList;
import java.util.List;
import java.util.Set;
import java.util.UUID;
import java.util.regex.Pattern;

@RestController
@RequestMapping("/api/v1/spaces/{spaceId}/recordings")
@ConditionalOnProperty(name = "town.auth.mode", havingValue = "sso", matchIfMissing = true)
class SpaceRecordingArchiveController {
    private static final Pattern UUID_PATTERN = Pattern.compile("(?i)^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$");
    private static final Pattern SINGLE_BYTE_RANGE = Pattern.compile("bytes=(?:\\d+-\\d*|-\\d+)");
    private static final Pattern SAFE_CONTENT_RANGE = Pattern.compile("bytes (?:\\d+-\\d+|\\*)/\\d+");
    private static final Set<String> MANAGER_ROLES = Set.of("OWNER", "ADMIN");

    private final Spaces spaces;
    private final ObjectMapper json;
    private final HttpClient http;
    private final String mediaEndpoint;
    private final String mediaToken;

    SpaceRecordingArchiveController(Spaces spaces, ObjectMapper json,
                                    @Value("${MEDIA_CONTROL_URL:http://127.0.0.1:18082}") String mediaEndpoint,
                                    @Value("${MEDIA_CONTROL_TOKEN:}") String mediaToken) {
        this.spaces = spaces;
        this.json = json;
        this.http = HttpClient.newBuilder().connectTimeout(Duration.ofSeconds(2)).build();
        this.mediaEndpoint = mediaEndpoint == null ? "" : mediaEndpoint.replaceAll("/+$", "");
        this.mediaToken = mediaToken == null ? "" : mediaToken;
    }

    record Track(String trackId, String source, long bytes) {}
    record Recording(String recordingId, String mapId, String mapRevision, String zoneId,
                     long startedAt, long endedAt, long retentionExpiresAt, List<String> sources,
                     String transcriptionStatus, List<Track> tracks, long bytes, boolean canDelete) {}
    record ArchivePage(List<Recording> recordings, long usedBytes, Long spaceUsedBytes, Long spaceQuotaBytes,
                       boolean transcriptionAvailable) {}
    record DeleteResult(String recordingId, boolean deleted) {}

    @GetMapping
    ArchivePage list(@PathVariable String spaceId, @AuthenticationPrincipal TownPrincipal principal) {
        Spaces.Space space = memberSpace(spaceId, principal);
        JsonNode result = post("recording/list-space", json.createObjectNode().put("spaceId", spaceId));
        JsonNode rows = result.path("recordings");
        if (!rows.isArray()) throw unavailable();
        boolean manager = MANAGER_ROLES.contains(space.role());
        List<Recording> visible = new ArrayList<>();
        long visibleBytes = 0;
        for (JsonNode row : rows) {
            if (!spaceId.equals(text(row, "spaceId"))) continue;
            boolean requestedByUser = principal.userId().equals(text(row, "requestedByUserId"));
            if (!manager && !contains(row.path("participants"), principal.userId())) continue;
            Recording recording = recording(row, manager || requestedByUser);
            visible.add(recording);
            visibleBytes = Math.addExact(visibleBytes, recording.bytes());
        }
        Long spaceUsedBytes = manager && result.path("usedBytes").canConvertToLong()
            ? result.path("usedBytes").asLong() : null;
        Long spaceQuotaBytes = manager && result.path("quotaBytes").canConvertToLong()
            ? result.path("quotaBytes").asLong() : null;
        return new ArchivePage(List.copyOf(visible), visibleBytes, spaceUsedBytes, spaceQuotaBytes,
            result.path("transcriptionAvailable").asBoolean(false));
    }

    @DeleteMapping("/{recordingId}")
    DeleteResult delete(@PathVariable String spaceId, @PathVariable String recordingId,
                        @AuthenticationPrincipal TownPrincipal principal) {
        Spaces.Space space = memberSpace(spaceId, principal);
        requireUuid(recordingId);
        JsonNode metadata = metadata(recordingId);
        authorizeRecording(spaceId, space, principal.userId(), metadata);
        boolean manager = MANAGER_ROLES.contains(space.role());
        if (!manager && !principal.userId().equals(text(metadata, "requestedByUserId")))
            throw new SpaceFailure(403, "RECORDING_DELETE_FORBIDDEN", "이 녹화를 삭제할 권한이 없어요.");
        JsonNode result = post("recording/delete-space", json.createObjectNode()
            .put("spaceId", spaceId).put("recordingId", recordingId));
        return new DeleteResult(text(result, "recordingId"), result.path("deleted").asBoolean(false));
    }

    @GetMapping("/{recordingId}/tracks/{trackId}/content")
    ResponseEntity<StreamingResponseBody> content(@PathVariable String spaceId, @PathVariable String recordingId,
                                                   @PathVariable String trackId, @RequestParam(defaultValue = "false") boolean download,
                                                   @RequestHeader(value = HttpHeaders.RANGE, required = false) String range,
                                                   @AuthenticationPrincipal TownPrincipal principal) {
        Spaces.Space space = memberSpace(spaceId, principal);
        requireUuid(recordingId);
        requireUuid(trackId);
        validateRange(range);
        JsonNode metadata = metadata(recordingId);
        authorizeRecording(spaceId, space, principal.userId(), metadata);
        if (!containsTrack(metadata.path("tracks"), trackId)) throw notFound();

        HttpResponse<InputStream> upstream = openTrack(recordingId, trackId, range);
        if (upstream.statusCode() == 416) {
            try { upstream.body().close(); } catch (Exception ignored) { }
            HttpHeaders headers = safeMediaHeaders(upstream, download, trackId, sourceFor(metadata.path("tracks"), trackId));
            headers.setContentLength(0);
            return ResponseEntity.status(HttpStatus.REQUESTED_RANGE_NOT_SATISFIABLE).headers(headers).build();
        }
        if (upstream.statusCode() != 200 && upstream.statusCode() != 206) {
            try { upstream.body().close(); } catch (Exception ignored) { }
            throw mediaFailure(upstream.statusCode());
        }
        HttpHeaders headers = safeMediaHeaders(upstream, download, trackId, sourceFor(metadata.path("tracks"), trackId));
        StreamingResponseBody body = output -> {
            try (InputStream input = upstream.body()) {
                input.transferTo(output);
            }
        };
        return ResponseEntity.status(upstream.statusCode()).headers(headers).body(body);
    }

    @GetMapping("/{recordingId}/transcript")
    ResponseEntity<JsonNode> transcript(@PathVariable String spaceId, @PathVariable String recordingId,
                                        @AuthenticationPrincipal TownPrincipal principal) {
        Spaces.Space space = memberSpace(spaceId, principal);
        requireUuid(recordingId);
        JsonNode metadata = metadata(recordingId);
        authorizeRecording(spaceId, space, principal.userId(), metadata);
        if (!"READY".equals(text(metadata, "transcriptionStatus")))
            throw new SpaceFailure(409, "RECORDING_UNAVAILABLE", "아직 자막을 불러올 수 없어요.");
        JsonNode result = transcriptFromMedia(recordingId);
        HttpHeaders headers = new HttpHeaders();
        headers.setCacheControl("no-store, private");
        headers.set("X-Content-Type-Options", "nosniff");
        return ResponseEntity.ok().headers(headers).body(result);
    }

    private Spaces.Space memberSpace(String spaceId, TownPrincipal principal) {
        if (principal == null) throw new SpaceFailure(401, "AUTH_REQUIRED", "로그인이 필요해요.");
        Spaces.Space space = spaces.detail(spaceId, principal.userId());
        if (space.role() == null || space.role().isBlank())
            throw new SpaceFailure(403, "SPACE_MEMBER_REQUIRED", "공간에 가입한 계정만 녹화 기록을 볼 수 있어요.");
        return space;
    }

    private JsonNode metadata(String recordingId) {
        return post("recording/metadata", json.createObjectNode().put("recordingId", recordingId));
    }

    private static void authorizeRecording(String spaceId, Spaces.Space space, String userId, JsonNode metadata) {
        if (!spaceId.equals(text(metadata, "spaceId"))) throw notFound();
        if (MANAGER_ROLES.contains(space.role()) || contains(metadata.path("participants"), userId)) return;
        throw new SpaceFailure(403, "RECORDING_FORBIDDEN", "녹화 참가자만 이 기록을 볼 수 있어요.");
    }

    private static Recording recording(JsonNode value, boolean canDelete) {
        String recordingId = text(value, "recordingId");
        requireUuid(recordingId);
        List<String> sources = strings(value.path("sources"));
        List<Track> tracks = new ArrayList<>();
        JsonNode trackRows = value.path("tracks");
        if (trackRows.isArray()) {
            for (JsonNode track : trackRows) {
                String id = text(track, "trackId");
                String source = text(track, "source");
                if (!UUID_PATTERN.matcher(id).matches() || source.isBlank() || !source.matches("[A-Z_]{1,24}")) continue;
                tracks.add(new Track(id, source, Math.max(0, track.path("bytes").asLong())));
            }
        }
        return new Recording(recordingId, text(value, "mapId"), text(value, "mapRevision"), text(value, "zoneId"),
            Math.max(0, value.path("startedAt").asLong()), Math.max(0, value.path("endedAt").asLong()),
            Math.max(0, value.path("retentionExpiresAt").asLong()), sources,
            safeTranscriptionStatus(text(value, "transcriptionStatus")), List.copyOf(tracks),
            Math.max(0, value.path("bytes").asLong()), canDelete);
    }

    private JsonNode transcriptFromMedia(String recordingId) {
        if (mediaToken.length() < 32 || mediaEndpoint.isBlank()) throw unavailable();
        HttpRequest request = HttpRequest.newBuilder(URI.create(mediaEndpoint + "/v1/recording/transcript/" + recordingId))
            .timeout(Duration.ofSeconds(30)).header("Authorization", "Bearer " + mediaToken).GET().build();
        try {
            HttpResponse<InputStream> response = http.send(request, HttpResponse.BodyHandlers.ofInputStream());
            try (InputStream body = response.body()) {
                if (response.statusCode() != 200) throw mediaFailure(response.statusCode());
                byte[] bytes = body.readNBytes(8 * 1024 * 1024 + 1);
                if (bytes.length > 8 * 1024 * 1024) throw unavailable();
                JsonNode parsed = json.readTree(bytes);
                if (parsed == null || !parsed.isObject() || !recordingId.equals(text(parsed, "recordingId"))
                    || !parsed.path("segments").isArray() || parsed.path("segments").size() > 10_000) throw unavailable();
                return parsed;
            }
        } catch (InterruptedException interrupted) {
            Thread.currentThread().interrupt();
            throw unavailable();
        } catch (SpaceFailure failure) {
            throw failure;
        } catch (Exception failure) {
            throw unavailable();
        }
    }

    private static String safeTranscriptionStatus(String status) {
        return Set.of("QUEUED", "PROCESSING", "READY", "FAILED").contains(status) ? status : "NOT_REQUESTED";
    }

    private JsonNode post(String route, JsonNode body) {
        if (mediaToken.length() < 32 || mediaEndpoint.isBlank()) throw unavailable();
        try {
            HttpRequest request = HttpRequest.newBuilder(URI.create(mediaEndpoint + "/v1/" + route))
                .timeout(Duration.ofSeconds(10)).header("Authorization", "Bearer " + mediaToken)
                .header("Content-Type", "application/json")
                .POST(HttpRequest.BodyPublishers.ofString(json.writeValueAsString(body), StandardCharsets.UTF_8)).build();
            HttpResponse<String> response = http.send(request, HttpResponse.BodyHandlers.ofString(StandardCharsets.UTF_8));
            if (response.statusCode() != 200) throw mediaFailure(response.statusCode());
            JsonNode parsed = json.readTree(response.body());
            if (parsed == null || !parsed.isObject()) throw unavailable();
            return parsed;
        } catch (InterruptedException interrupted) {
            Thread.currentThread().interrupt();
            throw unavailable();
        } catch (SpaceFailure failure) {
            throw failure;
        } catch (Exception failure) {
            throw unavailable();
        }
    }

    private HttpResponse<InputStream> openTrack(String recordingId, String trackId, String range) {
        if (mediaToken.length() < 32 || mediaEndpoint.isBlank()) throw unavailable();
        try {
            HttpRequest.Builder builder = HttpRequest.newBuilder(URI.create(mediaEndpoint + "/v1/recording/file/" + recordingId + "/" + trackId))
                .timeout(Duration.ofSeconds(30)).header("Authorization", "Bearer " + mediaToken).GET();
            if (range != null) builder.header(HttpHeaders.RANGE, range);
            return http.send(builder.build(), HttpResponse.BodyHandlers.ofInputStream());
        } catch (InterruptedException interrupted) {
            Thread.currentThread().interrupt();
            throw unavailable();
        } catch (Exception failure) {
            throw unavailable();
        }
    }

    private static HttpHeaders safeMediaHeaders(HttpResponse<?> upstream, boolean download, String trackId, String source) {
        HttpHeaders headers = new HttpHeaders();
        headers.setContentType(MediaType.valueOf("video/webm"));
        headers.setCacheControl("no-store, private");
        headers.set("Accept-Ranges", "bytes");
        headers.set("X-Content-Type-Options", "nosniff");
        headers.setContentDisposition(ContentDisposition.builder(download ? "attachment" : "inline")
            .filename(safeFileName(source, trackId)).build());
        upstream.headers().firstValueAsLong("Content-Length").ifPresent(headers::setContentLength);
        upstream.headers().firstValue("Content-Range").filter(value -> SAFE_CONTENT_RANGE.matcher(value).matches())
            .ifPresent(value -> headers.set("Content-Range", value));
        return headers;
    }

    private static String safeFileName(String source, String trackId) {
        String prefix = switch (source) {
            case "MICROPHONE" -> "microphone";
            case "CAMERA" -> "camera";
            case "SCREEN" -> "screen";
            default -> "recording";
        };
        return prefix + "-" + trackId.substring(0, 8) + ".webm";
    }

    private static String sourceFor(JsonNode tracks, String trackId) {
        if (tracks.isArray()) for (JsonNode track : tracks)
            if (trackId.equals(text(track, "trackId"))) return text(track, "source");
        return "";
    }

    private static List<String> strings(JsonNode values) {
        if (!values.isArray()) return List.of();
        List<String> output = new ArrayList<>();
        for (JsonNode value : values) if (value.isTextual() && value.textValue().matches("[A-Z_]{1,24}")) output.add(value.textValue());
        return List.copyOf(output);
    }

    private static boolean contains(JsonNode values, String expected) {
        if (!values.isArray()) return false;
        for (JsonNode value : values) if (value.isTextual() && expected.equals(value.textValue())) return true;
        return false;
    }

    private static boolean containsTrack(JsonNode tracks, String trackId) {
        if (!tracks.isArray()) return false;
        for (JsonNode track : tracks) if (trackId.equals(text(track, "trackId"))) return true;
        return false;
    }

    private static String text(JsonNode value, String field) {
        JsonNode node = value == null ? null : value.get(field);
        return node != null && node.isTextual() ? node.textValue() : "";
    }

    private static void validateRange(String range) {
        if (range == null) return;
        if (range.length() > 80 || !SINGLE_BYTE_RANGE.matcher(range).matches())
            throw new SpaceFailure(400, "RECORDING_RANGE_INVALID", "요청한 재생 구간이 올바르지 않아요.");
    }

    private static void requireUuid(String value) {
        if (value == null || !UUID_PATTERN.matcher(value).matches()) throw notFound();
    }

    private static SpaceFailure mediaFailure(int status) {
        if (status == 404) return notFound();
        if (status == 409) return new SpaceFailure(409, "RECORDING_UNAVAILABLE", "녹화가 아직 처리 중이거나 삭제할 수 없어요.");
        return unavailable();
    }

    private static SpaceFailure notFound() {
        return new SpaceFailure(404, "RECORDING_NOT_FOUND", "녹화 기록이나 파일을 찾을 수 없어요.");
    }

    private static SpaceFailure unavailable() {
        return new SpaceFailure(503, "RECORDING_ARCHIVE_UNAVAILABLE", "녹화 기록을 불러오지 못했어요. 잠시 후 다시 시도해 주세요.");
    }

    @PreDestroy
    void close() { http.close(); }
}
