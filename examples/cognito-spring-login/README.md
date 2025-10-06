# Cognito Spring Login Example

A minimal Spring Boot 3 OAuth2 Login sample using Amazon Cognito as an OpenID Connect provider.

## Features
- Authorization Code flow handled by Spring Security
- Thymeleaf views with login/logout and claims page
- Uses issuer discovery for JWKS & endpoints

## Prerequisites
1. Amazon Cognito User Pool (region: us-east-1) with a domain configured.
2. App Client with the following:
   - Allowed callback URL: `http://localhost:8090/login/oauth2/code/cognito`
   - Allowed logout URL: `http://localhost:8090/`
   - Scopes: `openid`, `email`, `profile`

## Environment Variables
```
COGNITO_CLIENT_ID=5ge4c1b382ft2v71rvip0rrhqv
COGNITO_CLIENT_SECRET=replace-me
# Optionally override port
SERVER_PORT=8090
```
> If you change region/pool, update `issuer-uri` in `application.yml` accordingly.

## Run
```
mvn -q spring-boot:run -f examples/cognito-spring-login/pom.xml
```
Navigate to: http://localhost:8090/

Click "Login with Cognito" → authenticate → redirected back.

## Logout
Spring Security invalidates the session. If you want full Cognito global sign-out, redirect to:
```
https://<your-domain>.auth.us-east-1.amazoncognito.com/logout?client_id=...&logout_uri=http://localhost:8090/
```
(You can implement a custom logout success handler if needed.)

## Notes
- For production, externalize secrets (do NOT commit real client secrets).
- Enable HTTPS (reverse proxy) for secure cookies if adapting beyond local demo.
- To inspect granted ID token & claims, add a controller endpoint that prints `OidcUser#getIdToken().getClaims()`.
