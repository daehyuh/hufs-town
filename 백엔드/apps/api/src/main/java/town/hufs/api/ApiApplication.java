package town.hufs.api;

import org.springframework.boot.SpringApplication;
import org.springframework.boot.autoconfigure.SpringBootApplication;

@SpringBootApplication(exclude = {org.springframework.boot.autoconfigure.session.SessionAutoConfiguration.class,
    org.springframework.boot.autoconfigure.security.servlet.UserDetailsServiceAutoConfiguration.class})
@org.springframework.context.annotation.Import(town.hufs.auth.AuthRuntimeConfiguration.class)
@org.springframework.scheduling.annotation.EnableScheduling
public class ApiApplication {
    public static void main(String[] args) { SpringApplication.run(ApiApplication.class, args); }
}
