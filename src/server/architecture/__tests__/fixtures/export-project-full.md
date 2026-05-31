# Test System

> 5 Components · 3 Connections

## Components

### API Gateway {#n-api}
- kind: Service
- path: API Gateway

#### Overview

This service exposes the public API.

##### Authentication

Tokens are JWT-based.

### Postgres {#n-db}
- kind: Database
- path: Postgres

### Third Party API {#n-ext}
- kind: External API
- path: Third Party API

### Auth Module {#n-auth}
- kind: Service
- path: API Gateway → Auth Module

### Users Module {#n-users}
- kind: Service
- path: API Gateway → Users Module

## Connections

- API Gateway → Postgres — reads from (canvas: Project root)
- API Gateway → Third Party API — calls (canvas: Project root)
- Auth Module → Users Module (canvas: API Gateway)
