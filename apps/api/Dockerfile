FROM node:22.19.0-bookworm-slim
WORKDIR /app
RUN corepack enable && corepack prepare pnpm@10.15.1 --activate
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/api/package.json ./apps/api/package.json
RUN pnpm install --filter @tickit/api... --prod --frozen-lockfile --ignore-scripts
COPY apps/api/src ./apps/api/src
WORKDIR /app/apps/api
ENV NODE_ENV=production HOST=0.0.0.0 PORT=3100
USER node
EXPOSE 3100
HEALTHCHECK --interval=30s --timeout=5s CMD node -e "fetch('http://127.0.0.1:3100/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "src/server.ts"]
