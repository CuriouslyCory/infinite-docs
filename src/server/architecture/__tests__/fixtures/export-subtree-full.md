# Test System

> Subtree of **API Gateway**
> 3 Components · 1 Connection

## Boundary context

- API Gateway {#n-api} → Postgres {#n-db} (Database) · reads from
- API Gateway {#n-api} → Third Party API {#n-ext} (External API) · calls
- Users Module {#n-users} → Analytics API {#n-analytics} (External API) · tracks events

## Components

### API Gateway {#n-api}
- kind: Service
- path: API Gateway

#### Overview

This service exposes the public API.

##### Authentication

Tokens are JWT-based.

### Auth Module {#n-auth}
- kind: Service
- path: API Gateway → Auth Module

### Users Module {#n-users}
- kind: Service
- path: API Gateway → Users Module

## Connections

- Auth Module {#n-auth} — Users Module {#n-users}
