# Use official Node.js slim image as the base
FROM node:slim

# Set working directory
WORKDIR /app

# Copy package files
COPY package*.json ./

# Install ALL dependencies (including dev dependencies needed for build)
RUN npm install

# Copy source files
COPY tsconfig.json ./
COPY src ./src
COPY README.md ./

# Build the application
RUN npm run build

# Remove dev dependencies for a smaller image
RUN npm prune --production

# Expose the application port
EXPOSE 8080

# Set environment variables
ENV PORT=8080

# Start the application
CMD ["npm", "start"]
