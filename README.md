# Safepocket – AI-Powered Personal Finance Dashboard

Safepocket is a smart personal finance application. It connects to your bank accounts, analyzes your spending, and gives you insights using AI.

I built this project to demonstrate my skills in full-stack development, cloud security, and AI integration.

[![CI Status](https://github.com/shouta256/finance-ai-analyzer/actions/workflows/main.yml/badge.svg)](https://github.com/shouta256/finance-ai-analyzer/actions/workflows/main.yml)

## Project Highlights

This project shows my ability to build professional-grade software. Here are the key strengths:

### 1. Modern & Pragmatic Tech Stack
I used current production patterns and adjusted the deployment profile to fit personal-project cost constraints.
- **Frontend:** Next.js 14 (App Router) for a fast and responsive user interface.
- **Backend:** Spring Boot 3 (Java 21) for a secure and powerful API.
- **Infrastructure:** AWS Lambda / API Gateway for the cost-optimized runtime profile, plus Spring Boot for the richer backend profile used in local development and full RAG flows.

### 2. High-Level Security
Since this app handles financial data, security was my top priority.
- **Secure Login:** Uses Amazon Cognito for safe user authentication.
- **Data Protection:** Sensitive data (like bank tokens) is encrypted using AWS KMS.
- **Access Control:** I implemented Row Level Security (RLS) in the database. This ensures users can strictly access only their own data.

### 3. Advanced AI & FinTech Features
This is not just a simple CRUD app. It includes complex logic and AI.
- **AI Assistant:** You can chat with the app to ask questions like "How much did I spend on coffee last month?".
- **Vector Search (RAG):** I used `pgvector` to allow the AI to search through transaction history intelligently.
- **Bank Integration:** Integrated with Plaid API to sync real bank transactions securely.

## Technology Stack

| Category | Technologies |
|----------|--------------|
| **Frontend** | Next.js 14, TypeScript, Tailwind CSS, Radix UI |
| **Backend** | Java 21, Spring Boot 3.2, Spring Security |
| **Database** | PostgreSQL 15 (Neon), Redis |
| **AI** | OpenAI / Gemini API, pgvector (RAG) |
| **DevOps** | AWS (ECS, Lambda), Docker, GitHub Actions, Terraform |

## Architecture Overview

Safepocket follows a "Backend for Frontend" (BFF) pattern and supports two backend profiles.
1. **User Interface:** The Next.js app handles the UI and securely manages user sessions.
2. **Backend Profiles:**
   - **Java-backed profile:** Spring Boot handles domain logic and the full RAG implementation.
   - **Serverless profile:** API Gateway + Lambda handle the same product surface with lower fixed cost.
3. **Data Layer:** PostgreSQL stores the data, while Redis is available for caching/coordination where needed.

This let me balance engineering quality with personal-project operating cost. The tradeoff itself is part of the project story.

## Getting Started

To run this project locally, you need Docker and Java 21 installed.

1.  **Clone the repository**
    ```bash
    git clone https://github.com/shouta256/finance-ai-analyzer.git
    cd finance-ai-analyzer
    ```

2.  **Setup and Run**
    We use a simple Makefile to handle setup.
    ```bash
    # Install dependencies and setup database
    make setup

    # Start the application
    make up
    ```
    `make up` automatically backfills local RAG embeddings for the seeded transactions before you use chat.

3.  **Access the App**
    - Frontend: `http://localhost:3000`
    - Backend API: `http://localhost:8081`

## Local Troubleshooting

If `make up` fails at `:bootRun` and the backend log includes Flyway messages like `Migration checksum mismatch` or `Detected resolved migration not applied to database`, the local Docker Postgres volume is carrying an older migration history than the current repository.

If you do not need to keep local dev data, reset the local volumes and start again:

```bash
make reset-db
make setup
make up
```

This recreates the local Postgres/Redis volumes and is the fastest fix for stale Flyway history.

Warnings such as `baseline-browser-mapping` or `Browserslist: caniuse-lite is old` are frontend tooling notices. They are unrelated to the backend `bootRun` failure.

If chat returns `RAG_INDEX_NOT_READY`, the backend has detected transactions without embeddings for that user. In local dev, restarting with `make up` triggers an automatic startup backfill for seeded data. Watch the backend log for `RAG startup backfill completed`.

## Documentation

For more detailed technical information, please check the `docs/` folder:
- [Architecture Design](docs/architecture.md)
- [Security Details](docs/security.md)
- [API Specification](contracts/openapi.yaml)

## Author

**Shota Suzuki**
- GitHub: [@shouta256](https://github.com/shouta256)

I am passionate about building secure and user-friendly web applications. Thank you for checking out my project!
