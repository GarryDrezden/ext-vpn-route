import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const VERSION_JSON = path.join(ROOT, "version", "product-version.json");

/** @typedef {{ productVersion: string, releaseChannel: string, releaseRevision: number, displayVersion: string, numericVersion: string, npmVersion: string, manifestVersion: string, manifestVersionName: string }} ProductVersionModel */

/**
 * @returns {ProductVersionModel}
 */
export function loadProductVersion() {
  const raw = JSON.parse(readFileSync(VERSION_JSON, "utf8"));
  const productVersion = String(raw.productVersion || "0.0.0").trim();
  const releaseChannel = String(raw.releaseChannel || "").trim();
  const releaseRevision = Number(raw.releaseRevision) || 0;

  let displayVersion = productVersion;
  if (releaseRevision > 0 && releaseChannel && releaseChannel.toLowerCase() !== "stable") {
    displayVersion = `${productVersion} ${releaseChannel}${releaseRevision}`;
  }

  const numericVersion = releaseRevision > 0 ? `${productVersion}.${releaseRevision}` : `${productVersion}.0`;
  const npmVersion =
    releaseRevision > 0 && releaseChannel && releaseChannel.toLowerCase() !== "stable"
      ? `${productVersion}-rc.${releaseRevision}`
      : productVersion;

  return {
    productVersion,
    releaseChannel,
    releaseRevision,
    displayVersion,
    numericVersion,
    npmVersion,
    manifestVersion: numericVersion,
    manifestVersionName: displayVersion
  };
}

export function applyProductVersionToManifest(manifest, model = loadProductVersion()) {
  manifest.version = model.manifestVersion;
  manifest.version_name = model.manifestVersionName;
  return manifest;
}
