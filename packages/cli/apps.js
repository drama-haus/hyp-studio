#!/usr/bin/env bun
import { program } from "commander";
import { $ } from "bun";
import fs from "node:fs";
import path from "node:path";
import chalk from "chalk";
import { createHash } from "crypto";

import { rollup } from "rollup";
import manifestPlugin from "./rollupManifestPlugin.js";

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
  const file = Bun.file(filePath);
  const data = await file.arrayBuffer();
  const hash = createHash("sha256");
  hash.update(new Uint8Array(data));
  return hash.digest("hex");
}

// Helper function to get file extension
function getFileExtension(filePath) {
  return path.extname(filePath);
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

  // Read file as ArrayBuffer
  const file = Bun.file(filePath);
  const buffer = await file.arrayBuffer();
  const view = new DataView(buffer);

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
async function extractHypFile(filePath, outputDir, options) {
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

    // Save blueprint.json
    const blueprintPath = path.join(appDir, "blueprint.json");
    fs.writeFileSync(
      blueprintPath,
      JSON.stringify(importedApp.blueprint, null, 2)
    );
    console.log(chalk.green(`Saved blueprint to: ${blueprintPath}`));

    // Extract all assets
    console.log(chalk.blue("\nExtracting assets:"));
    for (const asset of importedApp.assets) {
      const assetPath = path.join(appDir, asset.fileName);
      await Bun.write(assetPath, asset.data);
      console.log(
        chalk.green(`- ${asset.fileName}`) +
          chalk.dim(` (${asset.type}, ${asset.size} bytes)`)
      );
    }

    console.log(chalk.green(`\nApp successfully extracted to: ${appDir}`));
    return appDir;
  } catch (error) {
    console.error(chalk.red("Error extracting .hyp file:"), error);
    process.exit(1);
  }
}

