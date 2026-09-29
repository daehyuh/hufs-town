package town.hufs.world;

import org.junit.jupiter.api.Test;

import java.util.UUID;

import static org.assertj.core.api.Assertions.assertThat;

class RecordingMetadataIdTest {
    @Test void previewValuesBecomeStableScopedUuids() {
        String space = RecordingMetadataId.resolve(true, "space", "preview");
        String map = RecordingMetadataId.resolve(true, "map", "preview");

        assertThat(UUID.fromString(space)).isNotNull();
        assertThat(space).isEqualTo(RecordingMetadataId.resolve(true, "space", "preview"));
        assertThat(space).isNotEqualTo(map);
    }

    @Test void productionAndAlreadyValidPreviewUuidsArePreserved() {
        String productionValue = "account-subject";
        String previewUuid = "caeb8012-1499-4f66-a146-17e4c2947fe2";

        assertThat(RecordingMetadataId.resolve(false, "user", productionValue)).isEqualTo(productionValue);
        assertThat(RecordingMetadataId.resolve(true, "user", previewUuid)).isEqualTo(previewUuid);
    }
}
