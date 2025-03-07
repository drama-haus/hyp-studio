#!/usr/bin/env node
import { Command } from "commander";
import Knex from "knex";
import moment from "moment";
import chalk from "chalk";
import { table } from "table";
import fs from "fs";
import path from "path";

let db;
async function getDB(path) {
  if (!db) {
    db = Knex({
      client: "better-sqlite3",
      connection: {
        filename: path,
      },
      useNullAsDefault: true,
    });
  }
  return db;
}

const uuid = crypto.randomUUID;
const program = new Command();

program
  .name("db-cli")
  .description("Database management CLI tool")
  .version("1.0.0")
  .option("-p, --path <path>", "Database file path", "./database.sqlite");

// ============ Database Commands ============

program
  .command("status")
  .description("Show database status")
  .action(async (options) => {
    const opts = { ...program.opts(), ...options };
    const db = await getDB(opts.path);
    try {
      // Check version
      const versionRow = await db("config").where("key", "version").first();
      console.log(chalk.blue("Database Status:"));
      console.log(`  Path: ${chalk.green(opts.path)}`);
      console.log(`  Migration Version: ${chalk.green(versionRow.value)}`);

      // List tables
      const tables = await db.raw(
        "SELECT name FROM sqlite_master WHERE type='table'"
      );
      console.log(chalk.blue("\nTables:"));
      tables.forEach((t) => {
        console.log(`  - ${chalk.green(t.name)}`);
      });
    } catch (err) {
      console.error(chalk.red("Error:"), err.message);
    } finally {
      await db.destroy();
    }
  });

// ============ User Commands ============

program
  .command("users")
  .description("List all users")
  .action(async (options) => {
    const opts = { ...program.opts(), ...options };
    const db = await getDB(opts.path);
    try {
      const users = await db("users");

      if (users.length === 0) {
        console.log(chalk.yellow("No users found."));
        return;
      }

      const data = users.map((user) => [
        user.id.slice(0, 8),
        user.name,
        user.roles,
        moment(user.createdAt).format("YYYY-MM-DD HH:mm"),
        user.avatar ? "Yes" : "No",
      ]);

      data.unshift(["ID", "Name", "Roles", "Created At", "Avatar"]);

      console.log(chalk.blue("Users:"));
      console.log(table(data));
    } catch (err) {
      console.error(chalk.red("Error:"), err.message);
    } finally {
      await db.destroy();
    }
  });

program
  .command("user-update")
  .description("Update a user")
  .requiredOption("-i, --id <id>", "User ID")
  .option("-n, --name <name>", "New name")
  .option("-r, --roles <roles>", "Comma-separated list of roles")
  .option("-a, --avatar <path>", "Path to avatar file")
  .action(async (options) => {
    const opts = { ...program.opts(), ...options };
    const db = await getDB(opts.path);
    try {
      const user = await db("users").where("id", options.id).first();

      if (!user) {
        console.error(chalk.red("Error: User not found"));
        return;
      }

      const updates = {};
      if (options.name) updates.name = options.name;
      if (options.roles) updates.roles = options.roles;
      if (options.avatar) updates.avatar = options.avatar;

      if (Object.keys(updates).length === 0) {
        console.log(chalk.yellow("No updates provided."));
        return;
      }

      await db("users").where("id", options.id).update(updates);
      console.log(chalk.green("User updated successfully."));
    } catch (err) {
      console.error(chalk.red("Error:"), err.message);
    } finally {
      await db.destroy();
    }
  });

// ============ Blueprint Commands ============

program
  .command("blueprints")
  .description("List all blueprints")
  .action(async (options) => {
    const opts = { ...program.opts(), ...options };
    const db = await getDB(opts.path);
    try {
      const blueprints = await db("blueprints");

      if (blueprints.length === 0) {
        console.log(chalk.yellow("No blueprints found."));
        return;
      }

      const data = blueprints.map((blueprint) => {
        const parsed = JSON.parse(blueprint.data);
        return [
          blueprint.id.slice(0, 8),
          parsed.type || "unknown",
          parsed.version || "0",
          moment(blueprint.updatedAt).format("YYYY-MM-DD HH:mm"),
        ];
      });

      data.unshift(["ID", "Type", "Version", "Updated At"]);

      console.log(chalk.blue("Blueprints:"));
      console.log(table(data));
    } catch (err) {
      console.error(chalk.red("Error:"), err.message);
    } finally {
      await db.destroy();
    }
  });

