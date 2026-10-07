const fs = require('fs');
const path = require('path');

// Env source of truth is the repo-local .env (see .env.example).
// Only the port is pinned here; everything else comes from .env.
const ENV_PATH = path.join(__dirname, '.env');
const envVars = {};

if (fs.existsSync(ENV_PATH)) {
  const envContent = fs.readFileSync(ENV_PATH, 'utf8');
  envContent.split('\n').forEach(line => {
    const trimmed = line.trim();
    if (trimmed && !trimmed.startsWith('#')) {
      const [key, ...valueParts] = trimmed.split('=');
      if (key && valueParts.length > 0) {
        let value = valueParts.join('=').trim();
        if (
          value.length >= 2 &&
          ((value.startsWith('"') && value.endsWith('"')) ||
            (value.startsWith("'") && value.endsWith("'")))
        ) {
          value = value.slice(1, -1);
        }
        envVars[key.trim()] = value;
      }
    }
  });
}

module.exports = {
  apps: [
    {
      name: 'lain-memory',
      script: 'src/server.ts',
      interpreter: '/Users/lucas/.bun/bin/bun',
      cwd: '/Users/lucas/Documents/lain-memory',
      watch: false,
      autorestart: true,
      max_restarts: 10,
      restart_delay: 5000,
      env: {
        ...envVars,
        NODE_ENV: 'production',
        LAIN_MEMORY_PORT: '3341',
        // Live data path. Overridable via .env; the fallback keeps the
        // current workspace (graph.json, seeds) if .env doesn't set it.
        LAIN_WORKSPACE_DIR: envVars.LAIN_WORKSPACE_DIR ?? '/Users/lucas/Documents/lain/lain-workspace',
        PATH: `/opt/homebrew/bin:/usr/local/bin:${process.env.PATH || '/usr/bin:/bin'}`,
      },
    },
  ],
};
