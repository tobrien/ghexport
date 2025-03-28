import { getOctokit, parseCommandLineArgs, processRepositories, logger } from './github.js';

interface Commit {
    url: string;
    date: string;
    repo: string;
    message: string;
    author: string;
    additions: number;
    deletions: number;
    files: string[];
}

async function getMonthlyCommitActivity(
    owner: string,
    repo: string,
    year: number,
    month: number
): Promise<Commit[]> {
    const octokit = getOctokit();

    // Create date range for the specified month
    const startDate = new Date(year, month - 1, 1).toISOString();
    const endDate = new Date(year, month, 0).toISOString();

    try {
        // TODO: Need to support pagination here.
        // Fetch all commits with pagination
        const allCommits = [];
        let page = 1;
        let hasNextPage = true;

        while (hasNextPage) {
            const response = await octokit.repos.listCommits({
                owner,
                repo,
                since: startDate,
                until: endDate,
                per_page: 100,
                page: page
            });

            allCommits.push(...response.data);

            // Check if there are more pages
            if (response.data.length < 100) {
                hasNextPage = false;
            } else {
                page++;
            }
        }

        // Process each commit to get detailed information
        const processedCommits: Commit[] = [];

        for (const commit of allCommits) {
            try {
                const commitDetail = await octokit.repos.getCommit({
                    owner,
                    repo,
                    ref: commit.sha
                });

                processedCommits.push({
                    url: commitDetail.data.html_url,
                    date: new Date(commitDetail.data.commit.author?.date || 0).toLocaleDateString('en-US', {
                        month: '2-digit',
                        day: '2-digit',
                        year: 'numeric',
                    }) + ' ' + new Date(commitDetail.data.commit.author?.date || 0).toLocaleTimeString('en-US', {
                        hour: 'numeric',
                        minute: '2-digit',
                        hour12: true
                    }),
                    repo,
                    message: commitDetail.data.commit.message,
                    author: commitDetail.data.commit.author?.name || '',
                    additions: commitDetail.data.stats?.additions || 0,
                    deletions: commitDetail.data.stats?.deletions || 0,
                    files: commitDetail.data.files?.map((file: any) => file.filename) || []
                });
            } catch (error: any) {
                logger.error(`Error fetching details for commit ${commit.sha}, skipping... ${error.message}`);
            }
        }

        // Sort commits by date
        processedCommits.sort((a, b) => {
            const dateA = new Date(a.date);
            const dateB = new Date(b.date);
            return dateA.getTime() - dateB.getTime();
        });

        return processedCommits;
    } catch (error: any) {
        logger.error(`Error fetching commits: ${error.message}`);
        return [];
    }
}

async function generateMonthlyReport(
    owner: string,
    repo: string,
    year: number,
    month: number
): Promise<string | null> {
    const commits = await getMonthlyCommitActivity(owner, repo, year, month);
    const monthName = new Date(year, month - 1).toLocaleString('default', { month: 'long' });

    if (commits.length === 0) {
        logger.debug(`No activity found for ${monthName} ${year}`);
        return null;
    }

    // Get the format from the command line args
    const args = parseCommandLineArgs(process.argv.slice(2));
    const format = args.format;

    let report = `# GitHub Commits in ${repo} owned by ${owner} for ${monthName} ${year}\n\n`;

    if (format === 'csv') {
        // Generate CSV data
        const csvRows = ['Date,Owner,Repository,Author,Additions,Deletions,Files,Message'];
        commits.forEach(commit => {
            // Escape any commas in the message
            const escapedMessage = commit.message.replace(/,/g, ';').replace(/\n/g, ' ');
            const truncatedMessage = escapedMessage.length > 1024
                ? escapedMessage.substring(0, 1021) + '...'
                : escapedMessage;

            // Truncate the list of files to 50 if it's longer
            const truncatedFiles = commit.files.length > 50
                ? [...commit.files.slice(0, 49), `...and ${commit.files.length - 49} more files`]
                : commit.files;

            csvRows.push(`${commit.date},${owner},${commit.repo},${commit.author},${commit.additions},${commit.deletions},"${truncatedFiles.join(',')}",${truncatedMessage}`);
        });

        report += `\`\`\`csv\n${csvRows.join('\n')}\`\`\`\n\n`;
    } else {
        // Generate natural language report
        report += `## Summary for ${owner}/${repo} in ${monthName} ${year}\n`;
        report += `Total commits in ${owner}/${repo} for ${monthName} ${year}: ${commits.length}\n`;
        const totalAdditions = commits.reduce((sum, commit) => sum + commit.additions, 0);
        const totalDeletions = commits.reduce((sum, commit) => sum + commit.deletions, 0);
        report += `Total lines changed in ${owner}/${repo} for ${monthName} ${year}: +${totalAdditions} -${totalDeletions}\n\n`;

        report += `## Detailed Commits\n\n`;
        commits.forEach(commit => {
            report += `### Commit on ${commit.date} in repository ${owner}/${repo} by ${commit.author}\n`;
            report += `- **Message:** ${commit.message}\n`;
            report += `- **Changes:** +${commit.additions} -${commit.deletions}\n`;
            if (commit.files.length > 0) {
                report += `- **Files Changed:**\n`;
                const filesToShow = commit.files.length > 10 ? commit.files.slice(0, 10) : commit.files;
                filesToShow.forEach(file => {
                    report += `  - ${file}\n`;
                });
                if (commit.files.length > 10) {
                    report += `  - ...and ${commit.files.length - 10} more files\n`;
                }
            }
            report += `- **URL:** ${commit.url}\n\n`;
        });
    }

    return report;
}

async function main(): Promise<void> {
    try {
        const args = parseCommandLineArgs(process.argv.slice(2));
        await processRepositories(args, 'commits', generateMonthlyReport);
    } catch (error: any) {
        logger.error(error);
        process.exit(1);
    }
}

main().catch((error) => logger.error(error)); 