program
  .command("blueprint-get")
  .description("Get a blueprint by ID")
  .requiredOption("-i, --id <id>", "Blueprint ID")
  .action(async (options) => {
    const opts = { ...program.opts(), ...options };
    const db = await getDB(opts.path);
    try {
      const blueprint = await db("blueprints").where("id", options.id).first();

      if (!blueprint) {
        console.error(chalk.red("Error: Blueprint not found"));
        return;
      }

      const parsed = JSON.parse(blueprint.data);
      console.log(chalk.blue(`Blueprint ${options.id}:`));
      console.log(JSON.stringify(parsed, null, 2));
    } catch (err) {
      console.error(chalk.red("Error:"), err.message);
    } finally {
      await db.destroy();
    }
  });

program
  .command("blueprint-add")
  .description("Add a new blueprint")
  .requiredOption("-f, --file <path>", "JSON file path for blueprint data")
  .option("-i, --id <id>", "Custom ID (generates UUID if not provided)")
  .action(async (options) => {
    const opts = { ...program.opts(), ...options };
    const db = await getDB(opts.path);
    try {
      // Read blueprint data from file
      const fileContent = fs.readFileSync(options.file, "utf8");
      let blueprint = JSON.parse(fileContent);

      // Set ID if not present
      if (!blueprint.id) {
        blueprint.id = options.id || uuid();
      }

      // Set default values if not present
      if (blueprint.version === undefined) blueprint.version = 0;
      if (blueprint.props === undefined) blueprint.props = {};
      if (blueprint.preload === undefined) blueprint.preload = false;
      if (blueprint.public === undefined) blueprint.public = false;
      if (blueprint.locked === undefined) blueprint.locked = false;
      if (blueprint.unique === undefined) blueprint.unique = false;

      const now = moment().toISOString();
      const record = {
        id: blueprint.id,
        data: JSON.stringify(blueprint),
        createdAt: now,
        updatedAt: now,
      };

      await db("blueprints").insert(record);
      console.log(chalk.green("Blueprint added successfully:"));
      console.log(`  ID: ${chalk.blue(blueprint.id)}`);
    } catch (err) {
      console.error(chalk.red("Error:"), err.message);
    } finally {
      await db.destroy();
    }
  });

program
  .command("blueprint-update")
  .description("Update a blueprint")
  .requiredOption("-i, --id <id>", "Blueprint ID")
  .requiredOption(
    "-f, --file <path>",
    "JSON file path for updated blueprint data"
  )
  .action(async (options) => {
    const opts = { ...program.opts(), ...options };
    const db = await getDB(opts.path);
    try {
      // Check if blueprint exists
      const existing = await db("blueprints").where("id", options.id).first();
      if (!existing) {
        console.error(chalk.red("Error: Blueprint not found"));
        return;
      }

      // Read updated data
      const fileContent = fs.readFileSync(options.file, "utf8");
      let updatedData = JSON.parse(fileContent);

      // Ensure ID matches
      updatedData.id = options.id;

      // Increment version
      const existingData = JSON.parse(existing.data);
      if (updatedData.version === undefined) {
        updatedData.version = (existingData.version || 0) + 1;
      }

      const now = moment().toISOString();
      const record = {
        data: JSON.stringify(updatedData),
        updatedAt: now,
      };

      await db("blueprints").where("id", options.id).update(record);
      console.log(chalk.green("Blueprint updated successfully:"));
      console.log(`  ID: ${chalk.blue(options.id)}`);
      console.log(`  New Version: ${chalk.blue(updatedData.version)}`);
    } catch (err) {
      console.error(chalk.red("Error:"), err.message);
    } finally {
      await db.destroy();
    }
  });

program
  .command("blueprint-delete")
  .description("Delete a blueprint")
  .requiredOption("-i, --id <id>", "Blueprint ID")
  .action(async (options) => {
    const opts = { ...program.opts(), ...options };
    const db = await getDB(opts.path);
    try {
      const result = await db("blueprints").where("id", options.id).delete();

      if (result === 0) {
        console.log(chalk.yellow("No blueprint found with that ID."));
        return;
      }

      console.log(chalk.green("Blueprint deleted successfully."));
    } catch (err) {
      console.error(chalk.red("Error:"), err.message);
    } finally {
      await db.destroy();
    }
  });

