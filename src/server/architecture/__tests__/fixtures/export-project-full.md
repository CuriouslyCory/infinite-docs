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

- API Gateway → Postgres — reads from
- API Gateway → Third Party API — calls
- Auth Module → Users Module
- Users Module → Analytics API — tracks events
