module.exports = {
  apps: [{
    name: 'crm-automations',
    script: 'src/server.js',
    cwd: __dirname,
    instances: 1,
    exec_mode: 'fork',
    autorestart: true,
    time: true,
    env: { NODE_ENV: 'production' },
    // Leave room for young-generation heap, Prisma, buffers and native memory
    // below PM2's process-wide RSS threshold on the 1 GB host.
    node_args: ['--max-old-space-size=192'],
    max_memory_restart: '400M',
  }],
};
