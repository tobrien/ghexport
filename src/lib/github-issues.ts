import { getLogger } from '../logging.js';
import { getOctokit, parseCommandLineArgs, processRepositories } from './github.js';

const logger = getLogger();

interface Issue {
    updatedAt: string;
    createdAt: string;
    closedAt: string | null;
    assignee: string,
    operation: string;
    repo: string;
    title: string;
    number: number;
    state: string;
    author: string;
    body: string;
    labels: string[];
    milestone: string;
    state_reason: string;
}

function formatDateTime(date: string | null): string | null {
    if (!date) return null;

    return new Date(date).toLocaleDateString('en-US', {
        month: '2-digit',
        day: '2-digit',
        year: 'numeric',
    }) + ' ' + new Date(date).toLocaleTimeString('en-US', {
        hour: 'numeric',
        minute: '2-digit',
        hour12: true
    });
}

function determineOperation(updatedAt: Date, createdAt: Date, closedAt: Date | null, stateReason: string | null): string {
    // First determine the close operation based on state_reason
    let closeOperation = "Closed";
    if (stateReason === "reopened") {
        closeOperation = "Reopened";
    } else if (stateReason === "completed") {
        closeOperation = "Completed";
    } else if (stateReason === "not_planned") {
        closeOperation = "Ignored";
    }

    // Helper function to check if two dates are in the same month
    const inSameMonth = (date1: Date, date2: Date): boolean => {
        return date1.getFullYear() === date2.getFullYear() &&
            date1.getMonth() === date2.getMonth();
    };

    // If we have a closedAt date
    if (closedAt) {
        // Check if created in the same month as closed
        if (inSameMonth(createdAt, closedAt)) {
            return `Created and ${closeOperation}`;
        }
        return closeOperation;
    }

    // If no closedAt date, check creation and update scenarios
    if (inSameMonth(createdAt, updatedAt)) {
        // If it's a new issue
        if (createdAt.getTime() === updatedAt.getTime()) {
            return "Created";
        }

        // Check if there's at least one day between creation and update
        const daysBetween = (updatedAt.getTime() - createdAt.getTime()) / (1000 * 60 * 60 * 24);
        if (daysBetween >= 1) {
            return "Updated a New Issue";
        }
        return "Created";
    }

    // If createdAt is in a previous month and we have an update
    if (createdAt < updatedAt) {
        return "Updated";
    }

    return "Updated";
}

async function getMonthlyIssueActivity(
    owner: string,
    repo: string,
    year: number,
    month: number
): Promise<Issue[]> {
    const octokit = getOctokit();

    // Create date range for the specified month
    const startDate = new Date(year, month - 1, 1).toISOString();
    const endDate = new Date(year, month, 0).toISOString();

    try {
        const issues = await octokit.issues.listForRepo({
            owner,
            repo,
            since: startDate,
            until: endDate,
            per_page: 100,
            state: 'all'
        });

        return issues.data
            .filter((issue: any) => {
                const updatedAt = new Date(issue.updated_at || '');
                return updatedAt >= new Date(startDate) && updatedAt <= new Date(endDate);
            })
            .sort((a: any, b: any) => {
                const dateA = new Date(a.updated_at || '');
                const dateB = new Date(b.updated_at || '');
                return dateA.getTime() - dateB.getTime();
            })
            .map((issue: any) => {
                const updatedAt = new Date(issue.updated_at || '');
                const createdAt = new Date(issue.created_at || '');
                const closedAt = issue.closed_at ? new Date(issue.closed_at) : null;

                const operation = determineOperation(updatedAt, createdAt, closedAt, issue.state_reason || null);

                return {
                    updatedAt: formatDateTime(issue.updated_at)!,
                    createdAt: formatDateTime(issue.created_at)!,
                    closedAt: formatDateTime(issue.closed_at),
                    operation,
                    assignee: issue.assignee?.login || 'unassigned',
                    repo,
                    title: issue.title,
                    number: issue.number,
                    state: issue.state,
                    author: issue.user?.login || '',
                    body: issue.body || '',
                    labels: issue.labels.map((label: any) => label.name),
                    milestone: issue.milestone?.title || '',
                    state_reason: issue.state_reason || ''
                };
            });
    } catch (error: any) {
        logger.error('Error fetching commits:', error);
        return [];
    }
}

