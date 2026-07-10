import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const [command, tag] = process.argv.slice(2);
const tagPattern = /^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?$/;

if (!['check', 'set'].includes(command) || !tagPattern.test(tag ?? "")) {
  console.error("Usage: node scripts/release-version.mjs <check|set> vMAJOR.MINOR.PATCH");
  process.exit(1);
}

const version = tag.slice(1);
const packagePath = path.join(root, "package.json");
const tauriPath = path.join(root, "src-tauri", "tauri.conf.json");
const cargoPath = path.join(root, "src-tauri", "Cargo.toml");

const readJson = (filePath) => JSON.parse(fs.readFileSync(filePath, "utf8"));
const packageJson = readJson(packagePath);
const tauriConfig = readJson(tauriPath);
let cargoToml = fs.readFileSync(cargoPath, "utf8");

const cargoPackagePattern = /(\[package\][\s\S]*?^version\s*=\s*")([^"]+)("\s*$)/m;
const cargoMatch = cargoToml.match(cargoPackagePattern);
if (!cargoMatch) {
  throw new Error("Could not find [package].version in src-tauri/Cargo.toml");
}

if (command === "check") {
  const versions = {
    "package.json": packageJson.version,
    "src-tauri/tauri.conf.json": tauriConfig.version,
    "src-tauri/Cargo.toml": cargoMatch[2],
  };
  const mismatches = Object.entries(versions).filter(([, value]) => value !== version);
  if (mismatches.length > 0) {
    for (const [file, value] of mismatches) {
      console.error(`${file}: expected ${version}, found ${value ?? "unknown"}`);
    }
    process.exit(1);
  }
  console.log(`Release versions match ${tag}.`);
  process.exit(0);
}

packageJson.version = version;
tauriConfig.version = version;
cargoToml = cargoToml.replace(cargoPackagePattern, `$1${version}$3`);

fs.writeFileSync(packagePath, `${JSON.stringify(packageJson, null, 2)}\n`);
fs.writeFileSync(tauriPath, `${JSON.stringify(tauriConfig, null, 2)}\n`);
fs.writeFileSync(cargoPath, cargoToml);
console.log(`Prepared source versions for ${tag}.`);
