#!/usr/bin/env bun
import { program } from "commander";
import { $ } from "bun";
import fs from "node:fs";
import path from "node:path";
import chalk from "chalk";
import { createHash } from "crypto";

// Package info
const VERSION = "1.0.0";

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

  // Read header
  const headerBytes = new Uint8Array(buffer.slice(4, 4 + headerSize));
  const header = JSON.parse(ab2str(headerBytes));

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

// Build command
program
  .command("build")
  .description("Build app scripts and package into app folders")
  .argument("[app-names...]", "App names to build (omit to build all apps)")
  .option("-o, --output <directory>", "Output directory", "./build")
  .option(
    "-a, --apps-dir <directory>",
    "Apps directory containing blueprint files",
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
  .option("-v, --verbose", "Show verbose output")
  .action(async (appNames, options) => {
    try {
      // Ensure directories exist
      [options.output, options.cacheDir].forEach((dir) => {
        if (!fs.existsSync(dir)) {
          fs.mkdirSync(dir, { recursive: true });
        }
      });

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

      // Get list of blueprint files to process
      let blueprintFiles = [];
      if (appNames.length === 0) {
        // Build all apps if no specific app names provided
        console.log(chalk.blue("Building all apps..."));

        const files = fs.readdirSync(appsDir);
        blueprintFiles = files
          .filter((file) => file.endsWith(".json"))
          .map((file) => ({
            name: path.basename(file, ".json"),
            path: path.join(appsDir, file),
          }));
      } else {
        // Build only specified apps
        console.log(chalk.blue(`Building apps: ${appNames.join(", ")}...`));

        blueprintFiles = appNames
          .map((name) => {
            const fileName = name.endsWith(".json") ? name : `${name}.json`;
            const filePath = path.join(appsDir, fileName);

            if (!fs.existsSync(filePath)) {
              console.error(
                chalk.red(
                  `Error: Blueprint file for '${name}' not found at ${filePath}`
                )
              );
              return null;
            }

            return {
              name: path.basename(fileName, ".json"),
              path: filePath,
            };
          })
          .filter(Boolean);
      }

      if (blueprintFiles.length === 0) {
        console.error(chalk.red("No blueprint files found to build"));
        process.exit(1);
      }

      // Process each blueprint file
      for (const blueprint of blueprintFiles) {
        console.log(chalk.blue(`\nProcessing app: ${blueprint.name}`));

        // Read the blueprint file
        const blueprintData = JSON.parse(
          fs.readFileSync(blueprint.path, "utf8")
        );

        // Check if script exists
        if (!blueprintData.script) {
          console.warn(
            chalk.yellow(
              `Warning: No script specified in blueprint for ${blueprint.name}, skipping build`
            )
          );
          continue;
        }

        // Resolve script path - try multiple possible locations
        let scriptPath = null;
        const scriptRelativePath = blueprintData.script;

        // Try different possible locations for the script file
        const possibleScriptPaths = [
          // Path relative to the blueprint file
          path.resolve(path.dirname(blueprint.path), scriptRelativePath),
          // Path relative to project root
          path.resolve(scriptRelativePath),
          // Path relative to src directory at project root
          path.resolve("src", scriptRelativePath),
          // Path as a direct filename in the src directory (if src/ prefix is already in the path)
          path.resolve(scriptRelativePath.replace("src/", "")),
          // Path with src as sibling to apps directory
          path.resolve(path.dirname(options.appsDir), scriptRelativePath),
        ];

        console.log(
          chalk.dim(`Looking for script file at possible locations:`)
        );
        for (const possiblePath of possibleScriptPaths) {
          console.log(chalk.dim(`- ${possiblePath}`));
          if (fs.existsSync(possiblePath)) {
            scriptPath = possiblePath;
            console.log(chalk.green(`Found script at: ${scriptPath}`));
            break;
          }
        }

        // Check if script file exists in any of the checked locations
        if (!scriptPath) {
          console.error(
            chalk.red(
              `Error: Script file not found for ${blueprint.name}: ${scriptRelativePath}`
            )
          );
          console.error(chalk.red(`Tried the following paths:`));
          possibleScriptPaths.forEach((p) =>
            console.error(chalk.red(`- ${p}`))
          );
          continue;
        }

        // Build the script with rollup
        console.log(chalk.dim(`Building script: ${scriptPath}`));

        const outDir = path.join(options.cacheDir, blueprint.name);
        if (!fs.existsSync(outDir)) {
          fs.mkdirSync(outDir, { recursive: true });
        }

        const outputPath = path.join(outDir, "script.js");
        // Create app directory
        const appDir = path.join(options.output, blueprint.name);
        if (!fs.existsSync(appDir)) {
          fs.mkdirSync(appDir, { recursive: true });
        }

        try {
          await $`bunx rollup -c --input ${scriptPath} --file ${outputPath}`.quiet();
          console.log(chalk.green(`Script built successfully: ${outputPath}`));

          // Hash the built script file
          const scriptHash = await hashFile(outputPath);
          const scriptExt = getFileExtension(scriptPath);
          const hashedScriptName = `${scriptHash}${scriptExt}`;
          const hashedScriptPath = path.join(appDir, hashedScriptName);

          // Copy the built script to the app directory with the hashed name
          fs.copyFileSync(outputPath, hashedScriptPath);
          console.log(
            chalk.green(`Copied script with hash: ${hashedScriptName}`)
          );

          // Update the blueprint with the hashed script name
          blueprintData.script = `asset://${hashedScriptName}`;
        } catch (error) {
          console.error(
            chalk.red(`Error building script for ${blueprint.name}:`),
            error.stderr || error
          );
          continue;
        }

        // Helper function to handle asset:// URLs and extract filenames
        const getAssetFileName = (assetPath) => {
          if (assetPath.startsWith("asset://")) {
            return assetPath.replace("asset://", "");
          }
          return assetPath.split("/").pop();
        };

        // Process and hash all referenced asset files
        const assetsToCopy = [];

        // Check for model file
        if (blueprintData.model) {
          const modelFileName = getAssetFileName(blueprintData.model);
          const modelSourcePath = path.join(assetsDir, modelFileName);

          if (fs.existsSync(modelSourcePath)) {
            // Hash the model file
            const modelHash = await hashFile(modelSourcePath);
            const modelExt = getFileExtension(modelFileName);
            const hashedModelName = `${modelHash}${modelExt}`;
            const hashedModelPath = path.join(appDir, hashedModelName);

            assetsToCopy.push({
              source: modelSourcePath,
              dest: hashedModelPath,
              type: "model",
              originalName: modelFileName,
              hashedName: hashedModelName,
            });

            // Update blueprint with hashed model name
            blueprintData.model = `asset://${hashedModelName}`;
          } else {
            console.warn(
              chalk.yellow(
                `Warning: Model file ${modelFileName} not found in assets directory`
              )
            );
          }
        }

        // Check for image
        if (blueprintData.image && blueprintData.image.url) {
          const imageFileName = getAssetFileName(blueprintData.image.url);
          const imageSourcePath = path.join(assetsDir, imageFileName);

          if (fs.existsSync(imageSourcePath)) {
            // Hash the image file
            const imageHash = await hashFile(imageSourcePath);
            const imageExt = getFileExtension(imageFileName);
            const hashedImageName = `${imageHash}${imageExt}`;
            const hashedImagePath = path.join(appDir, hashedImageName);

            assetsToCopy.push({
              source: imageSourcePath,
              dest: hashedImagePath,
              type: "image",
              originalName: imageFileName,
              hashedName: hashedImageName,
            });

            // Update blueprint with hashed image name
            blueprintData.image.url = `asset://${hashedImageName}`;
          } else {
            console.warn(
              chalk.yellow(
                `Warning: Image file ${imageFileName} not found in assets directory`
              )
            );
          }
        }

        // Check for props
        if (blueprintData.props) {
          for (const key in blueprintData.props) {
            const value = blueprintData.props[key];
            if (value && value.url) {
              const propFileName = getAssetFileName(value.url);
              const propSourcePath = path.join(assetsDir, propFileName);

              if (fs.existsSync(propSourcePath)) {
                // Hash the prop file
                const propHash = await hashFile(propSourcePath);
                const propExt = getFileExtension(propFileName);
                const hashedPropName = `${propHash}${propExt}`;
                const hashedPropPath = path.join(appDir, hashedPropName);

                assetsToCopy.push({
                  source: propSourcePath,
                  dest: hashedPropPath,
                  type: "prop",
                  originalName: propFileName,
                  hashedName: hashedPropName,
                });

                // Update blueprint with hashed prop name
                blueprintData.props[key].url = `asset://${hashedPropName}`;
              } else {
                console.warn(
                  chalk.yellow(
                    `Warning: Prop file ${propFileName} not found in assets directory at ${propSourcePath}`
                  )
                );
              }
            }
          }
        }

        // Copy all assets with hashed names
        for (const asset of assetsToCopy) {
          fs.copyFileSync(asset.source, asset.dest);
          console.log(
            chalk.green(
              `Copied ${asset.type}: ${asset.originalName} → ${asset.hashedName}`
            )
          );
        }

        // Save updated blueprint to app directory
        const blueprintDestPath = path.join(appDir, "blueprint.json");
        fs.writeFileSync(
          blueprintDestPath,
          JSON.stringify(blueprintData, null, 2)
        );
        console.log(chalk.green(`Saved blueprint to: ${blueprintDestPath}`));

        console.log(chalk.green(`Successfully built app: ${blueprint.name}`));
      }

      console.log(
        chalk.green(
          `\nBuild process completed. Built ${blueprintFiles.length} app(s) to ${options.output}`
        )
      );
    } catch (error) {
      console.error(chalk.red("Error during build:"), error);
      process.exit(1);
    }
  });

// Parse and execute
program.parse();