// Export function to pack a directory into a .hyp file
async function packDirectory(dirPath, outputPath, options) {
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

    // Find all assets mentioned in the blueprint
    const assetPaths = [];

    // Check for model
    if (blueprintJson.model) {
      const modelFileName = blueprintJson.model.split("/").pop();
      const modelPath = path.join(dirPath, modelFileName);
      if (fs.existsSync(modelPath)) {
        assetPaths.push({
          type: blueprintJson.model.endsWith(".vrm") ? "avatar" : "model",
          url: blueprintJson.model,
          path: modelPath,
        });
      } else {
        console.warn(
          chalk.yellow(`Warning: Model file ${modelFileName} not found`)
        );
      }
    }

    // Check for script
    if (blueprintJson.script) {
      const scriptFileName = blueprintJson.script.split("/").pop();
      const scriptPath = path.join(dirPath, scriptFileName);
      if (fs.existsSync(scriptPath)) {
        assetPaths.push({
          type: "script",
          url: blueprintJson.script,
          path: scriptPath,
        });
      } else {
        console.warn(
          chalk.yellow(`Warning: Script file ${scriptFileName} not found`)
        );
      }
    }

    // Check for image
    if (blueprintJson.image && blueprintJson.image.url) {
      const imageFileName = blueprintJson.image.url.split("/").pop();
      const imagePath = path.join(dirPath, imageFileName);
      if (fs.existsSync(imagePath)) {
        assetPaths.push({
          type: "texture",
          url: blueprintJson.image.url,
          path: imagePath,
        });
      } else {
        console.warn(
          chalk.yellow(`Warning: Image file ${imageFileName} not found`)
        );
      }
    }

    // Check for props
    if (blueprintJson.props) {
      for (const key in blueprintJson.props) {
        const value = blueprintJson.props[key];
        if (value && value.url) {
          const propFileName = value.url.split("/").pop();
          const propPath = path.join(dirPath, propFileName);
          if (fs.existsSync(propPath)) {
            assetPaths.push({
              type: value.type,
              url: value.url,
              path: propPath,
            });
          } else {
            console.warn(
              chalk.yellow(`Warning: Prop file ${propFileName} not found`)
            );
          }
        }
      }
    }

    // Read asset files and create header
    const assets = [];
    console.log(chalk.blue("\nCollecting assets:"));

    for (const assetInfo of assetPaths) {
      const file = Bun.file(assetInfo.path);
      const stat = fs.statSync(assetInfo.path);
      const data = await file.arrayBuffer();

      console.log(
        chalk.green(`- ${path.basename(assetInfo.path)}`) +
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

    // Create header structure
    const header = {
      blueprint: blueprintJson,
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
        `${blueprintJson.name || "app"}.hyp`
      );
    } else if (
      fs.existsSync(outputPath) &&
      fs.statSync(outputPath).isDirectory()
    ) {
      outputPath = path.join(outputPath, `${blueprintJson.name || "app"}.hyp`);
    }

    // Create an array of all the binary data we need to write
    const fileData = [headerSize, headerBytes];
    for (const asset of assets) {
      fileData.push(new Uint8Array(asset.data));
    }

    // Write the file
    await Bun.write(outputPath, fileData);

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
  .option("-v, --verbose", "Show verbose output")
  .action(async (file, options) => {
    await extractHypFile(file, options.output, options);
  });

// Pack command
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
  .option("-v, --verbose", "Show verbose output")
  .action(async (directory, options) => {
    await packDirectory(directory, options.output, options);
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
 * Calculate file hash for content-based caching
 * @param {string} filePath - Path to the file to hash
 * @returns {Promise<string>} - Hex string hash of the file
 */
export async function hashFile(filePath) {
  const file = Bun.file(filePath);
  const data = await file.arrayBuffer();
  const hash = createHash("sha256");
  hash.update(new Uint8Array(data));
  return hash.digest("hex");
}

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
 * @returns {Promise<object>} - Updated blueprint and list of copied assets
 */
export async function processAssets(blueprint, options) {
  const { appDir, searchDirs } = options;
  const assetsCopied = [];
  const updatedBlueprint = { ...blueprint };

  // Process model
  if (updatedBlueprint.model) {
    const asset = findAsset(updatedBlueprint.model, searchDirs);
    if (asset) {
      const hash = await hashFile(asset.originalPath);
      const ext = path.extname(asset.fileName);
      const hashedName = `${hash}${ext}`;
      const destPath = path.join(appDir, hashedName);

      fs.copyFileSync(asset.originalPath, destPath);
      assetsCopied.push({
        source: asset.originalPath,
        dest: destPath,
        type: "model",
        hashedName,
      });

      updatedBlueprint.model = `asset://${hashedName}`;
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
      const hash = await hashFile(asset.originalPath);
      const ext = path.extname(asset.fileName);
      const hashedName = `${hash}${ext}`;
      const destPath = path.join(appDir, hashedName);

      fs.copyFileSync(asset.originalPath, destPath);
      assetsCopied.push({
        source: asset.originalPath,
        dest: destPath,
        type: "image",
        hashedName,
      });

      updatedBlueprint.image.url = `asset://${hashedName}`;
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
          const hash = await hashFile(asset.originalPath);
          const ext = path.extname(asset.fileName);
          const hashedName = `${hash}${ext}`;
          const destPath = path.join(appDir, hashedName);

          fs.copyFileSync(asset.originalPath, destPath);
          assetsCopied.push({
            source: asset.originalPath,
            dest: destPath,
            type: "prop",
            propKey: key,
            hashedName,
          });

          updatedBlueprint.props[key].url = `asset://${hashedName}`;
        } else {
          console.warn(
            chalk.yellow(`Warning: Prop asset not found: ${prop.url} (${key})`)
          );
        }
      }
    }
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
      [options.output, options.cacheDir].forEach((dir) => {
        if (!fs.existsSync(dir)) {
          fs.mkdirSync(dir, { recursive: true });
        }
      });

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

            // Hash the built script file
            const scriptHash = await hashFile(outputPath);
            const scriptExt = getFileExtension(app.path);
            const hashedScriptName = `${scriptHash}${scriptExt}`;
            const hashedScriptPath = path.join(appDir, hashedScriptName);

            // Copy the built script to the app directory with the hashed name
            fs.copyFileSync(outputPath, hashedScriptPath);
            console.log(
              chalk.green(`Copied script with hash: ${hashedScriptName}`)
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
                  script: `asset://${hashedScriptName}`,
                };
              }
            }

            // Update the script path in the blueprint
            blueprintData.script = `asset://${hashedScriptName}`;

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
              });

            // Log copied assets
            for (const asset of copiedAssets) {
              console.log(
                chalk.green(
                  `Copied ${asset.type}${asset.propKey ? ` (${asset.propKey})` : ""}: ${path.basename(asset.source)} → ${asset.hashedName}`
                )
              );
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

// Parse and execute
program.parse();
