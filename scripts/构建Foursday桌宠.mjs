#!/usr/bin/env node
import { execFile } from "node:child_process";
import {
  access,
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const run = promisify(execFile);
const projectRoot = fileURLToPath(new URL("../", import.meta.url));
const args = process.argv.slice(2);
if (args.some((argument) => argument !== "--apply")) {
  throw new Error("Usage: 构建Foursday桌宠.mjs [--apply]");
}
const source = join(projectRoot, "distribution", "pet", "macos", "FoursdayPet.swift");
const outputRoot = join(projectRoot, ".runtime", "foursday-pet");
const output = join(outputRoot, "Foursday Pet.app");
const preview = {
  schema: "foursday-pet-build/v1",
  platform: process.platform,
  source,
  output,
  apply: args.includes("--apply"),
  installed: false,
  productionWrite: false,
  messagesSent: 0,
};
if (!args.includes("--apply")) {
  console.log(JSON.stringify(preview, null, 2));
  process.exit(0);
}
if (process.platform !== "darwin") throw new Error("Foursday pet currently requires macOS");
await access(source);
const [{ stdout }, { stdout: sdkOutput }] = await Promise.all([
  run("/usr/bin/xcrun", ["--find", "swiftc"], {
    timeout: 30_000,
    maxBuffer: 1024 * 1024,
  }),
  run("/usr/bin/xcrun", ["--show-sdk-path"], {
    timeout: 30_000,
    maxBuffer: 1024 * 1024,
  }),
]);
const swiftc = String(stdout).trim();
const sdk = String(sdkOutput).trim();
if (!isAbsolute(swiftc)) throw new Error("Swift compiler is unavailable");
if (!isAbsolute(sdk)) throw new Error("macOS SDK is unavailable");
const architecture = process.arch === "x64" ? "x86_64" : "arm64";
const stageRoot = await mkdtemp(join(tmpdir(), "foursday-pet-build-"));
const stagedApp = join(stageRoot, "Foursday Pet.app");
const contents = join(stagedApp, "Contents");
const executableDirectory = join(contents, "MacOS");
const executable = join(executableDirectory, "Foursday Pet");
try {
  await mkdir(executableDirectory, { recursive: true, mode: 0o700 });
  await run(swiftc, [
    "-O",
    "-sdk", sdk,
    "-target", `${architecture}-apple-macosx14.0`,
    "-framework", "SwiftUI",
    "-framework", "AppKit",
    source,
    "-o", executable,
  ], { cwd: projectRoot, timeout: 180_000, maxBuffer: 8 * 1024 * 1024 });
  await chmod(executable, 0o755);
  const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleDevelopmentRegion</key><string>zh_CN</string>
<key>CFBundleDisplayName</key><string>Foursday Pet</string>
<key>CFBundleExecutable</key><string>Foursday Pet</string>
<key>CFBundleIdentifier</key><string>com.foursday.pet</string>
<key>CFBundleInfoDictionaryVersion</key><string>6.0</string>
<key>CFBundleName</key><string>Foursday Pet</string>
<key>CFBundlePackageType</key><string>APPL</string>
<key>CFBundleShortVersionString</key><string>0.1.0</string>
<key>CFBundleVersion</key><string>1</string>
<key>LSMinimumSystemVersion</key><string>14.0</string>
<key>LSUIElement</key><true/>
<key>NSHighResolutionCapable</key><true/>
</dict></plist>
`;
  await writeFile(join(contents, "Info.plist"), plist, { mode: 0o600 });
  await run("/usr/bin/codesign", ["--force", "--deep", "--sign", "-", stagedApp], {
    timeout: 60_000,
    maxBuffer: 4 * 1024 * 1024,
  });
  await mkdir(outputRoot, { recursive: true, mode: 0o700 });
  await rm(output, { recursive: true, force: true });
  await rename(stagedApp, output);
  const manifest = await readFile(join(output, "Contents", "Info.plist"), "utf8");
  if (!manifest.includes("com.foursday.pet")) throw new Error("Foursday pet bundle verification failed");
  console.log(JSON.stringify({
    ...preview,
    apply: true,
    built: true,
    output,
    adHocSigned: true,
    installed: false,
    dashboardReadOnly: true,
  }, null, 2));
} finally {
  await rm(stageRoot, { recursive: true, force: true });
}
