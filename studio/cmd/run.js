#!/usr/bin/env bun
import { $ } from "bun";
import { parseArgs } from "util";
import fs from "node:fs";
import path from "node:path";

function init() {
  const { values, positionals } = parseArgs({
    args: Bun.argv,
    options: {
      output: {
        type: "string",
        short: "o",
      },
      mode: {
        type: "string",
        short: "m",
        default: "extract", // or "pack"
      },
    },
    strict: true,
    allowPositionals: true,
  });

  return { args: positionals.slice(2), options: { ...values } };
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

// Import function to extract .hyp file
async function importApp(filePath) {
  console.log(`Reading file: ${filePath}`);

  // Read file as ArrayBuffer
  const file = Bun.file(filePath);
  const buffer = await file.arrayBuffer();
  const view = new DataView(buffer);

  // Read header size (first 4 bytes)
  const headerSize = view.getUint32(0, true);
  console.log(`Header size: ${headerSize} bytes`);

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

// Export function to pack a directory into a .hyp file
async function packDirectory(dirPath, outputPath) {
  try {
    // Read the blueprint.json file
    const blueprintPath = path.join(dirPath, "blueprint.json");
    if (!fs.existsSync(blueprintPath)) {
      console.error(`Error: blueprint.json not found in ${dirPath}`);
      process.exit(1);
    }

    const blueprintJson = JSON.parse(fs.readFileSync(blueprintPath, "utf8"));
    console.log(`Loaded blueprint for: ${blueprintJson.name || "unnamed app"}`);

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
        console.warn(`Warning: Model file ${modelFileName} not found`);
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
        console.warn(`Warning: Script file ${scriptFileName} not found`);
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
        console.warn(`Warning: Image file ${imageFileName} not found`);
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
            console.warn(`Warning: Prop file ${propFileName} not found`);
          }
        }
      }
    }

    // Read asset files and create header
    const assets = [];
    console.log("\nCollecting assets:");

    for (const assetInfo of assetPaths) {
      const file = Bun.file(assetInfo.path);
      const stat = fs.statSync(assetInfo.path);
      const data = await file.arrayBuffer();

      console.log(
        `- ${path.basename(assetInfo.path)} (${assetInfo.type}, ${stat.size} bytes)`
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
    const outputFile =
      outputPath ||
      path.join(process.cwd(), `${blueprintJson.name || "app"}.hyp`);

    // Create an array of all the binary data we need to write
    const fileData = [headerSize, headerBytes];
    for (const asset of assets) {
      fileData.push(new Uint8Array(asset.data));
    }

    // Write the file
    await Bun.write(outputFile, fileData);

    console.log(`\nCreated .hyp file: ${outputFile}`);
    return outputFile;
  } catch (error) {
    console.error("Error packing directory:", error);
    process.exit(1);
  }
}

// Function to extract a .hyp file
async function extractHypFile(filePath, outputDir) {
  try {
    // Import and parse the .hyp file
    const importedApp = await importApp(filePath);

    // Get app name from blueprint or fallback to file name
    const appName =
      importedApp.blueprint.name || path.basename(filePath, ".hyp");
    const appDir = path.join(outputDir, appName);

    // Create directory structure
    console.log(`Creating directory: ${appDir}`);
    fs.mkdirSync(appDir, { recursive: true });

    // Save blueprint.json
    const blueprintPath = path.join(appDir, "blueprint.json");
    fs.writeFileSync(
      blueprintPath,
      JSON.stringify(importedApp.blueprint, null, 2)
    );
    console.log(`Saved blueprint to: ${blueprintPath}`);

    // Extract all assets
    console.log("\nExtracting assets:");
    for (const asset of importedApp.assets) {
      const assetPath = path.join(appDir, asset.fileName);
      await Bun.write(assetPath, asset.data);
      console.log(`- ${asset.fileName} (${asset.type}, ${asset.size} bytes)`);
    }

    console.log(`\nApp successfully extracted to: ${appDir}`);
    return appDir;
  } catch (error) {
    console.error("Error extracting .hyp file:", error);
    process.exit(1);
  }
}

// Main execution
const { args, options } = init();

if (args.length === 0) {
  console.error("Error: Please provide a file path or directory.");
  console.log("Usage:");
  console.log(
    "  Extract: ./hyp-tool.js <file.hyp> [--mode extract] [--output build]"
  );
  console.log(
    "  Pack:    ./hyp-tool.js <directory> --mode pack [--output app.hyp]"
  );
  process.exit(1);
}

const targetPath = args[0];
const { mode, output } = options;

if (mode === "extract") {
  // Validate input file
  if (!targetPath.endsWith(".hyp")) {
    console.error("Error: File must have .hyp extension.");
    process.exit(1);
  }

  if (!fs.existsSync(targetPath)) {
    console.error(`Error: File not found: ${targetPath}`);
    process.exit(1);
  }

  // Run the extraction
  extractHypFile(targetPath, output || "build");
} else if (mode === "pack") {
  // Validate input directory
  if (!fs.existsSync(targetPath)) {
    console.error(`Error: Directory not found: ${targetPath}`);
    process.exit(1);
  }

  if (!fs.statSync(targetPath).isDirectory()) {
    console.error(`Error: ${targetPath} is not a directory.`);
    process.exit(1);
  }

  // Run the packing
  packDirectory(targetPath, output);
} else {
  console.error(`Error: Unknown mode '${mode}'. Use 'extract' or 'pack'.`);
  process.exit(1);
}
