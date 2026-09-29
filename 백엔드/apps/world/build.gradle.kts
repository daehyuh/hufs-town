plugins { id("org.springframework.boot"); java }
tasks.withType<org.gradle.api.tasks.testing.Test>().configureEach {
    listOf("worldLoadUrl", "worldLoadOutput", "worldLoadClientCount", "worldLoadWarmupSeconds", "worldLoadSteadyStateSeconds")
        .forEach { key -> providers.gradleProperty(key).orNull?.let { systemProperty(key, it) } }
}
dependencies {
    implementation(project(":modules:domain"))
    implementation(project(":modules:auth"))
    implementation("org.springframework.boot:spring-boot-starter-websocket")
    implementation("org.springframework.boot:spring-boot-starter-actuator")
    runtimeOnly("io.micrometer:micrometer-registry-prometheus")
    implementation("org.springframework.boot:spring-boot-starter-jdbc")
    implementation("org.springframework.boot:spring-boot-starter-data-redis")
    runtimeOnly("org.mariadb.jdbc:mariadb-java-client")
    testImplementation(project(":modules:persistence"))
    testImplementation("org.flywaydb:flyway-core")
    testImplementation("org.flywaydb:flyway-mysql")
    testImplementation("org.testcontainers:junit-jupiter")
    testImplementation("org.testcontainers:testcontainers")
}