// ============ Entity Commands ============

program
  .command("entities")
  .description("List all entities")
  .action(async (options) => {
    const opts = { ...program.opts(), ...options };
    const db = await getDB(opts.path);
    try {
      const entities = await db("entities");

      if (entities.length === 0) {
        console.log(chalk.yellow("No entities found."));
        return;
      }

      const data = entities.map((entity) => {
        const parsed = JSON.parse(entity.data);
        return [
          entity.id.slice(0, 8),
          parsed.type || "unknown",
          moment(entity.updatedAt).format("YYYY-MM-DD HH:mm"),
        ];
      });

      data.unshift(["ID", "Type", "Updated At"]);

      console.log(chalk.blue("Entities:"));
      console.log(table(data));
    } catch (err) {
      console.error(chalk.red("Error:"), err.message);
    } finally {
      await db.destroy();
    }
  });

program
  .command("entity-get")
  .description("Get an entity by ID")
  .requiredOption("-i, --id <id>", "Entity ID")
  .action(async (options) => {
    const opts = { ...program.opts(), ...options };
    const db = await getDB(opts.path);
    try {
      const entity = await db("entities").where("id", options.id).first();

      if (!entity) {
        console.error(chalk.red("Error: Entity not found"));
        return;
      }

      const parsed = JSON.parse(entity.data);
      console.log(chalk.blue(`Entity ${options.id}:`));
      console.log(JSON.stringify(parsed, null, 2));
    } catch (err) {
      console.error(chalk.red("Error:"), err.message);
    } finally {
      await db.destroy();
    }
  });

program
  .command("entity-add")
  .description("Add a new entity")
  .requiredOption("-f, --file <path>", "JSON file path for entity data")
  .option("-i, --id <id>", "Custom ID (generates UUID if not provided)")
  .action(async (options) => {
    const opts = { ...program.opts(), ...options };
    const db = await getDB(opts.path);
    try {
      // Read entity data from file
      const fileContent = fs.readFileSync(options.file, "utf8");
      let entity = JSON.parse(fileContent);

      // Set ID if not present
      if (!entity.id) {
        entity.id = options.id || uuid();
      }

      const now = moment().toISOString();
      const record = {
        id: entity.id,
        data: JSON.stringify(entity),
        createdAt: now,
        updatedAt: now,
      };

      await db("entities").insert(record);
      console.log(chalk.green("Entity added successfully:"));
      console.log(`  ID: ${chalk.blue(entity.id)}`);
    } catch (err) {
      console.error(chalk.red("Error:"), err.message);
    } finally {
      await db.destroy();
    }
  });

program
  .command("entity-update")
  .description("Update an entity")
  .requiredOption("-i, --id <id>", "Entity ID")
  .requiredOption("-f, --file <path>", "JSON file path for updated entity data")
  .action(async (options) => {
    const opts = { ...program.opts(), ...options };
    const db = await getDB(opts.path);
    try {
      // Check if entity exists
      const existing = await db("entities").where("id", options.id).first();
      if (!existing) {
        console.error(chalk.red("Error: Entity not found"));
        return;
      }

      // Read updated data
      const fileContent = fs.readFileSync(options.file, "utf8");
      let updatedData = JSON.parse(fileContent);

      // Ensure ID matches
      updatedData.id = options.id;

      // Set state to null for storage
      if (updatedData.state) {
        updatedData.state = null;
      }

      const now = moment().toISOString();
      const record = {
        data: JSON.stringify(updatedData),
        updatedAt: now,
      };

      await db("entities").where("id", options.id).update(record);
      console.log(chalk.green("Entity updated successfully:"));
      console.log(`  ID: ${chalk.blue(options.id)}`);
    } catch (err) {
      console.error(chalk.red("Error:"), err.message);
    } finally {
      await db.destroy();
    }
  });

