# Use official Node.js LTS runtime
FROM node:18-alpine

# Set working directory inside container
WORKDIR /app

# Copy dependency manifests
COPY package*.json ./

# Install production dependencies
RUN npm ci --only=production

# Copy application source code
COPY . .

# Expose port Render uses
EXPOSE 10000

# Start server
CMD ["npm", "start"]