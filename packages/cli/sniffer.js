import fs from 'fs/promises';
import CDP from 'chrome-remote-interface';

async function dumpWorld() {
  let client;

  try {
    // Connect to the debugging port
    client = await CDP({
      port: 9229 // Default Node.js debug port
    });

    const { Runtime } = client;

    // Enable runtime
    await Runtime.enable();

    // For large objects, we need a different approach
    // First, we'll create a function to selectively extract data from the world
    const result = await Runtime.evaluate({
      expression: `
        (function() {
          try {
            // Create a simplified version of the world
            // Adjust this according to your world structure
            const simplifiedWorld = {};
            
            // Example: Extract basic properties
            if (typeof world === 'object' && world !== null) {
              // Add properties you're interested in
              // Example for a game world:
              if (world.entities) {
                simplifiedWorld.entities = Object.keys(world.entities).length;
                
                // Get a sample of entities (first 10)
                simplifiedWorld.entitySamples = Object.entries(world.entities)
                  .slice(0, 10)
                  .map(([id, entity]) => ({
                    id,
                    type: entity.type || 'unknown',
                    position: entity.position ? {...entity.position} : null
                  }));
              }
              
              if (world.settings) {
                simplifiedWorld.settings = {...world.settings};
              }
              
              if (world.state) {
                simplifiedWorld.state = {...world.state};
              }
              
              // Add more properties as needed
            }
            
            return JSON.stringify(simplifiedWorld);
          } catch (error) {
            return JSON.stringify({ error: error.message });
          }
        })()
      `,
      returnByValue: true
    });

    if (result.result && result.result.value) {
      // Write to file
      await fs.writeFile(
        './world-dump.json',
        JSON.stringify(result.result.value, null, 2)
      );
      console.log('World data successfully dumped to world-dump.json');
    } else {
      console.error('Failed to retrieve world data. Is "world" a global variable?');
    }
  } catch (error) {
    console.error('Error:', error);
  } finally {
    // Disconnect
    if (client) {
      await client.close();
    }
  }
}

dumpWorld();
