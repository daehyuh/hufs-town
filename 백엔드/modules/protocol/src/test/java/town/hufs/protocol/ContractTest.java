package town.hufs.protocol;
import com.fasterxml.jackson.databind.*;
import org.junit.jupiter.api.Test;
import static org.assertj.core.api.Assertions.*;
class ContractTest {
    final ObjectMapper json = new ObjectMapper().enable(DeserializationFeature.FAIL_ON_MISSING_CREATOR_PROPERTIES).enable(DeserializationFeature.FAIL_ON_UNKNOWN_PROPERTIES);
    @Test void readsSharedFixtures() throws Exception {
        var join = json.readValue(getClass().getResourceAsStream("/join.json"), Join.class);
        var move = json.readValue(getClass().getResourceAsStream("/move.json"), Move.class);
        assertThat(join.name()).isEqualTo("후프");
        assertThat(move.seq()).isEqualTo(7);
        assertThat(move.dx()).isEqualTo(0.5);
        assertThat(move.dy()).isEqualTo(-0.125);
        assertThat(MapLoader.campus().schemaVersion()).isEqualTo(2);
        assertThat(MapLoader.campus().revision()).isEqualTo("office-v2");
        assertThat(MapLoader.campus().name()).isEqualTo("GDG HUFS 훕스타운");
        assertThat(MapLoader.campus().labels()).isEmpty();
        assertThat(OfficeCatalog.asset("desk-monitor").width()).isEqualTo(48);
    }
    @Test void loadsBrandedCampusSquareWithEveryMapAssetInTheRuntimeCatalog() {
        var map = MapLoader.template("CAMPUS_SQUARE");
        var assets = map.objects().stream().map(MapObject::asset).toList();
        assertThat(map.id()).isEqualTo("campus-square");
        assertThat(map.name()).isEqualTo("캠퍼스 광장");
        assertThat(assets).contains("gdg-sign", "campus-tree-large", "campus-bush", "campus-house-large");
        assertThat(assets).allSatisfy(id -> assertThat(OfficeCatalog.asset(id)).as(id).isNotNull());
    }
    @Test void rejectsMissingFields() {
        assertThatThrownBy(() -> json.readValue("{\"type\":\"move\"}", Move.class)).isInstanceOf(JsonMappingException.class);
    }
}
