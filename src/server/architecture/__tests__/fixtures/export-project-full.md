# Test System

> 6 Components · 4 Connections

## Components

### API Gateway {#n-api}
- kind: Service
- path: API Gateway

#### Overview

This service exposes the public API.

##### Authentication

Tokens are JWT-based.

### Analytics API {#n-analytics}
- kind: External API
- path: Analytics API

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

- API Gateway {#n-api} → Postgres {#n-db} · reads from
- API Gateway {#n-api} → Third Party API {#n-ext} · calls
- Auth Module {#n-auth} — Users Module {#n-users}
- Users Module {#n-users} → Analytics API {#n-analytics} · tracks events
