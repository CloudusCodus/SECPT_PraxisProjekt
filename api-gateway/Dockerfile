FROM node:18-alpine as build

# Work directory inside the build container
WORKDIR /usr/src/app

# Copy only package definitions first to leverage cached layers
COPY package.json package-lock.json* ./

# Install dependencies (including dev dependencies) for the build.
# We prune dev dependencies after compiling to keep the runtime image small.
RUN npm install

# Copy the remaining source and configuration
COPY tsconfig.json ./
COPY src ./src

# Compile the TypeScript into JavaScript. This writes to the `dist`
# directory as specified in tsconfig.json.
RUN npx tsc

# Remove devDependencies so the runtime image only contains what it needs.
RUN npm prune --omit=dev

# Remove devDependencies so the runtime image only contains production deps
RUN npm prune --omit=dev

# Use a separate, minimal image for the runtime to keep the final
# container lightweight
FROM node:18-alpine
WORKDIR /usr/src/app

# Copy compiled output and runtime dependencies from the build stage
COPY --from=build /usr/src/app/dist ./dist
COPY --from=build /usr/src/app/node_modules ./node_modules
COPY --from=build /usr/src/app/package.json ./package.json

# Expose the gateway port
EXPOSE 3000

# Start the application
CMD ["node", "dist/index.js"]