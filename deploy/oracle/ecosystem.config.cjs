// pm2 process file for the OpenReply DM worker on a small always-on VM
// (Oracle Cloud Always Free, VM.Standard.E2.1.Micro, 1 GB RAM).
//
// Secrets are read from <repo>/.env by Node's --env-file at every start, so
// they never land in pm2's own dump file (~/.pm2/dump.pm2). The interpreter is
// set to node explicitly: pm2 would otherwise pick its own TypeScript runner.
module.exports = {
  apps: [
    {
      name: "openreply-worker",
      // Repository root (this file lives in deploy/oracle/).
      cwd: `${__dirname}/../..`,
      script: "worker/dm-worker.ts",
      interpreter: "node",
      interpreter_args: "--env-file=.env --import tsx --max-old-space-size=384",
      exec_mode: "fork",
      instances: 1,
      autorestart: true,
      exp_backoff_restart_delay: 2000,
      // dm-worker.ts drains BullMQ on SIGTERM/SIGINT; give it time to finish.
      kill_timeout: 30000,
      max_memory_restart: "500M",
      time: true,
    },
  ],
};
