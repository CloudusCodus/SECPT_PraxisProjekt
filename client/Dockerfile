FROM node:18 AS base

# Install dependencies
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm install

# Copy source and build the application
COPY tsconfig.json ./
COPY vite.config.ts ./
COPY .env ./
COPY index.html ./
COPY src ./src

RUN npm run build

# Use a lightweight image to serve the static files
FROM node:18 AS prod
WORKDIR /app

# Copy built assets from the previous stage
COPY --from=base /app/dist ./dist
# Copy package.json to ensure the container has the correct metadata
COPY package.json ./

# Install serve to host static files
RUN npm install -g serve

EXPOSE 4173

# Serve the built application
CMD ["serve", "-s", "dist", "-l", "4173"]