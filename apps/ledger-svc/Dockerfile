# --- build stage ---
FROM eclipse-temurin:21-jdk-alpine AS builder
WORKDIR /workspace

# Copy Gradle wrapper and build scripts first for better caching
COPY gradlew gradlew
COPY gradle gradle
COPY build.gradle.kts settings.gradle.kts ./
COPY src src

RUN chmod +x ./gradlew \
	&& ./gradlew --no-daemon -q help

# Build only the bootable jar and skip tests for faster CI
RUN ./gradlew --no-daemon -x test bootJar

# --- runtime stage ---
FROM eclipse-temurin:21-jre-alpine
WORKDIR /app

# Copy all jars then select the Spring Boot fat jar (exclude *-plain.jar)
COPY --from=builder /workspace/build/libs /app/libs

EXPOSE 8081

# Use sh to resolve the boot jar name dynamically and run it
ENTRYPOINT ["sh","-c","exec java -jar $(ls /app/libs/*.jar | grep -v plain | head -n 1)"]
