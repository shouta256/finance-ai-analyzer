# Safepocket - AI-Powered Personal Finance Dashboard

Smart financial management to improve your financial literacy

[![Build Status](https://github.com/shouta256/finance-ai-analyzer/actions/workflows/main.yml/badge.svg)](https://github.com/shouta256/finance-ai-analyzer/actions)
[![Security](https://img.shields.io/badge/Security-Enterprise%20Grade-green)](https://github.com/shouta256/finance-ai-analyzer)
[![Tech Stack](https://img.shields.io/badge/Stack-Spring%20Boot%20%7C%20Next.js%20%7C%20AWS-blue)](#technology-stack)

## Deployment

Live Demo: [https://app.shota256.me] (Demo Environment)

The production environment runs on AWS ECS Fargate with automated deployment through CI/CD pipelines.

## Overview

Safepocket is a next-generation personal finance management platform that combines AI technology with enterprise-grade security.

It automatically collects transaction data through bank account integration and provides intelligent spending analysis using machine learning anomaly detection and RAG (Retrieval-Augmented Generation) technology.

## Key Features

### Bank Integration & Auto-Sync
- Secure bank account connection via Plaid API
- Real-time transaction data synchronization
- Unified management of multiple financial institutions

### AI-Powered Analysis
- Spending pattern analysis using RAG technology
- Intelligent summaries powered by GPT-4/Gemini API
- Machine learning anomaly detection (Z-Score & IQR methods)

### Interactive Dashboard
- Category-based spending analysis
- Monthly and yearly trend visualization
- Top merchant analysis
- Budget setting and tracking

### AI Chat Assistant
- Natural language spending queries
- Personalized financial advice
- Spending habit improvement suggestions

## Technology Stack

### Frontend
- Next.js 14 (App Router) - Full-stack React framework
- TypeScript - Type-safe development
- Tailwind CSS - Modern UI design
- React Query - Efficient data fetching
- Zod - Runtime type validation

### Backend
- Spring Boot 3.2 - Enterprise Java framework
- Java 21 - Latest LTS version of Java
- Spring Security - Authentication & authorization
- JPA/Hibernate - ORM and database access
- Flyway - Database migration

### Data & AI
- PostgreSQL - Main database (with RLS support)
- Redis - Cache and session management
- Google Gemini - AI summarization, analysis, and vector embeddings
- Apache Commons Math - Statistical analysis

### Infrastructure & DevOps
- AWS ECS Fargate - Container orchestration
- Application Load Balancer + WAF - Load balancing and security
- Amazon RDS - Managed PostgreSQL
- ElastiCache - Managed Redis
- AWS Secrets Manager + KMS - Secret management
- Amazon ECR - Container registry

### Development & CI/CD
- GitHub Actions - CI/CD pipeline
- Docker - Containerization
- Terraform - Infrastructure as Code
- Trivy - Security scanning
- Biome - Linting & formatting

## Architecture

```
┌─────────────┐    ┌──────────────┐    ┌─────────────────┐
│    Client   │───▶│ ALB + WAF    │───▶│  Next.js (BFF)  │
└─────────────┘    └──────────────┘    └─────────────────┘
                                                │
┌─────────────┐    ┌──────────────┐    ┌─────────────────┐
│ Plaid API   │◀──▶│ Spring Boot  │◀───│  Load Balancer  │
└─────────────┘    │   (Private)  │    └─────────────────┘
                   └──────────────┘
                           │
┌─────────────┐    ┌──────────────┐    ┌─────────────────┐
│  OpenAI/    │◀──▶│ PostgreSQL   │    │     Redis       │
│   Gemini    │    │    (RLS)     │    │   (Cache)       │
└─────────────┘    └──────────────┘    └─────────────────┘
```

### Design Principles
- Contract-First API - Type safety through OpenAPI specifications
- Microservices - Loosely coupled service design
- Zero-Trust Security - Multi-layered defense security
- Event-Driven - High throughput through asynchronous processing

## Technical Highlights & Challenges

### 1. Enterprise-Grade Security
- Row Level Security (RLS) for multi-tenant isolation
- KMS encryption to protect Plaid access tokens
- JWT + Cognito for robust authentication infrastructure
- WAF for attack defense

### 2. RAG Implementation
- Vector search for fast extraction of related transactions
- Multi-modal embeddings (Gemini API)
- Context optimization to improve LLM response accuracy
- Entity extraction for semantic search

### 3. DevOps & Automation
- GitHub Actions OIDC for secure CI/CD
- Blue-Green Deployment for zero-downtime updates
- Infrastructure as Code (Terraform)
- Multi-stage Dockerfiles for optimized containers

### 4. Performance Optimization
- PostgreSQL index strategies for query optimization
- Redis caching for faster response times
- Connection pooling for efficient database connection management
- Lazy loading to reduce memory usage

### 5. Developer Experience (DX)
- Make commands for one-click environment setup
- Contract-First development for type safety guarantees
- Hot reload enabled development environment
- Comprehensive testing (Unit/Integration/E2E)

### 6. Monitoring & Operations
- Structured logging for improved operations
- Health checks for automatic recovery
- Metrics collection for performance monitoring
- Error tracking for fast incident response

## Getting Started

### Prerequisites
- Docker & Docker Compose
- Java 21+
- Node.js 18+
- pnpm 8+

### 1. Clone and Setup
```bash
git clone https://github.com/shouta256/finance-ai-analyzer.git
cd finance-ai-analyzer

# Install dependencies, build, and initialize database in one command
make setup
```

### 2. Environment Variables
```bash
# Create .env file
cp .env.example .env

# Set required environment variables
export PLAID_CLIENT_ID="your_plaid_client_id"
export PLAID_CLIENT_SECRET="your_plaid_secret"
export GOOGLE_AI_API_KEY="your_gemini_key"  # Optional
```

### 3. Start Services
```bash
# Full stack startup (Web + API + DB + Redis)
make up

# Or start individually
make docker-up  # Infrastructure only
cd apps/ledger-svc && ./gradlew bootRun  # API
cd apps/web && pnpm dev  # Frontend
```

### 4. Access Points
- Web UI: http://localhost:3000
- API: http://localhost:8081
- API Docs: http://localhost:8081/swagger-ui.html

### 5. Run Tests
```bash
# Frontend tests
pnpm -C apps/web test
pnpm -C apps/web test:e2e

# Backend tests
./apps/ledger-svc/gradlew test

# Overall linting
make lint
```

### 6. Demo Data
```bash
# Run RAG demo
make demo

# Load sample data
make seed
```

---

## Technical Documentation

For detailed technical specifications, please refer to:

- [Architecture](docs/architecture.md) - System design details
- [API Documentation](contracts/openapi.yaml) - OpenAPI specification
- [Coding Standards](docs/coding-standards.md) - Coding conventions
- [Operations Guide](docs/operations.md) - Operations guide

---

## License & Credits

- Developer: Shota Suzuki ([@shouta256](https://github.com/shouta256))
- Project Period: September 2025 - Ongoing
- Purpose: Technical skills demonstration
- Tools Used: GitHub Copilot for efficient and collaborative development
