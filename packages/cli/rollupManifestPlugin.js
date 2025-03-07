// rollupManifestPlugin.js
export default function manifestPlugin(options = {}) {
  return {
    name: 'manifest-extractor',
    
    // Transform hook runs for each module
    transform(code, id) {
      // Only process JavaScript files
      if (!id.endsWith('.js') && !id.endsWith('.jsx') && !id.endsWith('.ts') && !id.endsWith('.tsx')) {
        return null;
      }
      
      // Check if the file contains a manifest declaration
      const manifestStart = code.indexOf('const manifest = {');
      if (manifestStart === -1) {
        return null;
      }
      
      try {
        // Use brace counting to find the end of the manifest object
        let braceCount = 0;
        let manifestEnd = manifestStart;
        
        // Start counting from where the object begins (after the "const manifest = " part)
        let objectStart = code.indexOf('{', manifestStart);
        
        for (let i = objectStart; i < code.length; i++) {
          if (code[i] === '{') braceCount++;
          if (code[i] === '}') braceCount--;
          
          if (braceCount === 0) {
            manifestEnd = i + 1; // Include the closing brace
            break;
          }
        }
        
        // Extract the complete manifest block
        const manifestBlock = code.substring(manifestStart, manifestEnd);
        
        // Extract just the object literal part
        const objectLiteral = code.substring(objectStart, manifestEnd);
        
        // Safely evaluate the object literal to get the manifest object
        // Note: In a production environment, use a proper parser like acorn
        const manifestObj = Function(`return ${objectLiteral}`)();
        
        // Emit the manifest as blueprint.json
        this.emitFile({
          type: 'asset',
          fileName: 'blueprint.json',
          source: JSON.stringify(manifestObj, null, 2)
        });
        
        // Remove the manifest declaration from the code
        const modifiedCode = code.substring(0, manifestStart) + 
                            '// manifest extracted for blueprint.json\n' + 
                            code.substring(manifestEnd);
        
        return {
          code: modifiedCode,
          map: { mappings: '' }
        };
      } catch (err) {
        this.error(`Failed to extract manifest: ${err.message}\nIn file: ${id}`);
        return null;
      }
    }
  };
}