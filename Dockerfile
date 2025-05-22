# Use official Node.js slim image as the base
FROM node:slim

# Set working directory
WORKDIR /app

# Install dependencies
COPY package*.json ./
RUN npm install --production

# Copy source files
COPY tsconfig.json ./
COPY src ./src
COPY README.md ./

# Build the application
RUN npm run build

# Expose the application port
EXPOSE 8080

# Set environment variables
ENV PORT=8080

# Start the application
CMD ["npm", "start"]
