#!/usr/bin/env node
import { program } from "commander";
import fs from "node:fs";
import { promises as fsPromises } from "node:fs";
import path from "node:path";
import chalk from "chalk";
import { createHash } from "crypto";

import { rollup } from "rollup";
import manifestPlugin from "./rollupManifestPlugin.js";

import Knex from "knex";

// Add a function to connect to the database
async function getDB(dbPath) {
  return Knex({
    client: "better-sqlite3",
    connection: {
      filename: dbPath,
    },
    useNullAsDefault: true,
  });
}

// Package info
const VERSION = "1.0.0";

async function buildWithRollup(inputPath, outputPath, appDir) {
  try {
    // Create a rollup bundle with our custom plugin
    const bundle = await rollup({
      input: inputPath,
      plugins: [manifestPlugin()],
      onwarn(warning, warn) {
        // Suppress certain warnings if needed
        if (warning.code === "CIRCULAR_DEPENDENCY") return;
        warn(warning);
      },
    });

    // Generate the output
    const { output } = await bundle.write({
      file: outputPath,
      format: "iife",
      banner: "// Built with hyp-cli\nprops;",
    });

    // Close the bundle
    await bundle.close();

    // Check if we have a blueprint.json in the output assets
    const blueprintAsset = output.find(
      (asset) => asset.fileName === "blueprint.json" && asset.type === "asset"
    );

    if (blueprintAsset) {
      // Parse the blueprint data to validate it
      let blueprintData;
      try {
        blueprintData = JSON.parse(blueprintAsset.source);
        console.log(
          chalk.green("Successfully extracted manifest:"),
          Object.keys(blueprintData).join(", ")
        );
      } catch (err) {
        console.error(chalk.red("Failed to parse extracted manifest:"), err);
        return { success: true, blueprint: null };
      }

      // Write the blueprint.json to the app directory
      fs.writeFileSync(
        path.join(appDir, "blueprint.json"),
        blueprintAsset.source
      );
      console.log(chalk.green("Extracted manifest to blueprint.json"));

      return {
        success: true,
        blueprint: blueprintData,
      };
    } else {
      console.warn(chalk.yellow("No manifest found in script file"));
      return { success: true, blueprint: null };
    }
  } catch (error) {
    console.error(chalk.red("Rollup build error:"), error);
    return { success: false, blueprint: null };
  }
}

// Utility functions for buffer conversions
function str2ab(str) {
  const buf = new Uint8Array(str.length);
  for (let i = 0; i < str.length; i++) {
    buf[i] = str.charCodeAt(i);
  }
  return buf;
}

function ab2str(buf) {
  return new TextDecoder().decode(buf);
}

// Function to calculate file hash
async function hashFile(filePath) {
  const data = await fsPromises.readFile(filePath);
  const hash = createHash("sha256");
  hash.update(data);
  return hash.digest("hex");
}

// Helper function to get file extension
function getFileExtension(filePath) {
  return path.extname(filePath);
}

// Ensure directory exists
function ensureDir(dir) {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

// Store asset in the global assets folder
async function storeAsset(sourcePath, globalAssetsDir, verbose = false) {
  try {
    // Check if source file exists
    if (!fs.existsSync(sourcePath)) {
      if (verbose) {
        console.log(chalk.yellow(`Asset file not found: ${sourcePath}`));
      }
      return null;
    }

    // Read file content and generate hash
    const hash = await hashFile(sourcePath);

    // Get file extension
    const ext = path.extname(sourcePath);

    // Create new filename based on hash
    const assetFilename = `${hash}${ext}`;
    const destPath = path.join(globalAssetsDir, assetFilename);

    // Ensure global assets directory exists
    ensureDir(globalAssetsDir);

    // Copy file if it doesn't already exist in the global assets folder
    if (!fs.existsSync(destPath)) {
      await fsPromises.copyFile(sourcePath, destPath);
      if (verbose) {
        console.log(
          chalk.green(`Stored asset: ${sourcePath} → ${assetFilename}`)
        );
      }
    } else if (verbose) {
      console.log(chalk.dim(`Asset already exists: ${assetFilename}`));
    }

    // Return asset info
    return {
      originalPath: sourcePath,
      originalName: path.basename(sourcePath),
      hash: hash,
      filename: assetFilename,
      extension: ext,
    };
  } catch (err) {
    console.error(chalk.red(`Error storing asset ${sourcePath}:`), err.message);
    return null;
  }
}

function parseHypHeader(buffer, headerSize) {
  // Read header
  const headerBytes = new Uint8Array(buffer.slice(4, 4 + headerSize));

  // Get string representation (may contain problematic characters)
  const rawHeaderStr = ab2str(headerBytes);

  // Fix the known problematic fields
  const fixedHeaderStr = rawHeaderStr.replace(
    /"(message\d*|emoji\d*)":"[^"]*"/g,
    (match) => {
      // Clean up any problematic characters in these specific fields
      return match.replace(/[^\x20-\x7E]/g, "");
    }
  );

  // Parse the fixed JSON
  try {
    return JSON.parse(fixedHeaderStr);
  } catch (error) {
    console.error("Still having JSON parsing issues:", error);
    // More aggressive fallback: remove all non-ASCII characters
    const ultraSafeStr = rawHeaderStr.replace(/[^\x20-\x7E]/g, "");
    return JSON.parse(ultraSafeStr);
  }
}

