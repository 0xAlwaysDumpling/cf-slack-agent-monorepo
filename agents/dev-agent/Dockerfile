FROM docker.io/cloudflare/sandbox:0.8.4

ENV npm_config_unsafe_perm=true
ENV COREPACK_ENABLE_STRICT=0

RUN npm install -g @anthropic-ai/claude-code @railway/cli pnpm
RUN apt-get update && apt-get install -y postgresql-client curl gosu && rm -rf /var/lib/apt/lists/*
RUN curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg | dd of=/usr/share/keyrings/githubcli-archive-keyring.gpg \
    && echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" | tee /etc/apt/sources.list.d/github-cli.list > /dev/null \
    && apt-get update && apt-get install -y gh && rm -rf /var/lib/apt/lists/*

# Non-root user so Claude Code allows bypassPermissions
RUN useradd -m -s /bin/bash -u 1000 agent \
    && mkdir -p /workspace && chown -R agent:agent /workspace

EXPOSE 3000
