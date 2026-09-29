plugins { id("org.springframework.boot"); java }
dependencies {
    implementation(project(":modules:domain"))
    implementation(project(":modules:protocol"))
    implementation(project(":modules:persistence"))
    implementation(project(":modules:auth"))
    implementation("org.springframework.boot:spring-boot-starter-security")
    testImplementation("org.springframework.security:spring-security-test")
    testImplementation("org.testcontainers:junit-jupiter")
    testImplementation("org.testcontainers:mariadb")
    implementation("org.springframework.boot:spring-boot-starter-web")
    implementation("org.springframework.boot:spring-boot-starter-actuator")
    runtimeOnly("io.micrometer:micrometer-registry-prometheus")
    implementation("com.interaso:webpush:1.2.0")
}
tasks.test { useJUnitPlatform { excludeTags("infrastructure") } }
tasks.register<Test>("integrationTest") {
    dependsOn(":apps:world:bootJar")
    systemProperty("town.worldJar", project(":apps:world").layout.buildDirectory.file("libs/world-${project.version}.jar").get().asFile.absolutePath)
    group = "verification"
    testClassesDirs = sourceSets.test.get().output.classesDirs
    classpath = sourceSets.test.get().runtimeClasspath
    useJUnitPlatform { includeTags("infrastructure") }
}