// Import function to extract .hyp file
async function importApp(filePath) {
  console.log(chalk.blue(`Reading file: ${filePath}`));

  // Read file as Buffer
  const buffer = await fsPromises.readFile(filePath);
  const view = new DataView(
    buffer.buffer,
    buffer.byteOffset,
    buffer.byteLength
  );

  // Read header size (first 4 bytes)
  const headerSize = view.getUint32(0, true);
  console.log(chalk.dim(`Header size: ${headerSize} bytes`));

  let header;
  try {
    const headerBytes = new Uint8Array(buffer.slice(4, 4 + headerSize));
    header = JSON.parse(ab2str(headerBytes)); // this is the regular hyperfy way
  } catch (error) {
    // attempt to fix JSON
    header = parseHypHeader(buffer, headerSize); // this replaces problematic characters
  }

  // Extract files
  let position = 4 + headerSize;
  const assets = [];

  for (const assetInfo of header.assets) {
    const data = buffer.slice(position, position + assetInfo.size);
    const fileName = assetInfo.url.split("/").pop();

    assets.push({
      type: assetInfo.type,
      url: assetInfo.url,
      fileName,
      data,
      size: assetInfo.size,
      mime: assetInfo.mime,
    });

    position += assetInfo.size;
  }

  return {
    blueprint: header.blueprint,
    assets,
  };
}

// Helper function to determine MIME type
function getMimeType(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  const mimeTypes = {
    ".vrm": "model/vrm",
    ".gltf": "model/gltf+json",
    ".glb": "model/gltf-binary",
    ".js": "application/javascript",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".gif": "image/gif",
    ".webp": "image/webp",
    ".mp3": "audio/mpeg",
    ".wav": "audio/wav",
    ".mp4": "video/mp4",
    ".webm": "video/webm",
  };

  return mimeTypes[ext] || "application/octet-stream";
}

async function extractHypFile(filePath, outputDir, globalAssetsDir, options) {
  try {
    // Validate input file
    if (!filePath.endsWith(".hyp")) {
      console.error(chalk.red("Error: File must have .hyp extension."));
      process.exit(1);
    }

    if (!fs.existsSync(filePath)) {
      console.error(chalk.red(`Error: File not found: ${filePath}`));
      process.exit(1);
    }

    // Import and parse the .hyp file
    const importedApp = await importApp(filePath);

    // Get app name from blueprint or fallback to file name
    const appName =
      importedApp.blueprint.name || path.basename(filePath, ".hyp");
    const appDir = path.join(outputDir, appName);

    // Create directory structure
    console.log(chalk.blue(`Creating directory: ${appDir}`));
    fs.mkdirSync(appDir, { recursive: true });

    // Ensure global assets directory exists
    ensureDir(globalAssetsDir);

    // Extract all assets to global assets folder and track them
    console.log(chalk.blue("\nExtracting assets:"));
    const extractedAssets = [];

    for (const asset of importedApp.assets) {
      // Write the asset to a temporary file
      const tempAssetPath = path.join(appDir, asset.fileName);
      await fsPromises.writeFile(tempAssetPath, asset.data);

      // Store in global assets folder
      const assetInfo = await storeAsset(
        tempAssetPath,
        globalAssetsDir,
        options.verbose
      );

      if (assetInfo) {
        extractedAssets.push({
          ...assetInfo,
          type: asset.type,
          url: asset.url,
          size: asset.size,
          mime: asset.mime,
        });

        console.log(
          chalk.green(`- ${asset.fileName}`) +
            chalk.dim(
              ` (${asset.type}, ${asset.size} bytes) → ${assetInfo.filename}`
            )
        );

        // Update blueprint references to use the new asset paths
        if (asset.url === importedApp.blueprint.model) {
          importedApp.blueprint.model = `asset://${assetInfo.filename}`;
        }

        if (asset.url === importedApp.blueprint.script) {
          importedApp.blueprint.script = `asset://${assetInfo.filename}`;
        }

        if (
          importedApp.blueprint.image &&
          asset.url === importedApp.blueprint.image.url
        ) {
          importedApp.blueprint.image.url = `asset://${assetInfo.filename}`;
        }

        // Update props references
        if (importedApp.blueprint.props) {
          for (const key in importedApp.blueprint.props) {
            if (
              importedApp.blueprint.props[key] &&
              importedApp.blueprint.props[key].url === asset.url
            ) {
              importedApp.blueprint.props[key].url =
                `asset://${assetInfo.filename}`;
            }
          }
        }

        // Remove the temporary file
        fs.unlinkSync(tempAssetPath);
      }
    }

    // Save updated blueprint.json with new asset references
    const blueprintPath = path.join(appDir, "blueprint.json");
    fs.writeFileSync(
      blueprintPath,
      JSON.stringify(importedApp.blueprint, null, 2)
    );
    console.log(chalk.green(`Saved blueprint to: ${blueprintPath}`));

    // Save app metadata with assets info
    const metadataPath = path.join(appDir, "app-metadata.json");
    fs.writeFileSync(
      metadataPath,
      JSON.stringify(
        {
          extractedAt: new Date().toISOString(),
          source: filePath,
          assets: extractedAssets,
        },
        null,
        2
      )
    );
    console.log(chalk.green(`Saved metadata to: ${metadataPath}`));

    console.log(chalk.green(`\nApp successfully extracted to: ${appDir}`));
    console.log(chalk.green(`Global assets stored in: ${globalAssetsDir}`));
    return appDir;
  } catch (error) {
    console.error(chalk.red("Error extracting .hyp file:"), error);
    process.exit(1);
  }
}

