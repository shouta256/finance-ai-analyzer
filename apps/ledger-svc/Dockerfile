## --- build stage ---
## Use a glibc-based image (debian slim) to avoid native file watcher segfaults seen on alpine with Gradle
FROM eclipse-temurin:21-jdk AS builder
WORKDIR /workspace

# Copy Gradle wrapper and build scripts first for better caching
COPY gradlew gradlew
COPY gradle gradle
COPY build.gradle.kts settings.gradle.kts ./
COPY src src

ENV GRADLE_OPTS="-Dorg.gradle.daemon=false -Dorg.gradle.vfs.watch=false -Dorg.gradle.jvmargs='-Xmx768m'"
RUN chmod +x ./gradlew \
	&& ./gradlew -version \
	&& ./gradlew --no-daemon -q help

# Build only the bootable jar and skip tests for faster CI (explicitly disable daemon, file watching)
RUN ./gradlew --no-daemon -Dorg.gradle.vfs.watch=false -x test bootJar

# --- runtime stage ---
FROM eclipse-temurin:21-jre-alpine
WORKDIR /app

# Copy all jars then select the Spring Boot fat jar (exclude *-plain.jar)
COPY --from=builder /workspace/build/libs /app/libs

EXPOSE 8081

# Install curl for container healthcheck
RUN apk add --no-cache curl

## Startup currently takes ~34s; provide a start-period buffer so container isn't marked unhealthy prematurely
HEALTHCHECK --start-period=45s --interval=30s --timeout=5s --retries=5 CMD curl -fsS http://localhost:8081/actuator/health || exit 1

# Use sh to resolve the boot jar name dynamically and run it
ENTRYPOINT ["sh","-c","exec java -jar $(ls /app/libs/*.jar | grep -v plain | head -n 1)"]
