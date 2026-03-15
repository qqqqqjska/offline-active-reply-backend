# Offline Active Reply Backend Template

This backend can be deployed in two common ways:

1. Source deployment on platforms like Railway / Render
2. Image deployment after you build and publish a Docker image

This is a generic deployment pattern and does not depend on any specific third-party product workflow.

## What this backend does
- stores contact active-reply config
- stores latest message snapshots
- checks on a timer whether a proactive reply should be generated
- stores generated offline messages
- lets the frontend sync those messages later

## Files in this template
- `package.json`
- `server.js`
- `.gitignore`
- `.env.example`
- `Dockerfile`
- `.dockerignore`
- `README.md`

## Environment variables
- `PORT` provided by most hosts automatically
- `APP_ORIGIN` set to your frontend site URL, or `*` during setup
- `CRON_INTERVAL_MS` defaults to `60000`
- `DATA_DIR` defaults to `./data`
- `DB_PATH` defaults to `./data/offline-active-reply.db`

## Local run
```bash
npm install
npm start
```

## Docker build
```bash
docker build -t offline-active-reply-backend .
```

## Docker run
```bash
docker run -p 3000:3000 -e APP_ORIGIN=* offline-active-reply-backend
```

## Suggested image publishing flow
If you want end users to deploy this more easily, you can publish a prebuilt image to a container registry such as:
- GitHub Container Registry
- Docker Hub

Then users can deploy the image on a platform that supports image deployment, instead of uploading source code.

## Frontend config example
```js
window.iphoneSimState.offlinePushSync = {
  enabled: true,
  apiBaseUrl: 'https://your-backend-url.example.com',
  userId: 'user-001',
  disableLocalActiveReplyScheduler: true
};
```

## Current limitation
This backend currently supports:
- backend offline message generation
- syncing when the user returns to the page

It does not yet fully support:
- true instant Web Push when the webpage is fully closed