// Export function to pack a directory into a .hyp file
async function packDirectory(dirPath, outputPath, globalAssetsDir, options) {
  try {
    // Validate input directory
    if (!fs.existsSync(dirPath)) {
      console.error(chalk.red(`Error: Directory not found: ${dirPath}`));
      process.exit(1);
    }

    if (!fs.statSync(dirPath).isDirectory()) {
      console.error(chalk.red(`Error: ${dirPath} is not a directory.`));
      process.exit(1);
    }

    // Read the blueprint.json file
    const blueprintPath = path.join(dirPath, "blueprint.json");
    if (!fs.existsSync(blueprintPath)) {
      console.error(chalk.red(`Error: blueprint.json not found in ${dirPath}`));
      process.exit(1);
    }

    const blueprintJson = JSON.parse(fs.readFileSync(blueprintPath, "utf8"));
    console.log(
      chalk.blue(`Loaded blueprint for: ${blueprintJson.name || "unnamed app"}`)
    );

    // Read metadata if available
    const metadataPath = path.join(dirPath, "app-metadata.json");
    let assetMapping = {};

    if (fs.existsSync(metadataPath)) {
      try {
        const metadata = JSON.parse(fs.readFileSync(metadataPath, "utf8"));
        // Create a mapping from hashed filenames to original info
        for (const asset of metadata.assets) {
          assetMapping[asset.filename] = asset;
        }
        console.log(
          chalk.blue(
            `Loaded metadata with ${Object.keys(assetMapping).length} assets`
          )
        );
      } catch (err) {
        console.warn(
          chalk.yellow(`Warning: Could not parse metadata file: ${err.message}`)
        );
      }
    }

    // Find all assets mentioned in the blueprint
    const assetPaths = [];

    // Check for model
    if (blueprintJson.model) {
      const modelFileName = blueprintJson.model.replace("asset://", "");
      const modelPath = path.join(globalAssetsDir, modelFileName);
      if (fs.existsSync(modelPath)) {
        assetPaths.push({
          type: modelFileName.endsWith(".vrm") ? "avatar" : "model",
          url: blueprintJson.model.replace(
            modelFileName,
            assetMapping[modelFileName]?.originalName || modelFileName
          ),
          path: modelPath,
          originalName: assetMapping[modelFileName]?.originalName,
        });
      } else {
        console.warn(
          chalk.yellow(
            `Warning: Model file ${modelFileName} not found in global assets`
          )
        );
      }
    }

    // Check for script
    if (blueprintJson.script) {
      const scriptFileName = blueprintJson.script.replace("asset://", "");
      const scriptPath = path.join(globalAssetsDir, scriptFileName);
      if (fs.existsSync(scriptPath)) {
        assetPaths.push({
          type: "script",
          url: blueprintJson.script.replace(
            scriptFileName,
            assetMapping[scriptFileName]?.originalName || scriptFileName
          ),
          path: scriptPath,
          originalName: assetMapping[scriptFileName]?.originalName,
        });
      } else {
        console.warn(
          chalk.yellow(
            `Warning: Script file ${scriptFileName} not found in global assets`
          )
        );
      }
    }

    // Check for image
    if (blueprintJson.image && blueprintJson.image.url) {
      const imageFileName = blueprintJson.image.url.replace("asset://", "");
      const imagePath = path.join(globalAssetsDir, imageFileName);
      if (fs.existsSync(imagePath)) {
        assetPaths.push({
          type: "texture",
          url: blueprintJson.image.url.replace(
            imageFileName,
            assetMapping[imageFileName]?.originalName || imageFileName
          ),
          path: imagePath,
          originalName: assetMapping[imageFileName]?.originalName,
        });
      } else {
        console.warn(
          chalk.yellow(
            `Warning: Image file ${imageFileName} not found in global assets`
          )
        );
      }
    }

    // Check for props
    if (blueprintJson.props) {
      for (const key in blueprintJson.props) {
        const value = blueprintJson.props[key];
        if (value && value.url) {
          const propFileName = value.url.replace("asset://", "");
          const propPath = path.join(globalAssetsDir, propFileName);
          if (fs.existsSync(propPath)) {
            assetPaths.push({
              type: value.type,
              url: value.url.replace(
                propFileName,
                assetMapping[propFileName]?.originalName || propFileName
              ),
              path: propPath,
              originalName: assetMapping[propFileName]?.originalName,
            });
          } else {
            console.warn(
              chalk.yellow(
                `Warning: Prop file ${propFileName} not found in global assets`
              )
            );
          }
        }
      }
    }

    // Read asset files and create header
    const assets = [];
    console.log(chalk.blue("\nCollecting assets:"));

    for (const assetInfo of assetPaths) {
      const data = await fsPromises.readFile(assetInfo.path);
      const stat = fs.statSync(assetInfo.path);

      // If we're using original names in the .hyp file, prepare the name to show
      const displayName =
        assetInfo.originalName || path.basename(assetInfo.path);

      console.log(
        chalk.green(`- ${displayName}`) +
          chalk.dim(` (${assetInfo.type}, ${stat.size} bytes)`)
      );

      assets.push({
        type: assetInfo.type,
        url: assetInfo.url,
        data: data,
        size: stat.size,
        mime: getMimeType(assetInfo.path),
      });
    }

    // Create a version of blueprintJson with original asset paths
    const packedBlueprint = JSON.parse(JSON.stringify(blueprintJson));

    // Restore original paths for packaging
    if (packedBlueprint.model && packedBlueprint.model.startsWith("asset://")) {
      const modelFileName = packedBlueprint.model.replace("asset://", "");
      if (assetMapping[modelFileName]) {
        packedBlueprint.model = `asset://${assetMapping[modelFileName].originalName}`;
      }
    }

    if (
      packedBlueprint.script &&
      packedBlueprint.script.startsWith("asset://")
    ) {
      const scriptFileName = packedBlueprint.script.replace("asset://", "");
      if (assetMapping[scriptFileName]) {
        packedBlueprint.script = `asset://${assetMapping[scriptFileName].originalName}`;
      }
    }

    if (
      packedBlueprint.image &&
      packedBlueprint.image.url &&
      packedBlueprint.image.url.startsWith("asset://")
    ) {
      const imageFileName = packedBlueprint.image.url.replace("asset://", "");
      if (assetMapping[imageFileName]) {
        packedBlueprint.image.url = `asset://${assetMapping[imageFileName].originalName}`;
      }
    }

    if (packedBlueprint.props) {
      for (const key in packedBlueprint.props) {
        const value = packedBlueprint.props[key];
        if (value && value.url && value.url.startsWith("asset://")) {
          const propFileName = value.url.replace("asset://", "");
          if (assetMapping[propFileName]) {
            packedBlueprint.props[key].url =
              `asset://${assetMapping[propFileName].originalName}`;
          }
        }
      }
    }

    // Create header structure
    const header = {
      blueprint: packedBlueprint,
      assets: assets.map((asset) => ({
        type: asset.type,
        url: asset.url,
        size: asset.size,
        mime: asset.mime,
      })),
    };

    // Convert header to bytes
    const headerBytes = str2ab(JSON.stringify(header));

    // Create header size prefix (4 bytes)
    const headerSize = new Uint8Array(4);
    new DataView(headerSize.buffer).setUint32(0, headerBytes.length, true);

    // Determine output filename
    if (!outputPath) {
      outputPath = path.join(
        process.cwd(),
        `${packedBlueprint.name || "app"}.hyp`
      );
    } else if (
      fs.existsSync(outputPath) &&
      fs.statSync(outputPath).isDirectory()
    ) {
      outputPath = path.join(
        outputPath,
        `${packedBlueprint.name || "app"}.hyp`
      );
    }

    // Create an array of all the binary data we need to write
    const fileData = [headerSize, headerBytes];
    for (const asset of assets) {
      fileData.push(new Uint8Array(asset.data));
    }

    // Write the file
    await fsPromises.writeFile(
      outputPath,
      Buffer.concat(fileData.map((item) => Buffer.from(item)))
    );

    console.log(chalk.green(`\nCreated .hyp file: ${outputPath}`));
    return outputPath;
  } catch (error) {
    console.error(chalk.red("Error packing directory:"), error);
    process.exit(1);
  }
}

