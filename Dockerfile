FROM oven/bun:latest

COPY package.json bun.lock .env ./
COPY . .

RUN bun i

ENTRYPOINT [ "bun", "run", "dev" ]