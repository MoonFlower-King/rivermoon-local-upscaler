const { spawn } = require("node:child_process");
const path = require("node:path");

const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;

const electronPath = path.join(__dirname, "..", "node_modules", "electron", "dist", "electron.exe");
const child = spawn(electronPath, ["."], {
  cwd: path.join(__dirname, ".."),
  env,
  stdio: "inherit",
  windowsHide: false
});

child.on("exit", (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code ?? 0);
});