// Set up the CLI
program
  .name("hyp-cli")
  .description("Command line tool for working with .hyp files")
  .version(VERSION);

// Extract command
program
  .command("extract")
  .description("Extract a .hyp file to a directory")
  .argument("<file>", "Path to the .hyp file to extract")
  .option(
    "-o, --output <directory>",
    'Output directory (default: "./build")',
    "./build"
  )
  .option("-a, --assets <path>", "Global assets directory", "./assets")
  .option("-v, --verbose", "Show verbose output")
  .action(async (file, options) => {
    await extractHypFile(file, options.output, options.assets, options);
  });

program
  .command("pack")
  .description("Pack a directory into a .hyp file")
  .argument(
    "<directory>",
    "Path to the directory containing blueprint.json and assets"
  )
  .option(
    "-o, --output <file>",
    "Output file path (default: based on app name)"
  )
  .option("-a, --assets <path>", "Global assets directory", "./assets")
  .option("-v, --verbose", "Show verbose output")
  .action(async (directory, options) => {
    await packDirectory(directory, options.output, options.assets, options);
  });

// Info command to display information about a .hyp file
program
  .command("info")
  .description("Display information about a .hyp file")
  .argument("<file>", "Path to the .hyp file")
  .action(async (file) => {
    try {
      // Validate input file
      if (!file.endsWith(".hyp")) {
        console.error(chalk.red("Error: File must have .hyp extension."));
        process.exit(1);
      }

      if (!fs.existsSync(file)) {
        console.error(chalk.red(`Error: File not found: ${file}`));
        process.exit(1);
      }

      // Import and parse the .hyp file
      const importedApp = await importApp(file);

      // Display information
      console.log(chalk.blue("\nApp Information:"));
      console.log(chalk.bold("Name:"), importedApp.blueprint.name || "Unnamed");

      if (importedApp.blueprint.model) {
        console.log(chalk.bold("Model:"), importedApp.blueprint.model);
      }

      if (importedApp.blueprint.script) {
        console.log(chalk.bold("Script:"), importedApp.blueprint.script);
      }

      console.log(
        chalk.bold("Locked:"),
        importedApp.blueprint.locked ? "Yes" : "No"
      );

      console.log(chalk.blue("\nAssets:"));
      for (const asset of importedApp.assets) {
        console.log(
          `- ${chalk.bold(asset.fileName)} (${asset.type}, ${asset.size} bytes)`
        );
      }
    } catch (error) {
      console.error(chalk.red("Error reading .hyp file:"), error);
      process.exit(1);
    }
  });

// Add default command behavior
program
  .argument("[command]", "Command to run (extract, pack, info)")
  .action((cmd) => {
    if (!cmd) {
      program.help();
    }
  });

/**
 * Locates an asset file based on a relative path or filename
 * @param {string} assetPath - Asset path or filename
 * @param {string[]} searchDirs - Directories to search in order of priority
 * @returns {object|null} - Object with originalPath and fileName or null if not found
 */
export function findAsset(assetPath, searchDirs) {
  // Strip asset:// prefix if present
  const cleanPath = assetPath.startsWith("asset://")
    ? assetPath.substring(8)
    : assetPath;

  // Try as provided path
  if (fs.existsSync(cleanPath)) {
    return {
      originalPath: cleanPath,
      fileName: path.basename(cleanPath),
    };
  }

  // Try as a filename in each search directory
  const fileName = path.basename(cleanPath);
  for (const dir of searchDirs) {
    if (!fs.existsSync(dir)) continue;

    const fullPath = path.join(dir, fileName);
    if (fs.existsSync(fullPath)) {
      return {
        originalPath: fullPath,
        fileName: fileName,
      };
    }
  }

  // Try path relative to each search directory
  for (const dir of searchDirs) {
    if (!fs.existsSync(dir)) continue;

    const fullPath = path.join(dir, cleanPath);
    if (fs.existsSync(fullPath)) {
      return {
        originalPath: fullPath,
        fileName: path.basename(fullPath),
      };
    }
  }

  return null;
}

