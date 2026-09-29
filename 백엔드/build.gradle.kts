plugins {
    id("org.springframework.boot") version "3.5.16" apply false
    id("io.spring.dependency-management") version "1.1.7" apply false
}

subprojects {
    // ASCII build paths avoid Windows Gradle worker classpath encoding failures for Korean source folders.
    layout.buildDirectory.set(rootProject.file("../.build/backend/" + project.path.trim(':').replace(':', '/')))
    apply(plugin = "java-library")
    apply(plugin = "io.spring.dependency-management")
    group = "town.hufs"
    version = "0.1.0-SNAPSHOT"
    repositories { mavenCentral() }
    extensions.configure<JavaPluginExtension> {
        toolchain { languageVersion.set(JavaLanguageVersion.of(21)) }
    }
    extensions.configure<io.spring.gradle.dependencymanagement.dsl.DependencyManagementExtension> {
        imports { mavenBom("org.springframework.boot:spring-boot-dependencies:3.5.16") }
    }
    dependencies {
        "testImplementation"("org.springframework.boot:spring-boot-starter-test")
        "testRuntimeOnly"("org.junit.platform:junit-platform-launcher")
    }
    tasks.withType<JavaCompile>().configureEach {
        options.encoding = "UTF-8"
        options.compilerArgs.add("-parameters")
    }
    tasks.withType<Test>().configureEach {
        useJUnitPlatform()
        systemProperty("user.timezone", "UTC")
        systemProperty("hufs.projectRoot", rootProject.projectDir.absolutePath)
    }
}
