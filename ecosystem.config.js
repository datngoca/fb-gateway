module.exports = {
  apps: [{
    name: 'fb-gateway',
    script: 'server.js',
    instances: 1,
    autorestart: true,
    watch: false,
    max_memory_restart: '150M',
    node_args: '--max-old-space-size=128',
    env: {
      NODE_ENV: 'production'
    }
  }]
};
