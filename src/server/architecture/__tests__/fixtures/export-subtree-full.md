# Test System

> Subtree of **API Gateway**
> 3 Components · 1 Connection

## Boundary context

- **Postgres** (Database) — direct
- **Third Party API** (External API) — direct

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

- Auth Module → Users Module (canvas: API Gateway)
