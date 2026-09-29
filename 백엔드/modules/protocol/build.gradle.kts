plugins { `java-library` }
dependencies { api("com.fasterxml.jackson.core:jackson-databind") }
sourceSets.main { resources.srcDir(rootProject.file("contracts/fixtures")) }
tasks.processResources { from(rootProject.file("assets/office-catalog.json")) }
