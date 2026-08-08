# Dockerfile for this agent's Scaleway Serverless Job.
#
# The harness's own pipeline does not build this file: agent Jobs run on the
# app's main image (scripts/deploy.mjs#agentJobs, CONTRACT.md §5). It exists
# for a manual, standalone Job image: `docker build --platform linux/amd64`
# (Scaleway Serverless accepts amd64 images only). Unlike the Next.js app's
# container, a Job image does NOT need to listen on any port - Jobs run to
# completion, they don't serve HTTP traffic.
#
# COPY paths always use forward slashes and --chmod=755: a fresh git checkout
# does not guarantee an executable bit is set (CONTRACT.md §7).

FROM node:24-alpine AS build
WORKDIR /app
COPY --chmod=755 package.json ./
RUN npm install
COPY --chmod=755 . .
RUN npm run build

FROM node:24-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY --chmod=755 package.json ./
RUN npm install --omit=dev
COPY --chmod=755 --from=build /app/dist ./dist

CMD ["node", "dist/entry.js"]
