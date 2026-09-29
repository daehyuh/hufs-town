package town.hufs.world;

import org.junit.jupiter.api.Test;

import static org.assertj.core.api.Assertions.assertThat;

class WorldJoinIdentityTest {
    @Test void recognizesOnlyTheSameNonBlankAuthenticatedOwnerAsTheSameAccount() {
        assertThat(WorldHandler.sameAccountIdentity("account-1", "account-1")).isTrue();
        assertThat(WorldHandler.sameAccountIdentity("account-1", "account-2")).isFalse();
        assertThat(WorldHandler.sameAccountIdentity("", "")).isFalse();
        assertThat(WorldHandler.sameAccountIdentity(null, null)).isFalse();
    }
}
