FROM node:18

# Create app directory
WORKDIR /app

# Install app dependencies
COPY package.json package-lock.json* ./
RUN npm install

# Bundle app source
COPY tsconfig.json ./
COPY src ./src

# Compile the TypeScript source to JavaScript
RUN npm run build

EXPOSE 3001

# Run the compiled server
CMD ["npm", "start"]
