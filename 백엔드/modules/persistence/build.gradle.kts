plugins { `java-library` }
dependencies {
    api("org.springframework.boot:spring-boot-starter-data-jpa")
    api("org.springframework.boot:spring-boot-starter-data-redis")
    implementation("org.flywaydb:flyway-core")
    implementation("org.flywaydb:flyway-mysql")
    runtimeOnly("org.mariadb.jdbc:mariadb-java-client")
    testImplementation("org.testcontainers:junit-jupiter")
    testImplementation("org.testcontainers:mariadb")
}
tasks.test { useJUnitPlatform { excludeTags("infrastructure") } }
tasks.register<Test>("integrationTest") {
    description = "Requires a working Docker engine; does not silently skip infrastructure checks."
    group = "verification"
    testClassesDirs = sourceSets.test.get().output.classesDirs
    classpath = sourceSets.test.get().runtimeClasspath
    useJUnitPlatform { includeTags("infrastructure") }
}
