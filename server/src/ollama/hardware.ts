import os from "node:os";
import fs from "node:fs";
import { execFile } from "node:child_process";

export interface HardwareProfile {
  platform: string;
  release: string;
  cpuModel: string;
  cpuCores: number;
  ramTotalMb: number;
  ramFreeMb: number;
  diskFreeGb: number;
  gpu: string;
  gpuKind: "cuda" | "rocm" | "none";
  inference: "cpu" | "cuda/rocm";
  verdict: string;
}

function exec(cmd: string, args: string[], timeoutMs = 3000): Promise<string | null> {
  return new Promise((resolve) => {
    try {
      execFile(cmd, args, { timeout: timeoutMs }, (err, stdout) => resolve(err ? null : stdout));
    } catch {
      resolve(null);
    }
  });
}

export async function detectHardware(): Promise<HardwareProfile> {
  const cpus = os.cpus();
  const ramFreeMb = os.freemem() / 1024 / 1024;
  let diskFreeGb = 0;
  try {
    const st = await fs.promises.statfs(".");
    diskFreeGb = (st.bavail * st.bsize) / 1024 ** 3;
  } catch {
    /* disk detection is advisory */
  }

  let gpu = "none detected";
  let gpuKind: HardwareProfile["gpuKind"] = "none";

  const nvidia = await exec("nvidia-smi", ["--query-gpu=name,memory.total", "--format=csv,noheader"], 2500);
  if (nvidia) {
    gpu = nvidia.trim().split("\n")[0];
    gpuKind = "cuda";
  } else {
    const rocm = await exec("rocminfo", []);
    if (rocm && /GPU|gfx[0-9]/i.test(rocm)) {
      gpu = "AMD ROCm GPU";
      gpuKind = "rocm";
    } else {
      const pci = await exec("lspci", []);
      const match = pci?.split("\n").find((l) => /vga|3d controller|display/i.test(l));
      if (match) gpu = match.split(":").slice(2).join(":").trim();
    }
  }

  const inference: HardwareProfile["inference"] = gpuKind === "none" ? "cpu" : "cuda/rocm";
  const ramTotalMb = os.totalmem() / 1024 / 1024;
  const cores = cpus.length;
  let verdict: string;
  if (ramTotalMb <= 8192 && gpuKind === "none") {
    verdict = `CPU-only inference on ~${(ramTotalMb / 1024).toFixed(1)} GB RAM: stay at or below 4B-parameter quantized models (q4_K_M) for the main tier and 1–3B for light tasks. Avoid running heavy and light generative models concurrently.`;
  } else if (gpuKind === "none") {
    verdict = `No discrete GPU, ${cores} CPU cores and ${(ramTotalMb / 1024).toFixed(0)} GB RAM: 7–8B quantized models are workable, 4B models are fast.`;
  } else {
    verdict = `${gpu} detected: this machine can host larger models entirely on GPU; check GPU memory against each model's size.`;
  }

  return {
    platform: `${os.type()} ${os.release()}`,
    release: os.platform(),
    cpuModel: cpus[0]?.model ?? "unknown CPU",
    cpuCores: cores,
    ramTotalMb: Math.round(ramTotalMb),
    ramFreeMb: Math.round(ramFreeMb),
    diskFreeGb: Math.round(diskFreeGb),
    gpu,
    gpuKind,
    inference,
    verdict,
  };
}