/**
 * Process assets from a blueprint object
 * @param {object} blueprint - The blueprint object
 * @param {object} options - Options object
 * @param {string} options.appDir - Output directory for the app
 * @param {string[]} options.searchDirs - Directories to search for assets
 * @param {string} options.globalAssetsDir - Global assets directory
 * @returns {Promise<object>} - Updated blueprint and list of copied assets
 */
export async function processAssets(blueprint, options) {
  const { appDir, searchDirs, globalAssetsDir } = options;
  const assetsCopied = [];
  const updatedBlueprint = { ...blueprint };

  // Ensure global assets directory exists
  ensureDir(globalAssetsDir);

  // Process model
  if (updatedBlueprint.model) {
    const asset = findAsset(updatedBlueprint.model, searchDirs);
    if (asset) {
      // Store asset in global assets folder
      const assetInfo = await storeAsset(
        asset.originalPath,
        globalAssetsDir,
        options.verbose
      );

      if (assetInfo) {
        assetsCopied.push({
          ...assetInfo,
          type: "model",
        });

        // Update blueprint reference to use the new asset path
        updatedBlueprint.model = `asset://${assetInfo.filename}`;
      }
    } else {
      console.warn(
        chalk.yellow(
          `Warning: Model asset not found: ${updatedBlueprint.model}`
        )
      );
    }
  }

  // Process image
  if (updatedBlueprint.image && updatedBlueprint.image.url) {
    const asset = findAsset(updatedBlueprint.image.url, searchDirs);
    if (asset) {
      // Store asset in global assets folder
      const assetInfo = await storeAsset(
        asset.originalPath,
        globalAssetsDir,
        options.verbose
      );

      if (assetInfo) {
        assetsCopied.push({
          ...assetInfo,
          type: "image",
        });

        // Update blueprint reference to use the new asset path
        updatedBlueprint.image.url = `asset://${assetInfo.filename}`;
      }
    } else {
      console.warn(
        chalk.yellow(
          `Warning: Image asset not found: ${updatedBlueprint.image.url}`
        )
      );
    }
  }

  // Process props
  if (updatedBlueprint.props) {
    for (const key in updatedBlueprint.props) {
      const prop = updatedBlueprint.props[key];
      if (prop && prop.url) {
        const asset = findAsset(prop.url, searchDirs);
        if (asset) {
          // Store asset in global assets folder
          const assetInfo = await storeAsset(
            asset.originalPath,
            globalAssetsDir,
            options.verbose
          );

          if (assetInfo) {
            assetsCopied.push({
              ...assetInfo,
              type: "prop",
              propKey: key,
            });

            // Update blueprint reference to use the new asset path
            updatedBlueprint.props[key].url = `asset://${assetInfo.filename}`;
          }
        } else {
          console.warn(
            chalk.yellow(`Warning: Prop asset not found: ${prop.url} (${key})`)
          );
        }
      }
    }
  }

  // Save app metadata with assets info
  const metadataPath = path.join(appDir, "app-metadata.json");
  fs.writeFileSync(
    metadataPath,
    JSON.stringify(
      {
        processedAt: new Date().toISOString(),
        assets: assetsCopied,
      },
      null,
      2
    )
  );

  if (options.verbose) {
    console.log(chalk.green(`Saved metadata to: ${metadataPath}`));
  }

  return {
    blueprint: updatedBlueprint,
    assets: assetsCopied,
  };
}

