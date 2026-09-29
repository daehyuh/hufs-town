package town.hufs.world;

import java.nio.charset.StandardCharsets;
import java.util.UUID;

/** Keeps disposable preview identities compatible with the SFU's UUID metadata contract. */
final class RecordingMetadataId {
    private RecordingMetadataId() {}

    static String resolve(boolean preview, String scope, String value) {
        if (!preview || isUuid(value)) return value;
        return UUID.nameUUIDFromBytes(("hufs-town-preview-recording:" + scope + ":" + value)
            .getBytes(StandardCharsets.UTF_8)).toString();
    }

    private static boolean isUuid(String value) {
        if (value == null || !value.matches("[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89aAbB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}"))
            return false;
        return true;
    }
}