program
  .command("entity-delete")
  .description("Delete an entity")
  .requiredOption("-i, --id <id>", "Entity ID")
  .action(async (options) => {
    const opts = { ...program.opts(), ...options };
    const db = await getDB(opts.path);
    try {
      const result = await db("entities").where("id", options.id).delete();

      if (result === 0) {
        console.log(chalk.yellow("No entity found with that ID."));
        return;
      }

      console.log(chalk.green("Entity deleted successfully."));
    } catch (err) {
      console.error(chalk.red("Error:"), err.message);
    } finally {
      await db.destroy();
    }
  });

// ============ Config Commands ============

program
  .command("config-list")
  .description("List all configuration values")
  .action(async (options) => {
    const opts = { ...program.opts(), ...options };
    const db = await getDB(opts.path);
    try {
      const configs = await db("config");

      if (configs.length === 0) {
        console.log(chalk.yellow("No configuration values found."));
        return;
      }

      const data = configs.map((config) => [config.key, config.value]);
      data.unshift(["Key", "Value"]);

      console.log(chalk.blue("Configuration:"));
      console.log(table(data));
    } catch (err) {
      console.error(chalk.red("Error:"), err.message);
    } finally {
      await db.destroy();
    }
  });

program
  .command("config-get")
  .description("Get a configuration value")
  .requiredOption("-k, --key <key>", "Configuration key")
  .action(async (options) => {
    const opts = { ...program.opts(), ...options };
    const db = await getDB(opts.path);
    try {
      const config = await db("config").where("key", options.key).first();

      if (!config) {
        console.log(
          chalk.yellow(`No configuration found for key: ${options.key}`)
        );
        return;
      }

      console.log(chalk.blue(`Configuration for ${options.key}:`));
      console.log(config.value);

      // Special handling for JSON values
      try {
        const parsed = JSON.parse(config.value);
        console.log(chalk.blue("\nParsed as JSON:"));
        console.log(JSON.stringify(parsed, null, 2));
      } catch (e) {
        // Not JSON, ignore
      }
    } catch (err) {
      console.error(chalk.red("Error:"), err.message);
    } finally {
      await db.destroy();
    }
  });

program
  .command("config-set")
  .description("Set a configuration value")
  .requiredOption("-k, --key <key>", "Configuration key")
  .requiredOption("-v, --value <value>", "Configuration value")
  .action(async (options) => {
    const opts = { ...program.opts(), ...options };
    const db = await getDB(opts.path);
    try {
      await db("config")
        .insert({
          key: options.key,
          value: options.value,
        })
        .onConflict("key")
        .merge({
          value: options.value,
        });

      console.log(
        chalk.green(
          `Configuration set successfully: ${options.key} = ${options.value}`
        )
      );
    } catch (err) {
      console.error(chalk.red("Error:"), err.message);
    } finally {
      await db.destroy();
    }
  });

program
  .command("spawn-set")
  .description("Set spawn point from coordinates")
  .requiredOption("-x <x>", "X coordinate", parseFloat)
  .requiredOption("-y <y>", "Y coordinate", parseFloat)
  .requiredOption("-z <z>", "Z coordinate", parseFloat)
  .option("--qx <qx>", "Quaternion X", parseFloat, 0)
  .option("--qy <qy>", "Quaternion Y", parseFloat, 0)
  .option("--qz <qz>", "Quaternion Z", parseFloat, 0)
  .option("--qw <qw>", "Quaternion W", parseFloat, 1)
  .action(async (options) => {
    const opts = { ...program.opts(), ...options };
    const db = await getDB(opts.path);
    try {
      const spawn = {
        position: [options.x, options.y, options.z],
        quaternion: [options.qx, options.qy, options.qz, options.qw],
      };

      const spawnData = JSON.stringify(spawn);

      await db("config")
        .insert({
          key: "spawn",
          value: spawnData,
        })
        .onConflict("key")
        .merge({
          value: spawnData,
        });

      console.log(chalk.green("Spawn point set successfully:"));
      console.log(`  Position: [${chalk.blue(spawn.position.join(", "))}]`);
      console.log(`  Quaternion: [${chalk.blue(spawn.quaternion.join(", "))}]`);
    } catch (err) {
      console.error(chalk.red("Error:"), err.message);
    } finally {
      await db.destroy();
    }
  });

// Parse arguments and execute
program.parse(process.argv);