// Build command
program
  .command("build")
  .description(
    "Build app scripts, copy assets, and optionally package as .hyp file"
  )
  .argument("[app-names...]", "App names to build (omit to build all apps)")
  .option("-o, --output <directory>", "Output directory", "./build")
  .option(
    "-a, --apps-dir <directory>",
    "Apps directory containing source files",
    "./apps"
  )
  .option(
    "-as, --assets-dir <directory>",
    "Assets directory containing media files",
    "./assets"
  )
  .option(
    "-ga, --global-assets <directory>",
    "Global assets directory for storing hashed assets",
    "./global-assets"
  )
  .option(
    "-c, --cache-dir <directory>",
    "Cache directory for temporary files",
    "./cache"
  )
  .option(
    "-p, --package",
    "Automatically package the built app as a .hyp file",
    false
  )
  .option(
    "--package-dir <directory>",
    "Directory to save packaged .hyp files",
    "./dist"
  )
  .option("-v, --verbose", "Show verbose output")
  .option("--no-manifest", "Skip manifest extraction", false)
  .action(async (appNames, options) => {
    try {
      // Ensure directories exist
      [options.output, options.cacheDir, options.globalAssets].forEach(
        (dir) => {
          if (!fs.existsSync(dir)) {
            fs.mkdirSync(dir, { recursive: true });
          }
        }
      );

      // Create package directory if needed
      if (options.package && !fs.existsSync(options.packageDir)) {
        fs.mkdirSync(options.packageDir, { recursive: true });
      }

      const appsDir = options.appsDir;
      if (!fs.existsSync(appsDir)) {
        console.error(
          chalk.red(`Error: Apps directory '${appsDir}' not found`)
        );
        process.exit(1);
      }

      const assetsDir = options.assetsDir;
      if (!fs.existsSync(assetsDir)) {
        console.warn(
          chalk.yellow(`Warning: Assets directory '${assetsDir}' not found`)
        );
      }

      // Get list of script files to process
      let appFiles = [];
      if (appNames.length === 0) {
        // Build all apps if no specific app names provided
        console.log(chalk.blue("Building all apps..."));

        const files = fs.readdirSync(appsDir);
        appFiles = files
          .filter(
            (file) =>
              file.endsWith(".js") ||
              file.endsWith(".jsx") ||
              file.endsWith(".ts") ||
              file.endsWith(".tsx")
          )
          .map((file) => ({
            name: path.basename(file, path.extname(file)),
            path: path.join(appsDir, file),
          }));
      } else {
        // Build only specified apps
        console.log(chalk.blue(`Building apps: ${appNames.join(", ")}...`));

        appFiles = appNames
          .map((name) => {
            // Try different extensions
            const extensions = [".js", ".jsx", ".ts", ".tsx"];
            for (const ext of extensions) {
              const filePath = path.join(appsDir, `${name}${ext}`);
              if (fs.existsSync(filePath)) {
                return {
                  name,
                  path: filePath,
                };
              }
            }

            console.error(
              chalk.red(
                `Error: Source file for '${name}' not found in ${appsDir}`
              )
            );
            return null;
          })
          .filter(Boolean);
      }

      if (appFiles.length === 0) {
        console.error(chalk.red("No source files found to build"));
        process.exit(1);
      }

      // Track built apps for packaging
      const builtApps = [];

      // Process each source file
      for (const app of appFiles) {
        console.log(chalk.blue(`\nProcessing app: ${app.name}`));

        // Create app directory
        const appDir = path.join(options.output, app.name);
        if (!fs.existsSync(appDir)) {
          fs.mkdirSync(appDir, { recursive: true });
        }

        // Build the script
        console.log(chalk.dim(`Building script: ${app.path}`));

        const outDir = path.join(options.cacheDir, app.name);
        if (!fs.existsSync(outDir)) {
          fs.mkdirSync(outDir, { recursive: true });
        }

        const outputPath = path.join(outDir, "script.js");

        try {
          // Use Rollup programmatically with our manifest plugin
          const result = await buildWithRollup(app.path, outputPath, appDir);

          if (result.success) {
            console.log(
              chalk.green(`Script built successfully: ${outputPath}`)
            );

            // Hash the built script file and store in global assets
            const scriptAssetInfo = await storeAsset(
              outputPath,
              options.globalAssets,
              options.verbose
            );

            if (!scriptAssetInfo) {
              console.error(
                chalk.red(`Failed to store script asset for ${app.name}`)
              );
              continue;
            }

            console.log(
              chalk.green(
                `Stored script in global assets: ${scriptAssetInfo.filename}`
              )
            );

            // If we have a blueprint from the manifest, process assets
            let blueprintData = result.blueprint;

            // If no manifest was found in the source, check for existing blueprint
            if (!blueprintData) {
              const existingBlueprintPath = path.join(
                appsDir,
                `${app.name}.json`
              );
              if (fs.existsSync(existingBlueprintPath)) {
                console.log(
                  chalk.yellow(
                    `No manifest found, using existing blueprint: ${existingBlueprintPath}`
                  )
                );
                blueprintData = JSON.parse(
                  fs.readFileSync(existingBlueprintPath, "utf8")
                );
              } else {
                // Create a basic blueprint
                console.log(
                  chalk.yellow(
                    `No manifest or blueprint found, creating basic blueprint`
                  )
                );
                blueprintData = {
                  name: app.name,
                  script: `asset://${scriptAssetInfo.filename}`,
                };
              }
            }

            // Update the script path in the blueprint
            blueprintData.script = `asset://${scriptAssetInfo.filename}`;

            // Process assets using our helper function
            const searchDirs = [
              assetsDir,
              path.dirname(app.path),
              process.cwd(),
            ];

            const { blueprint: updatedBlueprint, assets: copiedAssets } =
              await processAssets(blueprintData, {
                appDir,
                searchDirs,
                globalAssetsDir: options.globalAssets,
                verbose: options.verbose,
              });

            // Add script to assets list
            copiedAssets.push({
              ...scriptAssetInfo,
              type: "script",
            });

            // Log copied assets
            for (const asset of copiedAssets) {
              if (asset.type !== "script") {
                // Skip script asset as already logged
                console.log(
                  chalk.green(
                    `Processed ${asset.type}${asset.propKey ? ` (${asset.propKey})` : ""}: ${path.basename(asset.originalPath)} → ${asset.filename}`
                  )
                );
              }
            }

            // Save updated blueprint to app directory
            const blueprintDestPath = path.join(appDir, "blueprint.json");
            fs.writeFileSync(
              blueprintDestPath,
              JSON.stringify(updatedBlueprint, null, 2)
            );
            console.log(
              chalk.green(`Saved blueprint to: ${blueprintDestPath}`)
            );

            console.log(chalk.green(`Successfully built app: ${app.name}`));

            // Add to list of built apps for packaging
            builtApps.push({
              name: app.name,
              dir: appDir,
              assets: copiedAssets,
            });
          } else {
            console.error(chalk.red(`Failed to build script for ${app.name}`));
            continue;
          }
        } catch (error) {
          console.error(
            chalk.red(`Error building script for ${app.name}:`),
            error
          );
          continue;
        }
      }

      console.log(
        chalk.green(
          `\nBuild process completed. Built ${builtApps.length} app(s) to ${options.output}`
        )
      );

      // Package as .hyp files if requested
      if (options.package && builtApps.length > 0) {
        console.log(chalk.blue("\nPackaging apps as .hyp files..."));

        for (const app of builtApps) {
          try {
            const hypPath = await packDirectory(
              app.dir,
              path.join(options.packageDir, `${app.name}.hyp`),
              options.globalAssets,
              { verbose: options.verbose }
            );

            console.log(chalk.green(`Packaged ${app.name} to: ${hypPath}`));
          } catch (error) {
            console.error(chalk.red(`Error packaging ${app.name}:`), error);
          }
        }

        console.log(
          chalk.green(
            `\nPackaging complete. ${builtApps.length} app(s) packaged to ${options.packageDir}`
          )
        );
      }
    } catch (error) {
      console.error(chalk.red("Error during build:"), error);
      process.exit(1);
    }
  });

