# Universal container image — works on Fly.io, Koyeb, Railway, Google Cloud Run,
# or anywhere that runs a Dockerfile. (Render uses package.json instead; both are fine.)
FROM node:20-alpine
WORKDIR /app
COPY . .
# Host platforms set PORT; default to 8766 for local `docker run`.
ENV PORT=8766
EXPOSE 8766
CMD ["node", "server.js"]
