# Secure Microservices Demo

This repository contains a small microservices-based application that demonstrates a simple end‑to‑end use case across multiple services.  It is designed as a starting point for the practical portion of your assignment and emphasises a clean, maintainable structure.

## Overview

The system consists of three backend services built with **Node.js**, **Express** and **TypeScript**, plus a responsive **React** front‑end written in **TypeScript**.  The services communicate with each other using plain HTTP calls and expose simple JSON REST APIs.  A docker‑compose configuration ties all components together so that everything can be brought up with a single command.

### Services

| Service         | Port | Description |
|-----------------|-----:|------------|
| **user‑service**    | 3001 | Manages users. Supports full CRUD operations (create, read, update and delete). Deleting a user will fail if there are existing orders referencing that user, so associated orders must be removed first. |
| **product‑service** | 3002 | Manages products. Supports full CRUD operations (create, read, update and delete). Similar to users, attempting to delete a product that is referenced by any order will return an error until those orders are deleted. |
| **order‑service**   | 3003 | Orchestrates calls to the user and product services. Supports creating, listing, updating and deleting orders that link a user to a product. The service exposes filters to list orders by user ID or product ID and ensures that referenced users and products exist during creation and updates. |
| **client**          | 5173 | Responsive React application that interacts with the three services. |

Each service is implemented in its own folder under `secure-microservice-app/` with a small in‑memory data store.  The `order-service` relies on environment variables to locate its dependencies; these are configured automatically via `docker-compose.yml`.

## Running with Docker Compose

The easiest way to run the entire system is with Docker Compose.  Ensure you have a recent version of Docker and Compose installed on your machine.

```bash
# From the root of this repository
docker-compose up --build
```

Docker will build the images for each microservice and the React client.  Once the build completes, the services will be available on the host at the ports listed above.  You can then open the client in your browser at [http://localhost:5173](http://localhost:5173) and start interacting with the system.

> **Note:** The first build can take a few minutes since npm needs to download dependencies.  Subsequent runs will be much faster thanks to cached layers.

## Developing Locally (without Docker)

If you prefer to run the services directly on your machine, you can do so using Node.js.  Each service is independent and can be started on its own:

```bash
# install dependencies for a service
cd user-service
npm install
# compile TypeScript and start the server
npm run build && npm start

# repeat for product-service and order-service

# client
cd client
npm install
npm run dev

# the client will launch on http://localhost:5173 by default
```

> When running the client outside of Docker, it communicates with the backend services via the ports exposed on your machine (3001–3003).  These base URLs are defined in `client/.env` and can be modified if needed.

## Project Structure

```
secure-microservice-app/
├─ docker-compose.yml        # Orchestrates all services
├─ user-service/             # User microservice
│  ├─ Dockerfile
│  ├─ package.json
│  ├─ tsconfig.json
│  └─ src/index.ts
├─ product-service/          # Product microservice
│  ├─ Dockerfile
│  ├─ package.json
│  ├─ tsconfig.json
│  └─ src/index.ts
├─ order-service/            # Order microservice
│  ├─ Dockerfile
│  ├─ package.json
│  ├─ tsconfig.json
│  └─ src/index.ts
├─ client/                   # React front-end
│  ├─ Dockerfile
│  ├─ package.json
│  ├─ tsconfig.json
│  ├─ vite.config.ts
│  ├─ .env                   # Base URLs for backend services
│  ├─ index.html
│  └─ src/
│     ├─ main.tsx
│     └─ App.tsx
└─ README.md                 # This file
```

### Clean Code Considerations

* **Type safety:** All services and the client are written in TypeScript to catch type errors early.
* **Separation of concerns:** Each microservice is responsible for a single domain.  The order service delegates to the user and product services rather than duplicating their logic.
* **Responsiveness:** The client leverages Bootstrap to provide a responsive layout that works on both desktop and mobile screens.
* **Configuration:** Base URLs and ports are extracted into environment variables so they can be changed without modifying the code.

## Extending the System

This demo is intentionally simple.  In a production environment you would typically persist data to a database, implement authentication and authorization, add proper logging and monitoring, and introduce fault tolerance mechanisms such as retries or circuit breakers.  However, this repository provides a solid foundation for building more complex scenarios and satisfies the requirements for a running end‑to‑end microservices demo with a responsive React UI.
