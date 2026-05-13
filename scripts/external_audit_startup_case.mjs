import { checkCustodyStartup, readCustodyConfig } from "../custody/runtime.ts";

const configPath = process.env.MNDE_TEST_CONFIG_PATH;
const packageRoot = process.env.MNDE_TEST_PACKAGE_ROOT;

if (!configPath || !packageRoot) {
  process.stderr.write("MNDE_TEST_CONFIG_PATH and MNDE_TEST_PACKAGE_ROOT are required\n");
  process.exit(2);
}

const result = checkCustodyStartup(packageRoot, readCustodyConfig(configPath), { configPath });
process.stdout.write(`${JSON.stringify(result)}\n`);
process.exit(result.ok ? 0 : 1);
