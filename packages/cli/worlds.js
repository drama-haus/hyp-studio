#!/usr/bin/env node
import { Command } from "commander";
import Knex from "knex";
import chalk from "chalk";
import fs from "fs";
import path from "path";
import { table } from "table";
import crypto from "crypto";

// Database connection function
let db;
async function getDB(dbPath) {
  if (!db) {
    db = Knex({
      client: "better-sqlite3",
      connection: {
        filename: dbPath,
      },
      useNullAsDefault: true,
    });
  }
  return db;
}

// Ensure directory exists
function ensureDir(dir) {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

// Hash file and store in global assets folder
function storeAsset(sourcePath, globalAssetsDir, verbose) {
  try {
    // Check if source file exists
    if (!fs.existsSync(sourcePath)) {
      if (verbose) {
        console.log(chalk.yellow(`Asset file not found: ${sourcePath}`));
      }
      return null;
    }

    // Read file content
    const fileContent = fs.readFileSync(sourcePath);

    // Generate hash from file content
    const hash = crypto.createHash("sha256").update(fileContent).digest("hex");

    // Get file extension
    const ext = path.extname(sourcePath);

    // Create new filename based on hash
    const assetFilename = `${hash}${ext}`;
    const destPath = path.join(globalAssetsDir, assetFilename);

    // Ensure global assets directory exists
    ensureDir(globalAssetsDir);

    // Copy file if it doesn't already exist in the global assets folder
    if (!fs.existsSync(destPath)) {
      fs.copyFileSync(sourcePath, destPath);
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

// Main CLI program
const program = new Command();

program
  .name("world-cli")
  .description("World database management CLI tool")
  .version("1.0.0");

// ============ Unpack Command ============
program
  .command("unpack")
  .description("Extract database contents to a directory structure")
  .option(
    "-p, --path <path>",
    "Database file path",
    "./hyperfy/world/db.sqlite"
  )
  .option("-n, --name <name>", "World name")
  .option("-a, --assets <path>", "Global assets directory", "./assets")
  .option("-v, --verbose", "Show verbose output")
  .action(async (options) => {
    // Prompt for world name if not provided
    if (!options.name) {
      console.error(
        chalk.red("Error: World name is required. Use -n or --name option.")
      );
      process.exit(1);
    }

    const outputDir = path.join("./worlds", options.name);
    const dbDir = path.dirname(options.path);
    const assetsDir = path.join(dbDir, "assets");
    const globalAssetsDir = options.assets;
    await unpackDatabase(
      options.path,
      outputDir,
      assetsDir,
      globalAssetsDir,
      options.verbose
    );
  });

// ============ Pack Command ============
program
  .command("pack")
  .description("Import directory structure into a database")
  .argument("<directory>", "Input directory path")
  .option("-p, --path <path>", "Database file path")
  .option("-a, --assets <path>", "Global assets directory", "./assets")
  .option("--force", "Overwrite existing database", false)
  .option("-v, --verbose", "Show verbose output")
  .action(async (directory, options) => {
    if (!options.path) {
      console.error(
        chalk.red(
          "Error: Database path is required for pack command. Use -p or --path option."
        )
      );
      process.exit(1);
    }
    await packDirectory(
      directory,
      options.path,
      options.assets,
      options.force,
      options.verbose
    );
  });

// ============ Info Command ============
program
  .command("info")
  .description("Display information about an unpacked world directory")
  .argument("<directory>", "Directory path")
  .action(async (directory) => {
    await displayWorldInfo(directory);
  });

// ============ Status Command ============
program
  .command("status")
  .description("Show database status")
  .option("-p, --path <path>", "Database file path")
  .action(async (options) => {
    if (!options.path) {
      console.error(
        chalk.red(
          "Error: Database path is required for status command. Use -p or --path option."
        )
      );
      process.exit(1);
    }
    await showDbStatus(options.path);
  });

// ============ Implementation Functions ============

// Unpack a database to a directory structure
async function unpackDatabase(
  dbPath,
  outputDir,
  assetsDir,
  globalAssetsDir,
  verbose
) {
  // Check if database exists
  if (!fs.existsSync(dbPath)) {
    console.error(chalk.red(`Error: Database file not found: ${dbPath}`));
    process.exit(1);
  }

  // Check if assets directory exists
  if (!fs.existsSync(assetsDir)) {
    console.error(chalk.red(`Error: Assets directory not found: ${assetsDir}`));
    process.exit(1);
  }

  // Create database connection
  db = await getDB(dbPath);
  try {
    // Ensure output directory exists
    ensureDir(outputDir);
    console.log(chalk.blue(`Unpacking database: ${dbPath}`));

    // Create subdirectories
    const configDir = path.join(outputDir, "config");
    const usersDir = path.join(outputDir, "users");
    const blueprintsDir = path.join(outputDir, "blueprints");
    const entitiesDir = path.join(outputDir, "entities");

    ensureDir(configDir);
    ensureDir(usersDir);
    ensureDir(blueprintsDir);
    ensureDir(entitiesDir);
    ensureDir(globalAssetsDir);

    // Array to hold all assets
    const assets = [];

    // Extract config
    await extractConfig(db, configDir, verbose);

    // Extract users
    await extractUsers(db, usersDir, verbose);

    // Extract blueprints and their assets
    const blueprintAssets = await extractBlueprints(
      db,
      blueprintsDir,
      assetsDir,
      globalAssetsDir,
      verbose
    );
    assets.push(...blueprintAssets);

    // Extract entities
    await extractEntities(db, entitiesDir, verbose);

    // Create metadata file with assets info
    const metadataPath = path.join(outputDir, "world-metadata.json");
    fs.writeFileSync(
      metadataPath,
      JSON.stringify(
        {
          exportedAt: new Date().toISOString(),
          source: dbPath,
          assetsDir: assetsDir,
          assets: assets,
        },
        null,
        2
      )
    );

    console.log(
      chalk.green(`\nDatabase successfully unpacked to: ${outputDir}`)
    );
    console.log(chalk.green(`Global assets stored in: ${globalAssetsDir}`));
  } catch (err) {
    console.error(chalk.red("Error unpacking database:"), err.message);
    if (verbose) console.error(err.stack);
  } finally {
    await db.destroy();
    db = null;
  }
}

// Extract config from database
async function extractConfig(db, outputDir, verbose) {
  console.log(chalk.blue("\nExtracting configuration..."));

  // Check if table exists
  const hasTable = await db.schema.hasTable("config");
  if (!hasTable) {
    console.log(chalk.yellow("No config table found in database."));
    return;
  }

  const configs = await db("config");

  if (configs.length === 0) {
    console.log(chalk.yellow("No configuration values found."));
    return;
  }

  for (const config of configs) {
    const configPath = path.join(outputDir, `${config.key}.json`);

    // Try to parse as JSON, otherwise store as string
    let configValue;
    try {
      configValue = JSON.parse(config.value);
    } catch (e) {
      configValue = config.value;
    }

    fs.writeFileSync(
      configPath,
      JSON.stringify({ key: config.key, value: configValue }, null, 2)
    );

    if (verbose) {
      console.log(chalk.green(`  - Extracted config: ${config.key}`));
    }
  }

  console.log(chalk.green(`Extracted ${configs.length} configuration items`));
}

// Extract users from database
async function extractUsers(db, outputDir, verbose) {
  console.log(chalk.blue("\nExtracting users..."));

  // Check if table exists
  const hasTable = await db.schema.hasTable("users");
  if (!hasTable) {
    console.log(chalk.yellow("No users table found in database."));
    return;
  }

  const users = await db("users");

  if (users.length === 0) {
    console.log(chalk.yellow("No users found."));
    return;
  }

  for (const user of users) {
    const userPath = path.join(outputDir, `${user.id}.json`);
    fs.writeFileSync(userPath, JSON.stringify(user, null, 2));

    if (verbose) {
      console.log(
        chalk.green(
          `  - Extracted user: ${user.name || "unnamed"} (${user.id})`
        )
      );
    }
  }

  console.log(chalk.green(`Extracted ${users.length} users`));
}

// Extract blueprints from database
async function extractBlueprints(
  db,
  outputDir,
  sourceAssetsDir,
  globalAssetsDir,
  verbose
) {
  console.log(chalk.blue("\nExtracting blueprints..."));

  // Check if table exists
  const hasTable = await db.schema.hasTable("blueprints");
  if (!hasTable) {
    console.log(chalk.yellow("No blueprints table found in database."));
    return [];
  }

  const blueprints = await db("blueprints");

  if (blueprints.length === 0) {
    console.log(chalk.yellow("No blueprints found."));
    return [];
  }

  // Array to store all assets information
  const assets = [];

  for (const blueprint of blueprints) {
    // Parse the data JSON
    let data;
    try {
      data = JSON.parse(blueprint.data);
    } catch (e) {
      console.error(
        chalk.red(
          `  - Error parsing blueprint data for ${blueprint.id}: ${e.message}`
        )
      );
      continue;
    }

    // Create a full blueprint object
    const fullBlueprint = {
      id: blueprint.id,
      createdAt: blueprint.createdAt,
      updatedAt: blueprint.updatedAt,
      ...data,
    };

    // Extract assets from the blueprint
    // Handle model asset
    if (fullBlueprint.model?.startsWith("asset://")) {
      const assetFile = fullBlueprint.model.replace("asset://", "");
      const sourcePath = path.join(sourceAssetsDir, assetFile);

      // Store asset in global assets folder
      const assetInfo = storeAsset(sourcePath, globalAssetsDir, verbose);
      if (assetInfo) {
        assets.push({
          ...assetInfo,
          usedIn: {
            type: "blueprint",
            id: blueprint.id,
            field: "model",
          },
        });

        // Update blueprint reference to use the new asset path
        fullBlueprint.model = `asset://${assetInfo.filename}`;
      }
    }

    // Handle script asset
    if (fullBlueprint.script?.startsWith("asset://")) {
      const assetFile = fullBlueprint.script.replace("asset://", "");
      const sourcePath = path.join(sourceAssetsDir, assetFile);

      // Store asset in global assets folder
      const assetInfo = storeAsset(sourcePath, globalAssetsDir, verbose);
      if (assetInfo) {
        assets.push({
          ...assetInfo,
          usedIn: {
            type: "blueprint",
            id: blueprint.id,
            field: "script",
          },
        });

        // Update blueprint reference to use the new asset path
        fullBlueprint.script = `asset://${assetInfo.filename}`;
      }
    }

    // Handle image asset
    if (fullBlueprint.image?.url?.startsWith("asset://")) {
      const assetFile = fullBlueprint.image.url.replace("asset://", "");
      const sourcePath = path.join(sourceAssetsDir, assetFile);

      // Store asset in global assets folder
      const assetInfo = storeAsset(sourcePath, globalAssetsDir, verbose);
      if (assetInfo) {
        assets.push({
          ...assetInfo,
          usedIn: {
            type: "blueprint",
            id: blueprint.id,
            field: "image.url",
          },
        });

        // Update blueprint reference to use the new asset path
        fullBlueprint.image.url = `asset://${assetInfo.filename}`;
      }
    }

    // Handle props assets
    for (const key in fullBlueprint.props || {}) {
      const prop = fullBlueprint.props[key];
      if (prop?.url?.startsWith("asset://")) {
        const assetFile = prop.url.replace("asset://", "");
        const sourcePath = path.join(sourceAssetsDir, assetFile);

        // Store asset in global assets folder
        const assetInfo = storeAsset(sourcePath, globalAssetsDir, verbose);
        if (assetInfo) {
          assets.push({
            ...assetInfo,
            usedIn: {
              type: "blueprint",
              id: blueprint.id,
              field: `props.${key}.url`,
            },
          });

          // Update blueprint reference to use the new asset path
          fullBlueprint.props[key].url = `asset://${assetInfo.filename}`;
        }
      }
    }

    const blueprintPath = path.join(outputDir, `${blueprint.id}.json`);
    fs.writeFileSync(blueprintPath, JSON.stringify(fullBlueprint, null, 2));

    if (verbose) {
      console.log(
        chalk.green(
          `  - Extracted blueprint: ${blueprint.id} (${data.type || "unknown type"})`
        )
      );
    }
  }

  console.log(
    chalk.green(
      `Extracted ${blueprints.length} blueprints with ${assets.length} assets`
    )
  );
  return assets;
}

// Extract entities from database
async function extractEntities(db, outputDir, verbose) {
  console.log(chalk.blue("\nExtracting entities..."));

  // Check if table exists
  const hasTable = await db.schema.hasTable("entities");
  if (!hasTable) {
    console.log(chalk.yellow("No entities table found in database."));
    return;
  }

  const entities = await db("entities");

  if (entities.length === 0) {
    console.log(chalk.yellow("No entities found."));
    return;
  }

  for (const entity of entities) {
    // Parse the data JSON
    let data;
    try {
      data = JSON.parse(entity.data);
    } catch (e) {
      console.error(
        chalk.red(
          `  - Error parsing entity data for ${entity.id}: ${e.message}`
        )
      );
      continue;
    }

    // Create a full entity object
    const fullEntity = {
      id: entity.id,
      createdAt: entity.createdAt,
      updatedAt: entity.updatedAt,
      ...data,
    };

    const entityPath = path.join(outputDir, `${entity.id}.json`);
    fs.writeFileSync(entityPath, JSON.stringify(fullEntity, null, 2));

    if (verbose) {
      console.log(
        chalk.green(
          `  - Extracted entity: ${entity.id} (${data.type || "unknown type"})`
        )
      );
    }
  }

  console.log(chalk.green(`Extracted ${entities.length} entities`));
}

// Pack a directory into a database
async function packDirectory(
  inputDir,
  dbPath,
  globalAssetsDir,
  force,
  verbose
) {
  // Check if input directory exists
  if (!fs.existsSync(inputDir)) {
    console.error(chalk.red(`Error: Directory not found: ${inputDir}`));
    process.exit(1);
  }

  if (!fs.statSync(inputDir).isDirectory()) {
    console.error(chalk.red(`Error: ${inputDir} is not a directory.`));
    process.exit(1);
  }

  // Check if global assets directory exists
  if (!fs.existsSync(globalAssetsDir)) {
    console.error(
      chalk.red(`Error: Global assets directory not found: ${globalAssetsDir}`)
    );
    process.exit(1);
  }

  // Check if database exists and handle overwrite
  const dbExists = fs.existsSync(dbPath);
  if (dbExists && !force) {
    console.error(chalk.red(`Error: Database file already exists: ${dbPath}`));
    console.error(chalk.yellow("Use --force to overwrite existing database."));
    process.exit(1);
  }

  // If forcing overwrite, delete existing database
  if (dbExists && force) {
    if (verbose) {
      console.log(chalk.yellow(`Removing existing database: ${dbPath}`));
    }
    fs.unlinkSync(dbPath);
  }

  // Create db directory if it doesn't exist
  const dbDir = path.dirname(dbPath);
  ensureDir(dbDir);

  // Create assets directory inside the db directory
  const dbAssetsDir = path.join(dbDir, "assets");
  ensureDir(dbAssetsDir);

  // Check subdirectories
  const configDir = path.join(inputDir, "config");
  const usersDir = path.join(inputDir, "users");
  const blueprintsDir = path.join(inputDir, "blueprints");
  const entitiesDir = path.join(inputDir, "entities");
  const metadataPath = path.join(inputDir, "world-metadata.json");

  // Read metadata to get assets info
  let assets = [];
  if (fs.existsSync(metadataPath)) {
    try {
      const metadata = JSON.parse(fs.readFileSync(metadataPath, "utf8"));
      assets = metadata.assets || [];
    } catch (err) {
      console.error(chalk.red(`Error reading metadata file: ${err.message}`));
    }
  }

  // Create the database connection
  db = await getDB(dbPath);
  try {
    console.log(
      chalk.blue(`Packing directory: ${inputDir} into database: ${dbPath}`)
    );

    // Create database schema
    await createDatabaseSchema(db, verbose);

    // Import configuration
    if (fs.existsSync(configDir)) {
      await importConfig(db, configDir, verbose);
    } else {
      console.log(chalk.yellow("No configuration directory found, skipping."));
    }

    // Import users
    if (fs.existsSync(usersDir)) {
      await importUsers(db, usersDir, verbose);
    } else {
      console.log(chalk.yellow("No users directory found, skipping."));
    }

    // Copy required assets from global assets folder to db assets folder
    console.log(chalk.blue("\nCopying assets..."));
    const copiedAssets = new Set();

    for (const asset of assets) {
      const sourcePath = path.join(globalAssetsDir, asset.filename);
      const destPath = path.join(dbAssetsDir, asset.originalName);

      if (fs.existsSync(sourcePath) && !copiedAssets.has(asset.originalName)) {
        fs.copyFileSync(sourcePath, destPath);
        copiedAssets.add(asset.originalName);

        if (verbose) {
          console.log(
            chalk.green(
              `  - Copied asset: ${asset.filename} → ${asset.originalName}`
            )
          );
        }
      }
    }

    console.log(chalk.green(`Copied ${copiedAssets.size} assets`));

    // Import blueprints (using original asset names)
    if (fs.existsSync(blueprintsDir)) {
      await importBlueprints(db, blueprintsDir, assets, verbose);
    } else {
      console.log(chalk.yellow("No blueprints directory found, skipping."));
    }

    // Import entities
    if (fs.existsSync(entitiesDir)) {
      await importEntities(db, entitiesDir, verbose);
    } else {
      console.log(chalk.yellow("No entities directory found, skipping."));
    }

    console.log(
      chalk.green(`\nDirectory successfully packed into database: ${dbPath}`)
    );
  } catch (err) {
    console.error(chalk.red("Error packing directory:"), err.message);
    if (verbose) console.error(err.stack);
  } finally {
    await db.destroy();
    db = null;
  }
}

// Create database schema
async function createDatabaseSchema(db, verbose) {
  console.log(chalk.blue("\nCreating database schema..."));

  // Create config table
  if (verbose) console.log(chalk.dim("  - Creating config table"));
  await db.schema.createTable("config", (table) => {
    table.string("key").primary();
    table.text("value");
  });

  // Create users table
  if (verbose) console.log(chalk.dim("  - Creating users table"));
  await db.schema.createTable("users", (table) => {
    table.string("id").primary();
    table.string("name");
    table.string("roles");
    table.text("avatar");
    table.datetime("createdAt");
    table.datetime("updatedAt");
  });

  // Create blueprints table
  if (verbose) console.log(chalk.dim("  - Creating blueprints table"));
  await db.schema.createTable("blueprints", (table) => {
    table.string("id").primary();
    table.text("data");
    table.datetime("createdAt");
    table.datetime("updatedAt");
  });

  // Create entities table
  if (verbose) console.log(chalk.dim("  - Creating entities table"));
  await db.schema.createTable("entities", (table) => {
    table.string("id").primary();
    table.text("data");
    table.datetime("createdAt");
    table.datetime("updatedAt");
  });

  console.log(chalk.green("Database schema created successfully"));
}

// Import configuration
async function importConfig(db, inputDir, verbose) {
  console.log(chalk.blue("\nImporting configuration..."));

  // Get all JSON files in the config directory
  const files = fs
    .readdirSync(inputDir)
    .filter((file) => file.endsWith(".json"));

  if (files.length === 0) {
    console.log(chalk.yellow("No configuration files found."));
    return;
  }

  for (const file of files) {
    const filePath = path.join(inputDir, file);
    const configJson = JSON.parse(fs.readFileSync(filePath, "utf8"));

    // Extract key and value
    const key = configJson.key;

    // Convert value back to string if it's an object
    let value = configJson.value;
    if (typeof value === "object") {
      value = JSON.stringify(value);
    }

    await db("config").insert({
      key: key,
      value: value,
    });

    if (verbose) {
      console.log(chalk.green(`  - Imported config: ${key}`));
    }
  }

  console.log(chalk.green(`Imported ${files.length} configuration items`));
}

// Import users
async function importUsers(db, inputDir, verbose) {
  console.log(chalk.blue("\nImporting users..."));

  // Get all JSON files in the users directory
  const files = fs
    .readdirSync(inputDir)
    .filter((file) => file.endsWith(".json"));

  if (files.length === 0) {
    console.log(chalk.yellow("No user files found."));
    return;
  }

  for (const file of files) {
    const filePath = path.join(inputDir, file);
    const user = JSON.parse(fs.readFileSync(filePath, "utf8"));

    await db("users").insert({
      id: user.id,
      name: user.name,
      roles: user.roles,
      avatar: user.avatar,
      createdAt: user.createdAt,
      updatedAt: user.updatedAt,
    });

    if (verbose) {
      console.log(
        chalk.green(`  - Imported user: ${user.name || "unnamed"} (${user.id})`)
      );
    }
  }

  console.log(chalk.green(`Imported ${files.length} users`));
}

// Import blueprints
async function importBlueprints(db, inputDir, assets, verbose) {
  console.log(chalk.blue("\nImporting blueprints..."));

  // Get all JSON files in the blueprints directory
  const files = fs
    .readdirSync(inputDir)
    .filter((file) => file.endsWith(".json"));

  if (files.length === 0) {
    console.log(chalk.yellow("No blueprint files found."));
    return;
  }

  // Create a map for quick asset lookups
  const assetMap = {};
  for (const asset of assets) {
    assetMap[asset.filename] = asset.originalName;
  }

  for (const file of files) {
    const filePath = path.join(inputDir, file);
    const fullBlueprint = JSON.parse(fs.readFileSync(filePath, "utf8"));

    // Extract metadata fields
    const { id, createdAt, updatedAt } = fullBlueprint;

    // Create a copy for rewriting asset references back to original filenames
    const blueprintCopy = { ...fullBlueprint };
    delete blueprintCopy.createdAt;
    delete blueprintCopy.updatedAt;

    // Rewrite asset references
    if (blueprintCopy.model?.startsWith("asset://")) {
      const hashedFile = blueprintCopy.model.replace("asset://", "");
      if (assetMap[hashedFile]) {
        blueprintCopy.model = `asset://${assetMap[hashedFile]}`;
      }
    }

    if (blueprintCopy.script?.startsWith("asset://")) {
      const hashedFile = blueprintCopy.script.replace("asset://", "");
      if (assetMap[hashedFile]) {
        blueprintCopy.script = `asset://${assetMap[hashedFile]}`;
      }
    }

    if (blueprintCopy.image?.url?.startsWith("asset://")) {
      const hashedFile = blueprintCopy.image.url.replace("asset://", "");
      if (assetMap[hashedFile]) {
        blueprintCopy.image.url = `asset://${assetMap[hashedFile]}`;
      }
    }

    // Handle props assets
    for (const key in blueprintCopy.props || {}) {
      const prop = blueprintCopy.props[key];
      if (prop?.url?.startsWith("asset://")) {
        const hashedFile = prop.url.replace("asset://", "");
        if (assetMap[hashedFile]) {
          blueprintCopy.props[key].url = `asset://${assetMap[hashedFile]}`;
        }
      }
    }

    // Insert blueprint
    await db("blueprints").insert({
      id: id,
      data: JSON.stringify(blueprintCopy),
      createdAt: createdAt,
      updatedAt: updatedAt,
    });

    if (verbose) {
      console.log(
        chalk.green(
          `  - Imported blueprint: ${id} (${blueprintCopy.type || "unknown type"})`
        )
      );
    }
  }

  console.log(chalk.green(`Imported ${files.length} blueprints`));
}

// Import entities
async function importEntities(db, inputDir, verbose) {
  console.log(chalk.blue("\nImporting entities..."));

  // Get all JSON files in the entities directory
  const files = fs
    .readdirSync(inputDir)
    .filter((file) => file.endsWith(".json"));

  if (files.length === 0) {
    console.log(chalk.yellow("No entity files found."));
    return;
  }

  for (const file of files) {
    const filePath = path.join(inputDir, file);
    const fullEntity = JSON.parse(fs.readFileSync(filePath, "utf8"));

    // Extract metadata fields
    const { id, createdAt, updatedAt } = fullEntity;

    // Remove metadata fields from the data payload
    const entityCopy = { ...fullEntity };
    delete entityCopy.createdAt;
    delete entityCopy.updatedAt;

    // Insert entity
    await db("entities").insert({
      id: id,
      data: JSON.stringify(entityCopy),
      createdAt: createdAt,
      updatedAt: updatedAt,
    });

    if (verbose) {
      console.log(
        chalk.green(
          `  - Imported entity: ${id} (${entityCopy.type || "unknown type"})`
        )
      );
    }
  }

  console.log(chalk.green(`Imported ${files.length} entities`));
}

// Display information about a world directory
async function displayWorldInfo(directory) {
  try {
    // Check if directory exists
    if (!fs.existsSync(directory)) {
      console.error(chalk.red(`Error: Directory not found: ${directory}`));
      process.exit(1);
    }

    if (!fs.statSync(directory).isDirectory()) {
      console.error(chalk.red(`Error: ${directory} is not a directory.`));
      process.exit(1);
    }

    // Check subdirectories
    const configDir = path.join(directory, "config");
    const usersDir = path.join(directory, "users");
    const blueprintsDir = path.join(directory, "blueprints");
    const entitiesDir = path.join(directory, "entities");
    const metadataPath = path.join(directory, "world-metadata.json");

    console.log(chalk.blue(`\nWorld Directory: ${directory}`));

    // Display metadata if available
    if (fs.existsSync(metadataPath)) {
      const metadata = JSON.parse(fs.readFileSync(metadataPath, "utf8"));
      console.log(chalk.bold("\nMetadata:"));
      console.log(`  Exported At: ${chalk.green(metadata.exportedAt)}`);
      console.log(`  Source: ${chalk.green(metadata.source)}`);

      // Display assets info
      if (metadata.assets && metadata.assets.length > 0) {
        console.log(chalk.bold("\nAssets:"));
        console.log(`  Total assets: ${chalk.green(metadata.assets.length)}`);

        // Count assets by extension
        const assetsByType = {};
        for (const asset of metadata.assets) {
          const ext = asset.extension || "unknown";
          assetsByType[ext] = (assetsByType[ext] || 0) + 1;
        }

        for (const ext in assetsByType) {
          console.log(`  - ${ext}: ${chalk.green(assetsByType[ext])}`);
        }
      }
    }

    // Display configuration count
    if (fs.existsSync(configDir)) {
      const configFiles = fs
        .readdirSync(configDir)
        .filter((file) => file.endsWith(".json"));
      console.log(chalk.bold("\nConfiguration items:"), configFiles.length);

      // Display important config values if available
      for (const file of configFiles) {
        if (file === "version.json" || file === "spawn.json") {
          const configData = JSON.parse(
            fs.readFileSync(path.join(configDir, file), "utf8")
          );
          console.log(
            `  - ${configData.key}: ${chalk.green(JSON.stringify(configData.value))}`
          );
        }
      }
    } else {
      console.log(chalk.yellow("\nNo configuration directory found."));
    }

    // Display users count
    if (fs.existsSync(usersDir)) {
      const userFiles = fs
        .readdirSync(usersDir)
        .filter((file) => file.endsWith(".json"));
      console.log(chalk.bold("\nUsers:"), userFiles.length);

      // Show a sample of users if available
      if (userFiles.length > 0) {
        const sampleSize = Math.min(5, userFiles.length);
        const sampleUsers = [];

        for (let i = 0; i < sampleSize; i++) {
          const userData = JSON.parse(
            fs.readFileSync(path.join(usersDir, userFiles[i]), "utf8")
          );
          sampleUsers.push([
            userData.id.slice(0, 8),
            userData.name || "unnamed",
            userData.roles || "",
          ]);
        }

        if (sampleUsers.length > 0) {
          sampleUsers.unshift(["ID", "Name", "Roles"]);
          console.log(table(sampleUsers));
        }
      }
    } else {
      console.log(chalk.yellow("\nNo users directory found."));
    }

    // Display blueprints count
    if (fs.existsSync(blueprintsDir)) {
      const blueprintFiles = fs
        .readdirSync(blueprintsDir)
        .filter((file) => file.endsWith(".json"));
      console.log(chalk.bold("\nBlueprints:"), blueprintFiles.length);

      // Count by type
      const types = {};
      for (const file of blueprintFiles) {
        const blueprint = JSON.parse(
          fs.readFileSync(path.join(blueprintsDir, file), "utf8")
        );
        const type = blueprint.type || "unknown";
        types[type] = (types[type] || 0) + 1;
      }

      for (const type in types) {
        console.log(`  - ${type}: ${chalk.green(types[type])}`);
      }
    } else {
      console.log(chalk.yellow("\nNo blueprints directory found."));
    }

    // Display entities count
    if (fs.existsSync(entitiesDir)) {
      const entityFiles = fs
        .readdirSync(entitiesDir)
        .filter((file) => file.endsWith(".json"));
      console.log(chalk.bold("\nEntities:"), entityFiles.length);

      // Count by type
      const types = {};
      for (const file of entityFiles) {
        const entity = JSON.parse(
          fs.readFileSync(path.join(entitiesDir, file), "utf8")
        );
        const type = entity.type || "unknown";
        types[type] = (types[type] || 0) + 1;
      }

      for (const type in types) {
        console.log(`  - ${type}: ${chalk.green(types[type])}`);
      }
    } else {
      console.log(chalk.yellow("\nNo entities directory found."));
    }
  } catch (err) {
    console.error(chalk.red("\nError reading world directory:"), err.message);
    process.exit(1);
  }
}

// Show database status
async function showDbStatus(dbPath) {
  // Check if database exists
  if (!fs.existsSync(dbPath)) {
    console.error(chalk.red(`Error: Database file not found: ${dbPath}`));
    process.exit(1);
  }

  // Create database connection
  db = await getDB(dbPath);
  try {
    console.log(chalk.blue("\nDatabase Status:"));
    console.log(`  Path: ${chalk.green(dbPath)}`);
    console.log(`  Size: ${chalk.green(fs.statSync(dbPath).size / 1024)} KB`);

    // Try to get version from config
    try {
      const versionRow = await db("config").where("key", "version").first();
      if (versionRow) {
        console.log(`  Version: ${chalk.green(versionRow.value)}`);
      }
    } catch (e) {
      // Version not found, ignore
    }

    // List tables and counts
    const tables = await db.raw(
      "SELECT name FROM sqlite_master WHERE type='table'"
    );
    console.log(chalk.blue("\nTables:"));

    for (const tableInfo of tables) {
      const tableName = tableInfo.name;
      const count = await db(tableName).count("* as count").first();
      console.log(`  - ${chalk.green(tableName)}: ${count.count} rows`);
    }

    // Show some statistics if available
    console.log(chalk.blue("\nStatistics:"));

    // Blueprints by type
    try {
      if (await db.schema.hasTable("blueprints")) {
        const blueprints = await db("blueprints");

        if (blueprints.length > 0) {
          const typeCount = {};

          for (const blueprint of blueprints) {
            try {
              const data = JSON.parse(blueprint.data);
              const type = data.type || "unknown";
              typeCount[type] = (typeCount[type] || 0) + 1;
            } catch (e) {
              // Skip invalid JSON
            }
          }

          console.log(chalk.bold("  Blueprint Types:"));
          for (const type in typeCount) {
            console.log(`    - ${type}: ${chalk.green(typeCount[type])}`);
          }
        }
      }
    } catch (e) {
      // Ignore errors in statistics collection
    }

    // Entities by type
    try {
      if (await db.schema.hasTable("entities")) {
        const entities = await db("entities");

        if (entities.length > 0) {
          const typeCount = {};

          for (const entity of entities) {
            try {
              const data = JSON.parse(entity.data);
              const type = data.type || "unknown";
              typeCount[type] = (typeCount[type] || 0) + 1;
            } catch (e) {
              // Skip invalid JSON
            }
          }

          console.log(chalk.bold("  Entity Types:"));
          for (const type in typeCount) {
            console.log(`    - ${type}: ${chalk.green(typeCount[type])}`);
          }
        }
      }
    } catch (e) {
      // Ignore errors in statistics collection
    }
  } catch (err) {
    console.error(chalk.red("Error:"), err.message);
  } finally {
    await db.destroy();
    db = null;
  }
}

// Parse arguments and execute
program.parse(process.argv);

// Default behavior if no command specified
if (!process.argv.slice(2).length) {
  program.help();
}
