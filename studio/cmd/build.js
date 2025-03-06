#!/usr/bin/env bun
import { $ } from "bun";

import { parseArgs } from "util";

function init() {
  const { values, positionals } = parseArgs({
    args: Bun.argv,
    options: {
      flag1: {
        type: "boolean",
      },
      flag2: {
        type: "string",
      },
    },
    strict: true,
    allowPositionals: true,
  });

  return { args: positionals.slice(2), options: { ...values } };
}
const { args, options } = init();
console.log({ args, options });

await $`bunx rollup -c --input ${args[0]} --file cache/output.js`
