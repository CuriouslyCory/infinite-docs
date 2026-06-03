# Test System — Trace: Auth → DB

> 3 Components · 1 Connection

## Trace points

- Postgres {#n-db} · Database
- Users Module {#n-users} · Service

## Components

### API Gateway {#n-api}
- kind: Service
- path: API Gateway

#### Overview

Routes requests.

```
# not a heading
```

### Postgres {#n-db}
- kind: Database
- path: Postgres

### Users Module {#n-users}
- kind: Service
- path: API Gateway → Users Module

## Connections

- Users Module {#n-users} → Postgres {#n-db} · reads from