async function generateMonthlyReport(
    owner: string,
    repo: string,
    year: number,
    month: number
): Promise<string | null> {
    const issues = await getMonthlyIssueActivity(owner, repo, year, month);
    const monthName = new Date(year, month - 1).toLocaleString('default', { month: 'long' });

    if (issues.length === 0) {
        logger.debug(`No activity found for ${monthName} ${year}`);
        return null;
    }

    // Get the format from the command line args
    const args = parseCommandLineArgs(process.argv.slice(2));
    const format = args.format;

    let report = `# GitHub Issues in ${repo} owned by ${owner} for ${monthName} ${year}\n\n`;

    if (format === 'csv') {
        // Generate CSV data
        const csvRows = ['UpdateAt, CreatedAt, ClosedAt, Assignee, Owner, Repository, Author, Title, State, Labels, Milestone, Body'];
        issues.forEach(issue => {
            const escapedBody = issue.body.replace(/,/g, ';').replace(/\n/g, ' ');
            const truncatedBody = escapedBody.length > 1024
                ? escapedBody.substring(0, 1021) + '...'
                : escapedBody;
            csvRows.push(`${issue.updatedAt},${issue.createdAt},${issue.closedAt || ''},${issue.assignee},${owner},${issue.repo},${issue.author},${issue.title},${issue.state},"${issue.labels.join(',')}",${issue.milestone},${truncatedBody}`);
        });

        report += `\`\`\`csv\n${csvRows.join('\n')}\`\`\`\n\n`;
    } else {
        // Generate natural language report
        report += `## Summary for ${owner}/${repo} in ${monthName} ${year}\n`;
        report += `Total issues in ${owner}/${repo} for ${monthName} ${year}: ${issues.length}\n\n`;

        // Group issues by state
        const openIssues = issues.filter(issue => issue.state === 'open');
        const closedIssues = issues.filter(issue => issue.state === 'closed');

        report += `- Open issues: ${openIssues.length}\n`;
        report += `- Closed issues: ${closedIssues.length}\n\n`;

        report += `## Detailed Issues\n\n`;
        issues.forEach(issue => {
            report += `### Issue #${issue.number} was ${issue.operation} on ${issue.updatedAt} in repository ${owner}/${repo} with title "${issue.title}"\n`;
            if (issue.createdAt !== issue.updatedAt) {
                report += `- **Created on:** ${issue.createdAt}\n`;
            }
            if (issue.closedAt) {
                report += `- **Closed on:** ${issue.closedAt}\n`;
            }
            report += `- **Author:** ${issue.author}\n`;
            report += `- **Assignee:** ${issue.assignee}\n`;
            report += `- **State:** ${issue.state}\n`;
            if (issue.labels.length > 0) {
                report += `- **Labels:** ${issue.labels.join(', ')}\n`;
            }
            if (issue.milestone) {
                report += `- **Milestone:** ${issue.milestone}\n`;
            }
            if (issue.body) {
                const truncatedBody = issue.body.length > 500
                    ? issue.body.substring(0, 497) + '...'
                    : issue.body;
                report += `- **Description:**\n  ${truncatedBody.replace(/\n/g, '\n  ')}\n`;
            }
            report += '\n';
        });
    }

    return report;
}

async function main(): Promise<void> {
    try {
        const args = parseCommandLineArgs(process.argv.slice(2));
        await processRepositories(args, 'issues', generateMonthlyReport);
    } catch (error: any) {
        logger.error(error);
        process.exit(1);
    }
}

main().catch((error) => logger.error(error)); 