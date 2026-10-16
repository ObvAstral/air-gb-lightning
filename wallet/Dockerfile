FROM node:24.19.0-trixie

RUN apt-get update && apt-get install -y --no-install-recommends \
    git gpg ca-certificates curl build-essential python3 pkg-config \
    clang libclang-dev protobuf-compiler libssl-dev cmake \
    && rm -rf /var/lib/apt/lists/*

RUN curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y --default-toolchain 1.94.0 --profile minimal
ENV PATH="/root/.cargo/bin:${PATH}"

WORKDIR /app
COPY . .
RUN npm ci --ignore-scripts && npm run native:build

EXPOSE 8787
CMD ["node", "--import", "tsx", "apps/local-service/server.ts"]
