# Optional container image (Render uses the native Node runtime via render.yaml;
# this is here for hosts that deploy from a Dockerfile, e.g. Fly.io / Railway).
FROM node:20-alpine
WORKDIR /app
COPY package*.json ./
RUN npm install --omit=dev
COPY . .
ENV NODE_ENV=production
EXPOSE 4000
CMD ["npm", "start"]
