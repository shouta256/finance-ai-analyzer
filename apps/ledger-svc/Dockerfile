FROM eclipse-temurin:21-jre-alpine
WORKDIR /app
# 例: apps/ledger-svc/build/libs/ledger-svc.jar をコピー
COPY build/libs/*.jar app.jar
EXPOSE 8081
ENTRYPOINT ["java","-jar","/app/app.jar"]
