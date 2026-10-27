# baskule-computerd:0.2: stateless HTTP bridge from the cells to OpenShell (architecture E4). See README.md.
FROM node:24.22.1-trixie-slim@sha256:43b9ba1142b8dcf33fa8f922ca1be85714adc444e0586c7cf7726daaeabc1bea AS dependencies
RUN corepack enable pnpm
WORKDIR /workspace
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
COPY computerd/v2/package.json computerd/v2/package.json
RUN pnpm --filter baskule-computerd install --prod --frozen-lockfile
COPY computerd/v2/proto computerd/v2/proto
COPY computerd/v2/src computerd/v2/src
RUN pnpm --filter baskule-computerd deploy --prod /out

FROM node:24.22.1-trixie-slim@sha256:43b9ba1142b8dcf33fa8f922ca1be85714adc444e0586c7cf7726daaeabc1bea
ENV NODE_ENV=production
WORKDIR /app
COPY --from=dependencies /out ./
USER node
ENV COMPUTERD_PORT=47094
EXPOSE 47094
HEALTHCHECK --interval=10s --timeout=3s --start-period=10s --start-interval=1s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:'+process.env.COMPUTERD_PORT+'/healthz').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"]
# Node 24 runs the TypeScript sources directly (type stripping; erasable syntax only).
CMD ["node", "--disable-warning=ExperimentalWarning", "src/main.ts"]
