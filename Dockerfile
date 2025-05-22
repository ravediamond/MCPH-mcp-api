FROM node:slim

WORKDIR /app
COPY package*.json ./
RUN npm install
COPY . .
# Remove service account credential files from the image (if present)
RUN rm -f service-account-credentials.json service-account-credentials-prod.json .env.local .env.production
RUN npm run build
EXPOSE 8080
ENV PORT 8080
CMD ["npm", "start"]
