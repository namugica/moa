FROM node:22-alpine
WORKDIR /app
COPY server.mjs model.mjs app.mjs auth.mjs account.mjs shared.mjs supabase-client.mjs config.mjs index.html styles.css ./
COPY assets ./assets
RUN mkdir /data && chown node:node /data
ENV HOST=0.0.0.0 PORT=8000 MOA_DATA_DIR=/data
USER node
EXPOSE 8000
VOLUME ["/data"]
CMD ["node", "server.mjs"]
