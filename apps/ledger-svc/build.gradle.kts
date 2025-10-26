plugins {
    id("java")
    id("org.springframework.boot") version "3.2.5"
    id("io.spring.dependency-management") version "1.1.4"
    id("org.flywaydb.flyway") version "10.15.0"
}

buildscript {
    repositories { mavenCentral() }
    dependencies {
        classpath("org.flywaydb:flyway-database-postgresql:10.15.0")
    }
}

group = "com.safepocket"
version = "0.1.0"
java.sourceCompatibility = JavaVersion.VERSION_21

repositories {
    mavenCentral()
}

val flywayMigration by configurations.creating {
    isCanBeResolved = true
    isVisible = false
    extendsFrom(configurations.runtimeClasspath.get())
}

dependencies {
    implementation("org.springframework.boot:spring-boot-starter-actuator")
    implementation("org.springframework.boot:spring-boot-starter-data-jpa")
    implementation("org.springframework.boot:spring-boot-starter-validation")
    implementation("org.springframework.boot:spring-boot-starter-security")
    implementation("org.springframework.boot:spring-boot-starter-oauth2-resource-server")
    implementation("org.springframework.boot:spring-boot-starter-web")
    implementation("org.springframework.boot:spring-boot-starter-webflux")
    implementation("org.springframework.boot:spring-boot-starter-json")
    implementation("com.fasterxml.jackson.datatype:jackson-datatype-jsr310")
    implementation("org.apache.commons:commons-math3:3.6.1")
    implementation("org.flywaydb:flyway-core:10.15.0")
    implementation("org.flywaydb:flyway-database-postgresql:10.15.0")
    implementation("io.jsonwebtoken:jjwt-api:0.12.5")
    runtimeOnly("io.jsonwebtoken:jjwt-impl:0.12.5")
    runtimeOnly("io.jsonwebtoken:jjwt-jackson:0.12.5")

    runtimeOnly("com.h2database:h2")
    implementation("org.postgresql:postgresql")
    add("flywayMigration", "org.postgresql:postgresql")

    testImplementation("org.springframework.boot:spring-boot-starter-test")
    testImplementation("org.springframework.security:spring-security-test")
    testImplementation("org.mockito:mockito-junit-jupiter:5.10.0")
}

fun resolveConfig(key: String, defaultValue: String): String =
    System.getProperty(key)
        ?: System.getenv(key.uppercase().replace('.', '_'))
        ?: defaultValue

flyway {
    configurations = arrayOf("flywayMigration")
    url = resolveConfig("flyway.url", "jdbc:postgresql://localhost:5432/safepocket")
    user = resolveConfig("flyway.user", "safepocket")
    password = resolveConfig("flyway.password", "safepocket")
}

tasks.withType<Test> {
    useJUnitPlatform()
}
