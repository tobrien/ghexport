import { Octokit } from '@octokit/rest';
import dotenv from 'dotenv';
import { configure } from '../config.js';
import { mkdir } from 'fs/promises';
import { dirname } from 'path';
import { writeFile } from 'fs/promises';
import { join } from 'path';
import { loadActivityConfig, shouldGenerateActivity, getGithubToken } from './config.js';
import { existsSync } from 'fs';
import { getLogger } from '../logging.js';

dotenv.config();
const config = configure();

const logger = getLogger();

// Initialize Octokit with default token (will be replaced per owner)
let octokit = new Octokit({
    auth: process.env.GITHUB_TOKEN
});

export interface CommandLineArgs {
    owner: string;
    year: number;
    month: number;
    omitRepo?: string;
    shouldReplace: boolean;
    format: 'csv' | 'nl';  // 'nl' for natural language
}

export interface ActivityReport {
    content: string;
    hasData: boolean;
}

export function parseCommandLineArgs(args: string[]): CommandLineArgs {
    let omitRepo: string | undefined;
    const shouldReplace = args.includes('--replace');
    let format: 'csv' | 'nl' = 'nl';  // default to natural language

    // Parse arguments
    const parsedArgs = [];
    for (let i = 0; i < args.length; i++) {
        if (args[i] === '--omit' && i + 1 < args.length) {
            omitRepo = args[i + 1];
            i++; // Skip the next argument since we consumed it
        } else if (args[i] === '--format' && i + 1 < args.length) {
            const formatArg = args[i + 1].toLowerCase();
            if (formatArg !== 'csv' && formatArg !== 'nl') {
                throw new Error('Format must be either "csv" or "nl"');
            }
            format = formatArg as 'csv' | 'nl';
            i++; // Skip the next argument since we consumed it
        } else if (args[i] !== '--replace') {
            parsedArgs.push(args[i]);
        }
    }

    if (parsedArgs.length !== 3) {
        throw new Error('Usage: <script> <owner> <year> <month> [--omit repo-name] [--format csv|nl] [--replace]');
    }

    const [owner] = parsedArgs;
    const yearStr = parsedArgs[1];
    const monthStr = parsedArgs[2];
    const year = parseInt(yearStr);
    const month = parseInt(monthStr);

    // Validate inputs
    if (isNaN(year) || isNaN(month) || month < 1 || month > 12) {
        throw new Error(`Invalid year or month. Month should be between 1 and 12. Supplied year: ${yearStr} month: ${monthStr}`);
    }

    return { owner, year, month, omitRepo, shouldReplace, format };
}

export async function initializeGithubClient(owner: string, activityType: 'commits' | 'issues'): Promise<{ authenticatedOwner: string }> {
    // Load activity configuration
    const activityConfig = await loadActivityConfig(join(config.configDirectory, 'activity.yaml'));

    // Get owner configuration and token
    // TODO: This should be dynamic based on the owner
    const ownerConfig = activityConfig.github[activityType][owner === 'self' ? 'tobrien' : owner];
    if (!ownerConfig) {
        throw new Error(`Owner ${owner} not found in activity configuration`);
    }

    // Update Octokit instance with owner-specific token
    octokit = new Octokit({
        auth: getGithubToken(ownerConfig)
    });

    // Get authenticated user
    const user = await octokit.users.getAuthenticated();
    return { authenticatedOwner: user.data.login };
}

export async function processRepositories(
    args: CommandLineArgs,
    activityType: 'commits' | 'issues',
    generateReport: (owner: string, repo: string, year: number, month: number) => Promise<string | null>
): Promise<void> {
    const { year, month, omitRepo } = args;
    const owner = args.owner;

    // Initialize GitHub client and get authenticated owner
    const { authenticatedOwner } = await initializeGithubClient(owner, activityType);

    // Load activity configuration
    const activityConfig = await loadActivityConfig(join(config.configDirectory, 'activity.yaml'));

    // Get repositories for authenticated user
    const repos = await octokit.repos.listForAuthenticatedUser();

    for (const repo of repos.data) {
        const outputPath = join(
            config.activityDirectory,
            "development",
            year.toString(),
            month.toString(),
            `${authenticatedOwner}-${repo.name}-github-${activityType}.md`
        );

        // Check if file already exists and handle replace flag
        if (existsSync(outputPath)) {
            if (!args.shouldReplace) {
                logger.warn(`Skipping existing file ${outputPath}. Use --replace to overwrite.`);
                continue;
            }
            logger.info(`Replacing existing file ${outputPath} as requested by --replace flag`);
        }

        // Skip repository if it matches the omitted name
        if (omitRepo && repo.name === omitRepo) {
            logger.debug(`Skipping repository ${authenticatedOwner}/${repo.name} as requested by --omit flag`);
            continue;
        }

        // Check if we should generate activity for this repository based on configuration
        if (!shouldGenerateActivity(activityConfig, authenticatedOwner, repo.name, year, month, activityType)) {
            logger.debug(`Skipping repository ${authenticatedOwner}/${repo.name} based on activity configuration`);
            continue;
        }

        logger.info(`Generating monthly report for ${authenticatedOwner}/${repo.name} in ${year}-${month}`);

        const report = await generateReport(authenticatedOwner, repo.name, year, month);

        if (report) {
            await mkdir(dirname(outputPath), { recursive: true });
            logger.info(`Writing report to ${outputPath}`);
            await writeFile(outputPath, report);
        }

    }
}

export function getOctokit(): Octokit {
    return octokit;
}

export { logger, config }; 