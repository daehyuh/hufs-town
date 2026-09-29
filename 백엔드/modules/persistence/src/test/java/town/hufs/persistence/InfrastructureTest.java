package town.hufs.persistence;

import org.flywaydb.core.Flyway;
import org.junit.jupiter.api.Tag;
import org.junit.jupiter.api.Test;
import org.testcontainers.containers.GenericContainer;
import org.testcontainers.containers.MariaDBContainer;
import org.testcontainers.junit.jupiter.Container;
import org.testcontainers.junit.jupiter.Testcontainers;
import org.springframework.data.redis.connection.lettuce.LettuceConnectionFactory;
import java.sql.DriverManager;
import static org.assertj.core.api.Assertions.*;

@Tag("infrastructure")
@Testcontainers
class InfrastructureTest {
    @Container static MariaDBContainer<?> database = new MariaDBContainer<>("mariadb:11.4.10");
    @Container static GenericContainer<?> redis = new GenericContainer<>("redis:7.4.8-alpine").withExposedPorts(6379);
    @Test void migratesRealMariaDbAndEnforcesProviderSubjectIdentity() throws Exception {
        var flyway = Flyway.configure().dataSource(database.getJdbcUrl(), database.getUsername(), database.getPassword()).load();
        assertThat(flyway.migrate().migrationsExecuted).isGreaterThan(0);
        assertThat(flyway.migrate().migrationsExecuted).isZero();
        try (var c = DriverManager.getConnection(database.getJdbcUrl(), database.getUsername(), database.getPassword()); var s = c.createStatement()) {
            s.executeUpdate("INSERT INTO app_user(id,display_name) VALUES ('11111111-1111-1111-1111-111111111111','후프 🌳')");
            s.executeUpdate("INSERT INTO oauth_identity(user_id,provider,subject) VALUES ('11111111-1111-1111-1111-111111111111','google','subject')");
            assertThatThrownBy(() -> s.executeUpdate("INSERT INTO oauth_identity(user_id,provider,subject) VALUES ('11111111-1111-1111-1111-111111111111','google','subject')")).isInstanceOf(java.sql.SQLException.class);
        }
    }
    @Test void connectsToRealRedis() {
        var factory = new LettuceConnectionFactory(redis.getHost(), redis.getMappedPort(6379));
        factory.afterPropertiesSet(); factory.start();
        try (var connection = factory.getConnection()) { assertThat(connection.ping()).isEqualTo("PONG"); }
        finally { factory.destroy(); }
    }
}
