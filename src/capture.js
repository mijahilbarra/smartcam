import { spawn, exec } from "child_process";
import fs from "fs/promises";
import path from "path";
import util from "util";

const execPromise = util.promisify(exec);

/**
 * Capture a frame from the remote Reolink E321 camera using Neolink
 * @param {string} configPath Path to neolink.toml
 * @param {string} cameraName Camera key in toml (e.g. "barberia")
 * @returns {Promise<{ filePath: string, buffer: Buffer, timestamp: number }>}
 */
export async function captureFrame(configPath = "/app/neolink.toml", cameraName = "barberia") {
  // Ensure no zombie neolink process is running
  try {
    await execPromise("pkill -9 neolink || true");
  } catch (_) {}

  const timestamp = Date.now();
  const outputPath = path.join("/tmp", `snap_${timestamp}.jpeg`);

  const args = [
    "image",
    "-c", configPath,
    "--use-stream",
    "-f", outputPath,
    cameraName
  ];

  console.log(`[Capture] Starting neolink at ${new Date().toISOString()}: neolink ${args.join(" ")}`);

  return new Promise((resolve, reject) => {
    const proc = spawn("neolink", args, {
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, RUST_LOG: "info" }
    });

    let stderr = "";
    let stdout = "";

    proc.stdout.on("data", (data) => {
      const msg = data.toString();
      stdout += msg;
      console.log(`[Neolink Out] ${msg.trim()}`);
    });

    proc.stderr.on("data", (data) => {
      const msg = data.toString();
      stderr += msg;
      console.log(`[Neolink Err] ${msg.trim()}`);
    });

    // Check periodically if output file already has data
    const filePollInterval = setInterval(async () => {
      try {
        const stat = await fs.stat(outputPath);
        if (stat.size > 20000) { // Valid JPEG usually > 100KB
          console.log(`[Capture] File detected: ${stat.size} bytes. Completing early.`);
          clearInterval(filePollInterval);
          clearTimeout(timeoutTimer);
          proc.kill("SIGKILL");
          const buffer = await fs.readFile(outputPath);
          resolve({ filePath: outputPath, buffer, timestamp });
        }
      } catch (_) {
        // File not created yet
      }
    }, 1000);

    const timeoutTimer = setTimeout(() => {
      clearInterval(filePollInterval);
      proc.kill("SIGKILL");
      reject(new Error(`Neolink timed out after 90s. Stderr: ${stderr.slice(-500)}`));
    }, 90000);

    proc.on("close", async (code) => {
      clearInterval(filePollInterval);
      clearTimeout(timeoutTimer);

      if (code !== 0 && code !== null) {
        return reject(new Error(`Neolink exited with code ${code}: ${stderr.slice(-1000)}`));
      }

      try {
        const buffer = await fs.readFile(outputPath);
        console.log(`[Capture] Captured ${buffer.length} bytes to ${outputPath}`);
        resolve({ filePath: outputPath, buffer, timestamp });
      } catch (err) {
        reject(new Error(`Failed to read output image from ${outputPath}: ${err.message}`));
      }
    });

    proc.on("error", (err) => {
      clearInterval(filePollInterval);
      clearTimeout(timeoutTimer);
      reject(new Error(`Failed to spawn neolink: ${err.message}`));
    });
  });
}
