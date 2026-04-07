FROM oven/bun:1

WORKDIR /app

COPY package.json bun.lock* ./
RUN bun install --frozen-lockfile || bun install

COPY . .

ENV NODE_ENV=production \
    PORT=3001
EXPOSE 3001

HEALTHCHECK --interval=10s --timeout=5s --retries=10 \
  CMD bun -e "fetch('http://localhost:3001/').then(r=>{process.exit(r.ok?0:1)}).catch(()=>process.exit(1))"

CMD ["bun", "run", "src/index.ts"]
