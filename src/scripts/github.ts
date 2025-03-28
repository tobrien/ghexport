import dotenv from 'dotenv';
import fs from 'fs';
import path from 'path';
import { glob } from 'glob';
import yaml from 'yaml';
import { configure } from '../config.js';
import { getLogger } from '../logging.js';

// Load environment variables
dotenv.config();

// Initialize logger
const logger = getLogger();

// Load configuration
const config = Config.createConfig(options);

/**
 * Interface for command line arguments
 */
interface CommandLineArgs {
    type: 'issues' | 'commits';
}

/**
 * Parses command line arguments
 * @param args Command line arguments
 * @returns Parsed command line arguments
 */
function parseCommandLineArgs(args: string[]): CommandLineArgs {
    let type: 'issues' | 'commits' | undefined;

    // Parse arguments
    for (let i = 0; i < args.length; i++) {
        if (args[i] === '--type' && i + 1 < args.length) {
            const typeArg = args[i + 1].toLowerCase();
            if (typeArg !== 'issues' && typeArg !== 'commits') {
                throw new Error('Type must be either "issues" or "commits"');
            }
            type = typeArg as 'issues' | 'commits';
            i++; // Skip the next argument since we consumed it
        }
    }

    if (!type) {
        throw new Error('Usage: --type [issues|commits]');
    }

    return { type };
}

/**
 * Gets GitHub owners from the activity configuration file
 * @returns Array of GitHub owners
 */
function getOwnersFromConfig(): string[] {
    try {
        const configFilePath = path.join(config.configDirectory, 'activity.yaml');
        const configFile = fs.readFileSync(configFilePath, 'utf8');
        const parsedConfig = yaml.parse(configFile);

        if (!parsedConfig?.github?.commits) {
            throw new Error('Invalid config structure: github.commits not found');
        }

        return Object.keys(parsedConfig.github.commits);
    } catch (error: any) {
        logger.error(`Error reading config file: ${error.message}`);
        throw error;
    }
}

/**
 * Runs a module with the given arguments
 * @param modulePath Path to the module
 * @param owner Owner name
 * @param year Year
 * @param month Month
 * @returns Promise that resolves when the module has completed
 */
async function runActivityModule(modulePath: string, owner: string, year: string, month: string): Promise<void> {
    try {
        // Save original command line arguments
        const originalArgs = process.argv;

        // Create new command line arguments for the module
        process.argv = [
            process.argv[0],                     // node executable
            modulePath,                          // script path
            owner,                               // owner
            year,                                // year
            month,                               // month
            '--format', 'nl',                    // format
            '--replace'                          // replace
        ];

        // Import the module
        const moduleImport = await import(modulePath);

        // If the module doesn't run automatically, manually force it to run
        if (typeof moduleImport.main === 'function') {
            await moduleImport.main();
        } else {
            logger.debug(`No main function found in module ${modulePath}, assuming it self-executes`);
        }

        // Restore original command line arguments
        process.argv = originalArgs;
    } catch (error: any) {
        throw new Error(`Error running module ${modulePath}: ${error.message}`);
    }
}

/**
 * Main function to run the script
 */
async function main(): Promise<void> {
    try {
        // Parse command line arguments
        const args = parseCommandLineArgs(process.argv.slice(2));

        // Get owners from config
        const owners = getOwnersFromConfig();

        // Find all year directories under activity/development
        const yearDirectories = glob.sync('activity/development/[0-9][0-9][0-9][0-9]');

        // Process each year directory
        for (const yearDir of yearDirectories) {
            // Extract year number from directory path
            const yearNum = path.basename(yearDir);

            // Find all month directories (1 or 2 digits)
            const monthDirectories = fs.readdirSync(yearDir)
                .filter(dir => /^\d{1,2}$/.test(dir))
                .map(dir => path.join(yearDir, dir))
                .filter(dir => fs.statSync(dir).isDirectory());

            // Process each month directory
            for (const monthDir of monthDirectories) {
                // Extract month number from directory path
                const monthNum = path.basename(monthDir);

                // Skip if not a valid month number
                const monthInt = parseInt(monthNum);
                if (isNaN(monthInt) || monthInt < 1 || monthInt > 12) {
                    continue;
                }

                // Process each owner
                for (const owner of owners) {
                    try {
                        // Determine which module to run based on type
                        const modulePath = path.resolve(__dirname, `../activity/github-${args.type}.js`);

                        logger.info(`Processing ${args.type} for ${owner} ${yearNum}-${monthNum}`);

                        // Run the appropriate module
                        await runActivityModule(modulePath, owner, yearNum, monthNum);
                    } catch (error: any) {
                        logger.error(`Error processing ${args.type} for ${owner} ${yearNum}-${monthNum}: ${error.message}`);
                        // Continue with the next owner even if there's an error
                    }
                }
            }
        }

        logger.info(`All missing GitHub ${args.type} logs have been generated!`);
    } catch (error: any) {
        logger.error(`Error: ${error.message}`);
        process.exit(1);
    }
}

// Run the main function
main().catch(error => {
    logger.error(`Unhandled error: ${error.message}`);
    process.exit(1);
}); 