program
  .command("deploy")
  .description("Build apps and deploy directly to a world database")
  .argument(
    "[app-names...]",
    "App names to build and deploy (omit to deploy all apps)"
  )
  .option("-o, --output <directory>", "Output directory", "./build")
  .option(
    "-a, --apps-dir <directory>",
    "Apps directory containing source files",
    "./apps"
  )
  .option(
    "-as, --assets-dir <directory>",
    "Assets directory containing media files",
    "./assets"
  )
  .option(
    "-ga, --global-assets <directory>",
    "Global assets directory for storing hashed assets",
    "./global-assets"
  )
  .option(
    "-c, --cache-dir <directory>",
    "Cache directory for temporary files",
    "./cache"
  )
  .option(
    "-db, --db-path <path>",
    "Path to the world database",
    "./database.sqlite"
  )
  .option(
    "-id, --blueprint-id <id>",
    "Custom ID for the blueprint (generates UUID if not provided)"
  )
  .option(
    "-p, --position <x,y,z>",
    "Position in the world (comma-separated)",
    "1,1,1"
  )
  .option(
    "-r, --rotation <x,y,z,w>",
    "Rotation as quaternion (comma-separated)",
    "0,0,0,1"
  )
  .option(
    "-s, --scale <x,y,z>",
    "Scale in the world (comma-separated)",
    "1,1,1"
  )
  .option(
    "-e, --create-entity",
    "Create an entity instance from the blueprint",
    false
  )
  .option("-w, --world-id <id>", "World ID to associate with the blueprint")
  .option("-v, --verbose", "Show verbose output")
  .action(async (appNames, options) => {
    try {
      // Ensure directories exist
      [options.output, options.cacheDir, options.globalAssets].forEach(
        (dir) => {
          if (!fs.existsSync(dir)) {
            fs.mkdirSync(dir, { recursive: true });
          }
        }
      );

      const appsDir = options.appsDir;
      const assetsDir = options.assetsDir;
      if (!fs.existsSync(appsDir)) {
        console.error(
          chalk.red(`Error: Apps directory '${appsDir}' not found`)
        );
        process.exit(1);
      }

      // Get list of script files to process (similar to build command)
      let appFiles = [];
      if (appNames.length === 0) {
        console.log(chalk.blue("Building all apps..."));
        const files = fs.readdirSync(appsDir);
        appFiles = files
          .filter(
            (file) =>
              file.endsWith(".js") ||
              file.endsWith(".jsx") ||
              file.endsWith(".ts") ||
              file.endsWith(".tsx")
          )
          .map((file) => ({
            name: path.basename(file, path.extname(file)),
            path: path.join(appsDir, file),
          }));
      } else {
        console.log(chalk.blue(`Building apps: ${appNames.join(", ")}...`));
        appFiles = appNames
          .map((name) => {
            const extensions = [".js", ".jsx", ".ts", ".tsx"];
            for (const ext of extensions) {
              const filePath = path.join(appsDir, `${name}${ext}`);
              if (fs.existsSync(filePath)) {
                return { name, path: filePath };
              }
            }
            console.error(
              chalk.red(
                `Error: Source file for '${name}' not found in ${appsDir}`
              )
            );
            return null;
          })
          .filter(Boolean);
      }

      if (appFiles.length === 0) {
        console.error(chalk.red("No source files found to build"));
        process.exit(1);
      }

      // Track built apps for database insertion
      const builtApps = [];

      // Process each source file (similar to build command)
      for (const app of appFiles) {
        console.log(chalk.blue(`\nProcessing app: ${app.name}`));

        // Create app directory
        const appDir = path.join(options.output, app.name);
        if (!fs.existsSync(appDir)) {
          fs.mkdirSync(appDir, { recursive: true });
        }

        // Build the script (reusing code from build command)
        console.log(chalk.dim(`Building script: ${app.path}`));
        const outDir = path.join(options.cacheDir, app.name);
        if (!fs.existsSync(outDir)) {
          fs.mkdirSync(outDir, { recursive: true });
        }

        const outputPath = path.join(outDir, "script.js");

        try {
          // Use Rollup to build with manifest plugin
          const result = await buildWithRollup(app.path, outputPath, appDir);

          if (result.success) {
            console.log(
              chalk.green(`Script built successfully: ${outputPath}`)
            );

            // Hash and store the script in global assets
            const scriptAssetInfo = await storeAsset(
              outputPath,
              options.globalAssets,
              options.verbose
            );

            if (!scriptAssetInfo) {
              console.error(
                chalk.red(`Failed to store script asset for ${app.name}`)
              );
              continue;
            }

            console.log(
              chalk.green(
                `Stored script in global assets: ${scriptAssetInfo.filename}`
              )
            );

            // Get or create blueprint
            let blueprintData = result.blueprint;
            if (!blueprintData) {
              const existingBlueprintPath = path.join(
                appsDir,
                `${app.name}.json`
              );
              if (fs.existsSync(existingBlueprintPath)) {
                console.log(
                  chalk.yellow(
                    `No manifest found, using existing blueprint: ${existingBlueprintPath}`
                  )
                );
                blueprintData = JSON.parse(
                  fs.readFileSync(existingBlueprintPath, "utf8")
                );
              } else {
                console.log(
                  chalk.yellow(
                    `No manifest or blueprint found, creating basic blueprint`
                  )
                );
                blueprintData = {
                  name: app.name,
                  script: `asset://${scriptAssetInfo.filename}`,
                };
              }
            }

            // Update script path in blueprint
            blueprintData.script = `asset://${scriptAssetInfo.filename}`;

            // Process assets
            const searchDirs = [
              assetsDir,
              path.dirname(app.path),
              process.cwd(),
            ];

            const { blueprint: updatedBlueprint, assets: copiedAssets } =
              await processAssets(blueprintData, {
                appDir,
                searchDirs,
                globalAssetsDir: options.globalAssets,
                verbose: options.verbose,
              });

            // Add script to assets list
            copiedAssets.push({
              ...scriptAssetInfo,
              type: "script",
            });

            // Log copied assets
            for (const asset of copiedAssets) {
              if (asset.type !== "script") {
                // Skip script asset as already logged
                console.log(
                  chalk.green(
                    `Processed ${asset.type}${asset.propKey ? ` (${asset.propKey})` : ""}: ${path.basename(
                      asset.originalPath
                    )} → ${asset.filename}`
                  )
                );
              }
            }

            // Set custom blueprint ID if provided
            if (options.blueprintId) {
              updatedBlueprint.id = options.blueprintId;
            } else if (!updatedBlueprint.id) {
              updatedBlueprint.id = createHash("sha256")
                .update(app.name)
                .digest("hex")
                .substr(0, 32);
            }

            // Store transform data temporarily for entity creation
            const transform = {
              position: options.position.split(",").map((v) => parseFloat(v)),
              quaternion: options.rotation.split(",").map((v) => parseFloat(v)),
              scale: options.scale.split(",").map((v) => parseFloat(v)),
            };

            // Store the transform with the app data for entity creation later
            app.transform = transform;

            // Add world ID if provided
            if (options.worldId) {
              updatedBlueprint.worldId = options.worldId;
            }

            // Save blueprint to app directory
            const blueprintDestPath = path.join(appDir, "blueprint.json");
            fs.writeFileSync(
              blueprintDestPath,
              JSON.stringify(updatedBlueprint, null, 2)
            );
            console.log(
              chalk.green(`Saved blueprint to: ${blueprintDestPath}`)
            );

            // Add to list of built apps
            builtApps.push({
              name: app.name,
              dir: appDir,
              blueprint: updatedBlueprint,
              assets: copiedAssets,
              transform: transform,
            });

            console.log(chalk.green(`Successfully built app: ${app.name}`));
          } else {
            console.error(chalk.red(`Failed to build script for ${app.name}`));
          }
        } catch (error) {
          console.error(
            chalk.red(`Error building script for ${app.name}:`),
            error
          );
        }
      }

      // Connect to the database
      console.log(chalk.blue(`\nConnecting to database: ${options.dbPath}`));
      const db = await getDB(options.dbPath);

      try {
        // Determine world assets folder path (next to the database)
        const dbDir = path.dirname(options.dbPath);
        const worldAssetsDir = path.join(dbDir, "assets");

        // Ensure world assets directory exists
        if (!fs.existsSync(worldAssetsDir)) {
          console.log(
            chalk.blue(`Creating world assets directory: ${worldAssetsDir}`)
          );
          fs.mkdirSync(worldAssetsDir, { recursive: true });
        }

        // Insert or update blueprints in the database
        for (const app of builtApps) {
          console.log(chalk.blue(`\nDeploying app: ${app.name}`));
          const blueprint = app.blueprint;

          // Copy assets to world assets folder
          console.log(
            chalk.blue(
              `Copying assets to world assets folder: ${worldAssetsDir}`
            )
          );

          // Copy all assets from global assets folder to world assets folder
          for (const asset of app.assets) {
            const assetFileName = asset.filename;
            const assetPath = path.join(options.globalAssets, assetFileName);
            const assetDestPath = path.join(worldAssetsDir, assetFileName);

            if (fs.existsSync(assetPath)) {
              fs.copyFileSync(assetPath, assetDestPath);
              console.log(
                chalk.green(`Copied asset to world assets: ${assetFileName}`)
              );
            }
          }

          // Check if blueprint already exists
          const existing = await db("blueprints")
            .where("id", blueprint.id)
            .first();
          const now = new Date().toISOString();

          if (existing) {
            // Update existing blueprint
            await db("blueprints")
              .where("id", blueprint.id)
              .update({
                data: JSON.stringify(blueprint),
                updatedAt: now,
              });
            console.log(
              chalk.green(`Updated blueprint in database: ${blueprint.id}`)
            );
          } else {
            // Insert new blueprint
            await db("blueprints").insert({
              id: blueprint.id,
              data: JSON.stringify(blueprint),
              createdAt: now,
              updatedAt: now,
            });
            console.log(
              chalk.green(`Inserted blueprint into database: ${blueprint.id}`)
            );
          }

          // Create entity if requested
          if (options.createEntity) {
            const entityId = createHash("sha256")
              .update(`${blueprint.id}-entity`)
              .digest("hex")
              .substr(0, 32);

            // Prepare entity data with transform information
            const entityData = {
              id: entityId,
              type: blueprint.type || "app",
              blueprint: blueprint.id,
              position: app.transform.position,
              quaternion: app.transform.quaternion,
              pinned: false,
              mover: null,
              uploader: null,
              state: { ready: true, holders: {} }, // Initialize with a ready state
            };

            // Check if entity already exists
            const existingEntity = await db("entities")
              .where("id", entityId)
              .first();

            if (existingEntity) {
              // Update existing entity
              await db("entities")
                .where("id", entityId)
                .update({
                  data: JSON.stringify(entityData),
                  updatedAt: now,
                });
              console.log(
                chalk.green(`Updated entity in database: ${entityId}`)
              );
            } else {
              // Insert new entity
              await db("entities").insert({
                id: entityId,
                data: JSON.stringify(entityData),
                createdAt: now,
                updatedAt: now,
              });
              console.log(
                chalk.green(`Created entity in database: ${entityId}`)
              );
            }
          }
        }

        console.log(
          chalk.green(
            `\nDeployment complete. Deployed ${builtApps.length} app(s) to the database.`
          )
        );
      } finally {
        // Close the database connection
        await db.destroy();
      }
    } catch (error) {
      console.error(chalk.red("Error during deployment:"), error);
      process.exit(1);
    }
  });

// Parse and execute
program.parse();
