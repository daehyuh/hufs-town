plugins { `java-library` }
dependencies {
    api(project(":modules:protocol"))
    api("org.springframework.boot:spring-boot-starter-data-redis")
    api("org.springframework.session:spring-session-data-redis")
    api("org.springframework.security:spring-security-core")
    // Shared Redis sessions also contain Spring Security's DefaultCsrfToken.
    // Every reader (including the independently packaged world) needs its class.
    api("org.springframework.security:spring-security-web")
    compileOnly("jakarta.servlet:jakarta.servlet-api")
    testImplementation("org.testcontainers:junit-jupiter")
    testImplementation("org.testcontainers:testcontainers")
}
