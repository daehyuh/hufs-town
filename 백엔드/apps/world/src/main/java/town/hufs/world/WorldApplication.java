package town.hufs.world;

import org.springframework.boot.SpringApplication;
import org.springframework.boot.autoconfigure.SpringBootApplication;

@SpringBootApplication(exclude = org.springframework.boot.autoconfigure.session.SessionAutoConfiguration.class)
@org.springframework.context.annotation.Import(town.hufs.auth.AuthRuntimeConfiguration.class)
public class WorldApplication {
    public static void main(String[] args) { SpringApplication.run(WorldApplication.class, args); }
}
