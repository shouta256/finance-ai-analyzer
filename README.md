# Safepocket – AI-Powered Personal Finance Dashboard

Safepocket is a smart personal finance application. It connects to your bank accounts, analyzes your spending, and gives you insights using AI.

I built this project to demonstrate my skills in full-stack development, cloud security, and AI integration.

[![CI Status](https://github.com/shouta256/finance-ai-analyzer/actions/workflows/main.yml/badge.svg)](https://github.com/shouta256/finance-ai-analyzer/actions/workflows/main.yml)

## Project Highlights

This project shows my ability to build professional-grade software. Here are the key strengths:

### 1. Modern & Robust Tech Stack
I used the latest industry standards to build a scalable application.
- **Frontend:** Next.js 14 (App Router) for a fast and responsive user interface.
- **Backend:** Spring Boot 3 (Java 21) for a secure and powerful API.
- **Infrastructure:** AWS (ECS, Lambda) and Docker for modern cloud deployment.

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

Safepocket follows a "Backend for Frontend" (BFF) pattern.
1.  **User Interface:** The Next.js app handles the UI and securely manages user sessions.
2.  **API Service:** The Spring Boot service handles the business logic, bank connections, and AI processing.
3.  **Data Layer:** PostgreSQL stores the data, while Redis handles caching for speed.

This design ensures the backend remains secure and isolated from the public internet.

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

3.  **Access the App**
    - Frontend: `http://localhost:3000`
    - Backend API: `http://localhost:8081`

## Documentation

For more detailed technical information, please check the `docs/` folder:
- [Architecture Design](docs/architecture.md)
- [Security Details](docs/security.md)
- [API Specification](contracts/openapi.yaml)

## Author

**Shota Suzuki**
- GitHub: [@shouta256](https://github.com/shouta256)

I am passionate about building secure and user-friendly web applications. Thank you for checking out my project!